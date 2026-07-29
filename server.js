'use strict';

require('dotenv').config();
const path       = require('path');
const express    = require('express');
const session    = require('express-session');
const PgSession  = require('connect-pg-simple')(session);
const bcrypt     = require('bcryptjs');
const { db, pool, ready } = require('./db/database');
const { authorize } = require('./engine');

const app  = express();
const PORT = process.env.PORT || 3000;

// Vercel / reverse-proxy: trust the first hop so secure cookies work over HTTPS
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

// ─── Sessions ────────────────────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'mobilpymes-eps-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
  },
}));

// ─── Locals ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

const MENUS = ['File','Edit','Configure','System Operations','Customer Management','View','Window','Help'];

function render(res, view, opts = {}) {
  res.render(view, Object.assign({ menus: MENUS, active: '', title: '' }, opts));
}

// ─── Middleware ───────────────────────────────────────────────────────────────
async function dbReady(_req, _res, next) { await ready; next(); }

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') {
    return res.status(403).send('Acceso denegado — se requiere rol administrador.');
  }
  next();
}

app.use(dbReady);

// ─── Login / Logout ───────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, username: '' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await db.get(
      'SELECT * FROM users WHERE username=$1', [username?.trim()]);
    if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
      return res.render('login', {
        error: 'Usuario o contraseña incorrectos, o cuenta desactivada.',
        username: username,
      });
    }
    await db.run('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
    req.session.user = { id: user.id, username: user.username, email: user.email, role: user.role };
    req.session.save((err) => {
      if (err) return res.render('login', { error: 'Error de sesión: ' + err.message, username });
      res.redirect('/');
    });
  } catch (err) {
    res.render('login', { error: err.message, username });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ─── All routes below require authentication ──────────────────────────────────
app.use(requireAuth);

// ─── Desktop ─────────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const [inst, hosts, prefixes, routing, journal, limits, cards] = await Promise.all([
      db.get('SELECT COUNT(*) AS n FROM institutions'),
      db.get('SELECT COUNT(*) AS n FROM hosts'),
      db.get('SELECT COUNT(*) AS n FROM prefixes'),
      db.get('SELECT COUNT(*) AS n FROM routing_profiles'),
      db.get('SELECT COUNT(*) AS n FROM journal'),
      db.get('SELECT COUNT(*) AS n FROM limit_profiles'),
      db.get('SELECT COUNT(*) AS n FROM cards'),
    ]);
    const counts = {
      institutions: Number(inst.n), hosts: Number(hosts.n),
      prefixes: Number(prefixes.n), routing: Number(routing.n),
      journal: Number(journal.n), limits: Number(limits.n),
      cards: Number(cards.n),
    };
    render(res, 'desktop', { active: '', title: 'EPS Development - ESNCService', counts });
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Institution ─────────────────────────────────────────────────────────────
app.get('/institution', async (req, res) => {
  try {
    const list = await db.all('SELECT * FROM institutions ORDER BY institution_id');
    const sel  = req.query.id
      ? await db.get('SELECT * FROM institutions WHERE institution_id=$1', [req.query.id])
      : list[0];
    const contacts = sel
      ? await db.all('SELECT * FROM contacts WHERE institution_ref=$1', [sel.id])
      : [];
    const routingProfiles = (await db.all('SELECT name FROM routing_profiles ORDER BY name'))
      .map((r) => r.name);
    render(res, 'institution', { active: 'Institution', title: 'Institution Configuration',
      list, sel, contacts, routingProfiles, tab: req.query.tab || 'address' });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/institution', async (req, res) => {
  try {
    const b = req.body;
    const exists = await db.get('SELECT id FROM institutions WHERE institution_id=$1', [b.institution_id]);
    const msg = `2 - Successful save of Institution ID ${b.institution_id}.`;
    const vals = [b.institution_number, b.institution_name, b.issuer_type||'Institution',
      b.addr_line1, b.addr_line2, b.city, b.country,
      b.postal_code, b.state_province,
      b.timezone||'UTC', b.currency_code||'840',
      b.destination_routing_profile||null, b.cutover_time||'12:00 am', msg];
    if (exists) {
      await db.run(`UPDATE institutions SET institution_number=$1, institution_name=$2,
        issuer_type=$3, addr_line1=$4, addr_line2=$5, city=$6, country=$7,
        postal_code=$8, state_province=$9, timezone=$10, currency_code=$11,
        destination_routing_profile=$12, cutover_time=$13, status_msg=$14
        WHERE institution_id=$15`,
        [...vals, b.institution_id]);
    } else {
      await db.run(`INSERT INTO institutions (institution_id, institution_number, institution_name,
        issuer_type, addr_line1, addr_line2, city, country, postal_code, state_province,
        timezone, currency_code, destination_routing_profile, cutover_time, status_msg)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [b.institution_id, ...vals]);
    }
    res.redirect('/institution?id=' + encodeURIComponent(b.institution_id));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/institution/contact/add', async (req, res) => {
  try {
    const b = req.body;
    const inst = await db.get('SELECT id FROM institutions WHERE institution_id=$1', [b.institution_id]);
    if (inst) {
      await db.run(
        'INSERT INTO contacts (institution_ref, contact, phone, email, comments) VALUES ($1,$2,$3,$4,$5)',
        [inst.id, b.contact, b.phone, b.email, b.comments]);
    }
    res.redirect('/institution?id=' + encodeURIComponent(b.institution_id) + '&tab=address');
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/institution/contact/delete', async (req, res) => {
  try {
    const c = await db.get('SELECT institution_ref FROM contacts WHERE id=$1', [req.body.contact_id]);
    await db.run('DELETE FROM contacts WHERE id=$1', [req.body.contact_id]);
    const inst = c ? await db.get('SELECT institution_id FROM institutions WHERE id=$1', [c.institution_ref]) : null;
    res.redirect('/institution' + (inst ? '?id=' + encodeURIComponent(inst.institution_id) : ''));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/institution/delete', async (req, res) => {
  try {
    await db.run('DELETE FROM institutions WHERE institution_id=$1', [req.body.institution_id]);
    res.redirect('/institution');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Host ────────────────────────────────────────────────────────────────────
app.get('/host', async (req, res) => {
  try {
    const list     = await db.all('SELECT * FROM hosts ORDER BY interface_name');
    const sel      = req.query.name
      ? await db.get('SELECT * FROM hosts WHERE interface_name=$1', [req.query.name])
      : list[0];
    const profiles = (await db.all('SELECT name FROM routing_profiles')).map((r) => r.name);
    render(res, 'host', { active: 'Host/Interchange', title: 'ISO Interface Configuration',
      list, sel, profiles, tab: req.query.tab || 'processing' });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/host', async (req, res) => {
  try {
    const b = req.body;
    const exists = await db.get('SELECT id FROM hosts WHERE interface_name=$1', [b.interface_name]);
    const vals = [b.kind||'Interchange', b.cutover_time, b.time_offset,
      Number(b.statistics_interval||0), b.settlement_days, b.source_routing_profile,
      b.acquirer_txn_profile, b.issuer_txn_profile, b.context_profile,
      b.iso_message_profile, b.action_code_profile, b.acquirer_surcharge_profile,
      b.currency_conversion_fee_profile];
    if (exists) {
      await db.run(`UPDATE hosts SET kind=$1, cutover_time=$2, time_offset=$3,
        statistics_interval=$4, settlement_days=$5, source_routing_profile=$6,
        acquirer_txn_profile=$7, issuer_txn_profile=$8, context_profile=$9,
        iso_message_profile=$10, action_code_profile=$11, acquirer_surcharge_profile=$12,
        currency_conversion_fee_profile=$13 WHERE interface_name=$14`,
        [...vals, b.interface_name]);
    } else {
      await db.run(`INSERT INTO hosts (interface_name, kind, cutover_time, time_offset,
        statistics_interval, settlement_days, source_routing_profile, acquirer_txn_profile,
        issuer_txn_profile, context_profile, iso_message_profile, action_code_profile,
        acquirer_surcharge_profile, currency_conversion_fee_profile)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [b.interface_name, ...vals]);
    }
    res.redirect('/host?name=' + encodeURIComponent(b.interface_name));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/host/delete', async (req, res) => {
  try {
    await db.run('DELETE FROM hosts WHERE interface_name=$1', [req.body.interface_name]);
    res.redirect('/host');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Prefix ──────────────────────────────────────────────────────────────────
app.get('/prefix', async (req, res) => {
  try {
    const list    = await db.all('SELECT * FROM prefixes ORDER BY prefix');
    const sel     = req.query.id
      ? await db.get('SELECT * FROM prefixes WHERE id=$1', [req.query.id])
      : list[0];
    const issuers = await db.all(
      'SELECT institution_id, institution_name FROM institutions ORDER BY institution_id');
    const hosts   = (await db.all('SELECT interface_name FROM hosts ORDER BY interface_name'))
      .map((h) => h.interface_name);
    render(res, 'prefix', { active: 'Prefix', title: 'Prefix Configuration',
      list, sel, issuers, hosts, tab: req.query.tab || 'processing' });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/prefix', async (req, res) => {
  try {
    const b = req.body;
    const vals = [b.prefix, Number(b.pan_length||16), b.issuer_id, b.prefix_type, b.route_type,
                  b.destination_routing_profile||null,
                  b.member_number_on_track?1:0, b.include_holds?1:0,
                  b.expiration_check_option, b.fraud_option, Number(b.max_pin_retry||3)];
    if (b.id) {
      await db.run(`UPDATE prefixes SET prefix=$1, pan_length=$2, issuer_id=$3, prefix_type=$4,
        route_type=$5, destination_routing_profile=$6, member_number_on_track=$7, include_holds=$8,
        expiration_check_option=$9, fraud_option=$10, max_pin_retry=$11 WHERE id=$12`,
        [...vals, b.id]);
      res.redirect('/prefix?id=' + b.id);
    } else {
      const row = await db.run(`INSERT INTO prefixes (prefix, pan_length, issuer_id, prefix_type,
        route_type, destination_routing_profile, member_number_on_track, include_holds,
        expiration_check_option, fraud_option, max_pin_retry)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, vals);
      res.redirect('/prefix?id=' + row.id);
    }
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/prefix/delete', async (req, res) => {
  try {
    await db.run('DELETE FROM prefixes WHERE id=$1', [req.body.id]);
    res.redirect('/prefix');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Routing ─────────────────────────────────────────────────────────────────
app.get('/routing', async (req, res) => {
  try {
    const list    = await db.all('SELECT * FROM routing_profiles ORDER BY name');
    const sel     = req.query.id
      ? await db.get('SELECT * FROM routing_profiles WHERE id=$1', [req.query.id])
      : list[0];
    const dests   = sel
      ? await db.all('SELECT * FROM routing_destinations WHERE profile_ref=$1 ORDER BY seq', [sel.id])
      : [];
    const hosts   = (await db.all('SELECT interface_name FROM hosts ORDER BY interface_name'))
      .map((h) => h.interface_name);
    const limits  = (await db.all('SELECT name FROM limit_profiles ORDER BY name'))
      .map((l) => l.name);
    const issuers = (await db.all('SELECT institution_id FROM institutions ORDER BY institution_id'))
      .map((i) => i.institution_id);
    render(res, 'routing', { active: 'Routing', title: 'Source Routing Profile',
      list, sel, dests, hosts, limits, issuers });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing', async (req, res) => {
  try {
    const b = req.body;
    let profileId = b.id;
    if (profileId) {
      await db.run('UPDATE routing_profiles SET name=$1, description=$2 WHERE id=$3',
        [b.name, b.description, profileId]);
    } else {
      const row = await db.run(
        'INSERT INTO routing_profiles (name,description) VALUES ($1,$2) RETURNING id',
        [b.name, b.description]);
      profileId = row.id;
    }
    res.redirect('/routing?id=' + profileId);
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/destination', async (req, res) => {
  try {
    const b = req.body;
    const row = await db.get(
      'SELECT COALESCE(MAX(seq),0) AS m FROM routing_destinations WHERE profile_ref=$1', [b.profile_ref]);
    await db.run(`INSERT INTO routing_destinations (profile_ref,seq,destination_routing_profile,
      issuer_id,txn_code,limit_profile,issuer_surcharge_profile,instrument_type,route_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [b.profile_ref, Number(row.m)+1, b.destination_routing_profile, b.issuer_id||null,
       b.txn_code||'Any', b.limit_profile, b.issuer_surcharge_profile||null,
       b.instrument_type, b.route_type]);
    res.redirect('/routing?id=' + b.profile_ref);
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/destination/delete', async (req, res) => {
  try {
    const d = await db.get('SELECT profile_ref FROM routing_destinations WHERE id=$1', [req.body.id]);
    await db.run('DELETE FROM routing_destinations WHERE id=$1', [req.body.id]);
    res.redirect('/routing?id=' + (d ? d.profile_ref : ''));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/delete', async (req, res) => {
  try {
    await db.run('DELETE FROM routing_profiles WHERE id=$1', [req.body.id]);
    res.redirect('/routing');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Destination Routing Profile ─────────────────────────────────────────────
app.get('/routing/dest-profile', async (req, res) => {
  try {
    const list = await db.all('SELECT * FROM destination_routing_profiles ORDER BY name');
    const sel  = req.query.id
      ? await db.get('SELECT * FROM destination_routing_profiles WHERE id=$1', [req.query.id])
      : list[0];
    render(res, 'routing-dest-profile', { active: 'Destination Routing Profile',
      title: 'Destination Routing Profile Configuration', list, sel });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/dest-profile', async (req, res) => {
  try {
    const b = req.body;
    let profileId = b.id;
    if (profileId) {
      await db.run('UPDATE destination_routing_profiles SET name=$1, description=$2 WHERE id=$3',
        [b.name, b.description || '', profileId]);
    } else {
      const row = await db.run(
        'INSERT INTO destination_routing_profiles (name,description) VALUES ($1,$2) RETURNING id',
        [b.name, b.description || '']);
      profileId = row.id;
    }
    res.redirect('/routing/dest-profile?id=' + profileId);
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/dest-profile/general', async (req, res) => {
  try {
    const b = req.body;
    await db.run(`UPDATE destination_routing_profiles SET
      dest_route_floor_limit=$1, txn_auditing_ind=$2, alt_floor_limit_algo=$3,
      alt_floor_limit_check=$4, floor_limit=$5, over_limit_action=$6, under_limit_action=$7
      WHERE id=$8`,
      [Number(b.dest_route_floor_limit || 0), b.txn_auditing_ind === '1',
       b.alt_floor_limit_algo || '', b.alt_floor_limit_check === '1',
       Number(b.floor_limit || 0), b.over_limit_action || 'Decline',
       b.under_limit_action || 'Decline', b.id]);
    res.redirect('/routing/dest-profile?id=' + b.id);
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/dest-profile/delete', async (req, res) => {
  try {
    await db.run('DELETE FROM destination_routing_profiles WHERE id=$1', [req.body.id]);
    res.redirect('/routing/dest-profile');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Routing Configuration - Destination ─────────────────────────────────────
app.get('/routing/destination-config', async (req, res) => {
  try {
    const drpList = await db.all('SELECT * FROM destination_routing_profiles ORDER BY name');
    const sel     = req.query.id
      ? await db.get('SELECT * FROM destination_routing_profiles WHERE id=$1', [req.query.id])
      : drpList[0];
    const rows    = sel
      ? await db.all('SELECT * FROM routing_config_dest WHERE profile_ref=$1 ORDER BY id', [sel.id])
      : [];
    render(res, 'routing-destination-config', { active: 'Routing Config Destination',
      title: 'Routing Configuration - Destination', drpList, sel, rows,
      tab: req.query.tab || 'general' });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/destination-config/row', async (req, res) => {
  try {
    const b = req.body;
    await db.run(`INSERT INTO routing_config_dest
      (profile_ref,route_code,account_type_1,account_type_2,cust_auth_method)
      VALUES ($1,$2,$3,$4,$5)`,
      [b.profile_ref, b.route_code, b.account_type_1 || 'Savings',
       b.account_type_2 || 'Checking', b.cust_auth_method || 'PIN']);
    res.redirect('/routing/destination-config?id=' + b.profile_ref);
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/destination-config/row/delete', async (req, res) => {
  try {
    const r = await db.get('SELECT profile_ref FROM routing_config_dest WHERE id=$1', [req.body.id]);
    await db.run('DELETE FROM routing_config_dest WHERE id=$1', [req.body.id]);
    res.redirect('/routing/destination-config?id=' + (r ? r.profile_ref : ''));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/destination-config/general', async (req, res) => {
  try {
    const b = req.body;
    await db.run(`UPDATE destination_routing_profiles SET
      dest_route_floor_limit=$1, txn_auditing_ind=$2, alt_floor_limit_algo=$3,
      alt_floor_limit_check=$4, floor_limit=$5, over_limit_action=$6, under_limit_action=$7
      WHERE id=$8`,
      [Number(b.dest_route_floor_limit || 0), b.txn_auditing_ind === '1',
       b.alt_floor_limit_algo || '', b.alt_floor_limit_check === '1',
       Number(b.floor_limit || 0), b.over_limit_action || 'Decline',
       b.under_limit_action || 'Decline', b.id]);
    res.redirect('/routing/destination-config?id=' + b.id + '&tab=general');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Destination/Source Relationship ─────────────────────────────────────────
app.get('/routing/dest-src', async (req, res) => {
  try {
    const drpList = await db.all('SELECT * FROM destination_routing_profiles ORDER BY name');
    const srpList = await db.all('SELECT * FROM routing_profiles ORDER BY name');
    const selDrp  = req.query.drp || (drpList[0] ? drpList[0].name : '');
    const selSrp  = req.query.srp || 'ANY';
    let rows = [];
    if (selDrp) {
      rows = selSrp !== 'ANY'
        ? await db.all(
            'SELECT * FROM dest_src_relationships WHERE dest_routing_profile=$1 AND src_routing_profile=$2 ORDER BY id',
            [selDrp, selSrp])
        : await db.all(
            'SELECT * FROM dest_src_relationships WHERE dest_routing_profile=$1 ORDER BY id',
            [selDrp]);
    }
    render(res, 'routing-dest-src', { active: 'Dest/Src Relationship',
      title: 'Routing Configuration - Destination/Source Relationship',
      drpList, srpList, selDrp, selSrp, rows });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/dest-src', async (req, res) => {
  try {
    const b = req.body;
    await db.run(`INSERT INTO dest_src_relationships
      (dest_routing_profile,src_routing_profile,txn_code,route_code)
      VALUES ($1,$2,$3,$4)`,
      [b.dest_routing_profile, b.src_routing_profile, b.txn_code || '**', b.route_code || '']);
    res.redirect('/routing/dest-src?drp=' + encodeURIComponent(b.dest_routing_profile)
      + '&srp=' + encodeURIComponent(b.src_routing_profile));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/routing/dest-src/delete', async (req, res) => {
  try {
    const r = await db.get(
      'SELECT dest_routing_profile,src_routing_profile FROM dest_src_relationships WHERE id=$1',
      [req.body.id]);
    await db.run('DELETE FROM dest_src_relationships WHERE id=$1', [req.body.id]);
    res.redirect('/routing/dest-src'
      + (r ? '?drp=' + encodeURIComponent(r.dest_routing_profile)
           + '&srp=' + encodeURIComponent(r.src_routing_profile) : ''));
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Limit Profiles ───────────────────────────────────────────────────────────
app.get('/limit', async (req, res) => {
  try {
    const list = await db.all('SELECT * FROM limit_profiles ORDER BY name');
    const sel  = req.query.id
      ? await db.get('SELECT * FROM limit_profiles WHERE id=$1', [req.query.id])
      : list[0];
    render(res, 'limit', { active: 'Limit Profiles', title: 'Limit Profile Configuration',
      list, sel, msg: req.query.msg||null });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/limit', async (req, res) => {
  try {
    const b = req.body;
    const vals = [b.name, b.description||null, b.currency_code||'USD',
      Number(b.min_amount||0), Number(b.max_amount_per_txn||1000000),
      Number(b.daily_amount_limit||1000000), Number(b.daily_count_limit||9999),
      b.period_type||'Rolling Daily'];
    if (b.id) {
      await db.run(`UPDATE limit_profiles SET name=$1, description=$2, currency_code=$3,
        min_amount=$4, max_amount_per_txn=$5, daily_amount_limit=$6,
        daily_count_limit=$7, period_type=$8 WHERE id=$9`,
        [...vals, b.id]);
      res.redirect('/limit?id=' + b.id + '&msg=Saved');
    } else {
      const row = await db.run(`INSERT INTO limit_profiles
        (name,description,currency_code,min_amount,max_amount_per_txn,daily_amount_limit,daily_count_limit,period_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, vals);
      res.redirect('/limit?id=' + row.id + '&msg=Created');
    }
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/limit/delete', async (req, res) => {
  try {
    await db.run('DELETE FROM limit_profiles WHERE id=$1', [req.body.id]);
    res.redirect('/limit');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Cards / Customer Management ─────────────────────────────────────────────
app.get('/cards', async (req, res) => {
  try {
    const list    = await db.all('SELECT * FROM cards ORDER BY pan');
    const sel     = req.query.pan
      ? await db.get('SELECT * FROM cards WHERE pan=$1', [req.query.pan])
      : list[0];
    const accounts = sel
      ? await db.all('SELECT * FROM accounts WHERE card_pan=$1 ORDER BY account_type', [sel.pan])
      : [];
    const issuers = await db.all(
      'SELECT institution_id, institution_name FROM institutions ORDER BY institution_id');
    const limits  = (await db.all('SELECT name FROM limit_profiles ORDER BY name'))
      .map((l) => l.name);
    render(res, 'cards', { active: 'Cards', title: 'Card Configuration',
      list, sel, accounts, issuers, limits,
      msg: req.query.msg||null, error: req.query.error||null });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/cards', async (req, res) => {
  try {
    const b = req.body;
    if (!b.pan || b.pan.replace(/\D/g, '').length < 12) {
      return res.redirect('/cards?error=' + encodeURIComponent('PAN inválido (mínimo 12 dígitos).'));
    }
    const pan = b.pan.replace(/\D/g, '');
    const vals = [pan, b.cardholder_name||null, b.expiry_date||null,
      b.card_type||'Debit', b.status||'Active', b.issuer_id||null,
      b.limit_profile||'LMT_STD', b.account_type1||'Savings', b.account_type2||'Checking'];
    const exists = await db.get('SELECT id FROM cards WHERE pan=$1', [pan]);
    if (exists) {
      await db.run(`UPDATE cards SET cardholder_name=$2, expiry_date=$3, card_type=$4,
        status=$5, issuer_id=$6, limit_profile=$7, account_type1=$8, account_type2=$9
        WHERE pan=$1`, vals);
      if (b.status === 'Active') {
        await db.run('UPDATE cards SET pin_retries=0 WHERE pan=$1', [pan]);
      }
    } else {
      await db.run(`INSERT INTO cards (pan, cardholder_name, expiry_date, card_type, status,
        issuer_id, limit_profile, account_type1, account_type2) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        vals);
    }
    res.redirect('/cards?pan=' + encodeURIComponent(pan) + '&msg=' + encodeURIComponent('Card saved.'));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/cards/account', async (req, res) => {
  try {
    const b = req.body;
    const exists = await db.get('SELECT id FROM accounts WHERE account_id=$1', [b.account_id]);
    const vals = [b.account_id, b.card_pan, b.account_type||'Savings',
      b.status||'Active', Number(b.available_bal||0), Number(b.ledger_bal||0),
      b.currency_code||'USD', b.limit_profile||null];
    if (exists) {
      await db.run(`UPDATE accounts SET account_type=$3, status=$4, available_bal=$5,
        ledger_bal=$6, currency_code=$7, limit_profile=$8 WHERE account_id=$1`, vals);
    } else {
      await db.run(`INSERT INTO accounts (account_id, card_pan, account_type, status,
        available_bal, ledger_bal, currency_code, limit_profile)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, vals);
    }
    res.redirect('/cards?pan=' + encodeURIComponent(b.card_pan) + '&msg=' + encodeURIComponent('Account saved.'));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/cards/account/delete', async (req, res) => {
  try {
    const acct = await db.get('SELECT card_pan FROM accounts WHERE id=$1', [req.body.id]);
    await db.run('DELETE FROM accounts WHERE id=$1', [req.body.id]);
    res.redirect('/cards?pan=' + encodeURIComponent(acct ? acct.card_pan : ''));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/cards/delete', async (req, res) => {
  try {
    await db.run('DELETE FROM cards WHERE pan=$1', [req.body.pan]);
    res.redirect('/cards');
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/cards/unblock', async (req, res) => {
  try {
    await db.run(`UPDATE cards SET status='Active', pin_retries=0 WHERE pan=$1`, [req.body.pan]);
    res.redirect('/cards?pan=' + encodeURIComponent(req.body.pan) + '&msg=' + encodeURIComponent('Card unblocked.'));
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Simulator ───────────────────────────────────────────────────────────────
app.get('/simulator', async (req, res) => {
  try {
    const [journal, prefixes] = await Promise.all([
      db.all('SELECT * FROM journal ORDER BY id DESC LIMIT 50'),
      db.all('SELECT * FROM prefixes ORDER BY prefix'),
    ]);
    render(res, 'simulator', { active: 'System Operations', title: 'Transaction Simulator',
      journal, prefixes, result: null,
      form: { pan: '1601070000001234', amount: '120.00', txn_type: 'Withdrawal', source: 'ATM' } });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/simulator', async (req, res) => {
  try {
    const b = req.body;
    const result = await authorize({
      pan: b.pan, amount: Number(b.amount),
      txn_type: b.txn_type, source: b.source,
      wrong_pin: b.wrong_pin === '1',
    });
    const [journal, prefixes] = await Promise.all([
      db.all('SELECT * FROM journal ORDER BY id DESC LIMIT 50'),
      db.all('SELECT * FROM prefixes ORDER BY prefix'),
    ]);
    render(res, 'simulator', { active: 'System Operations', title: 'Transaction Simulator',
      journal, prefixes, result, form: b });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/simulator/clear', async (req, res) => {
  try {
    await db.run('DELETE FROM journal');
    res.redirect('/simulator');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Profile ─────────────────────────────────────────────────────────────────
app.get('/profile', async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id,username,email,role,active,last_login,created_at FROM users WHERE id=$1',
      [req.session.user.id]);
    render(res, 'profile', { active: 'Profile', title: 'My Profile', user, msg: null, error: null });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/profile/password', async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const renderProfile = async (error, msg) => {
    const user = await db.get(
      'SELECT id,username,email,role,active,last_login,created_at FROM users WHERE id=$1',
      [req.session.user.id]);
    render(res, 'profile', { active: 'Profile', title: 'My Profile', user, msg, error });
  };
  try {
    const user = await db.get('SELECT * FROM users WHERE id=$1', [req.session.user.id]);
    if (!(await bcrypt.compare(current_password, user.password_hash))) {
      return renderProfile('La contraseña actual es incorrecta.', null);
    }
    if (new_password.length < 6) {
      return renderProfile('La nueva contraseña debe tener al menos 6 caracteres.', null);
    }
    if (new_password !== confirm_password) {
      return renderProfile('Las contraseñas nuevas no coinciden.', null);
    }
    const hash = await bcrypt.hash(new_password, 10);
    await db.run('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
    renderProfile(null, 'Contraseña actualizada correctamente.');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── User Management (admin only) ────────────────────────────────────────────
app.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.all(
      `SELECT u.*, c.username AS created_by_name
       FROM users u LEFT JOIN users c ON c.id = u.created_by
       ORDER BY u.created_at DESC`);
    render(res, 'users', { active: 'Users', title: 'User Management',
      users, msg: req.query.msg || null, error: req.query.error || null });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/users', requireAdmin, async (req, res) => {
  const { username, email, password, role } = req.body;
  try {
    if (!username || !email || !password) throw new Error('Todos los campos son obligatorios.');
    if (password.length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres.');
    const hash = await bcrypt.hash(password, 10);
    await db.run(
      'INSERT INTO users (username,email,password_hash,role,created_by) VALUES ($1,$2,$3,$4,$5)',
      [username.trim(), email.trim(), hash, role||'user', req.session.user.id]);
    res.redirect('/users?msg=' + encodeURIComponent(`Usuario "${username}" creado correctamente.`));
  } catch (err) {
    res.redirect('/users?error=' + encodeURIComponent(err.message));
  }
});

app.post('/users/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const user = await db.get('SELECT id,username,active FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.redirect('/users?error=Usuario+no+encontrado.');
    if (user.id === req.session.user.id) {
      return res.redirect('/users?error=' + encodeURIComponent('No puedes revocar tu propio acceso.'));
    }
    await db.run('UPDATE users SET active=$1 WHERE id=$2', [!user.active, user.id]);
    const action = user.active ? 'revocado' : 'restaurado';
    res.redirect('/users?msg=' + encodeURIComponent(`Acceso ${action} para "${user.username}".`));
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/users/:id/delete', requireAdmin, async (req, res) => {
  try {
    const user = await db.get('SELECT id,username FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.redirect('/users?error=Usuario+no+encontrado.');
    if (user.id === req.session.user.id) {
      return res.redirect('/users?error=' + encodeURIComponent('No puedes eliminar tu propia cuenta.'));
    }
    await db.run('DELETE FROM users WHERE id=$1', [user.id]);
    res.redirect('/users?msg=' + encodeURIComponent(`Usuario "${user.username}" eliminado.`));
  } catch (err) { res.status(500).send(err.message); }
});

// ─── JSON API ─────────────────────────────────────────────────────────────────
app.post('/api/authorize', async (req, res) => {
  try {
    res.json(await authorize({
      pan: req.body.pan, amount: Number(req.body.amount),
      txn_type: req.body.txn_type, source: req.body.source,
      wrong_pin: !!req.body.wrong_pin,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => console.log(`BASE24-eps Simulator → http://localhost:${PORT}`));
}

module.exports = app;
