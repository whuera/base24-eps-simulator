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
    // Explicitly save session before redirect so the cookie is written in serverless envs
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
    const [inst, hosts, prefixes, routing, journal] = await Promise.all([
      db.get('SELECT COUNT(*) AS n FROM institutions'),
      db.get('SELECT COUNT(*) AS n FROM hosts'),
      db.get('SELECT COUNT(*) AS n FROM prefixes'),
      db.get('SELECT COUNT(*) AS n FROM routing_profiles'),
      db.get('SELECT COUNT(*) AS n FROM journal'),
    ]);
    const counts = {
      institutions: Number(inst.n), hosts: Number(hosts.n),
      prefixes: Number(prefixes.n), routing: Number(routing.n), journal: Number(journal.n),
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
    render(res, 'institution', { active: 'Institution', title: 'Institution Configuration',
      list, sel, contacts, tab: req.query.tab || 'address' });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/institution', async (req, res) => {
  try {
    const b = req.body;
    const exists = await db.get('SELECT id FROM institutions WHERE institution_id=$1', [b.institution_id]);
    const msg = `2 - Successful save of Institution ID ${b.institution_id}.`;
    if (exists) {
      await db.run(`UPDATE institutions SET institution_number=$1, institution_name=$2,
        issuer_type=$3, addr_line1=$4, addr_line2=$5, city=$6, country=$7,
        postal_code=$8, state_province=$9, status_msg=$10 WHERE institution_id=$11`,
        [b.institution_number, b.institution_name, b.issuer_type||'Institution',
         b.addr_line1, b.addr_line2, b.city, b.country,
         b.postal_code, b.state_province, msg, b.institution_id]);
    } else {
      await db.run(`INSERT INTO institutions (institution_id, institution_number, institution_name,
        issuer_type, addr_line1, addr_line2, city, country, postal_code, state_province, status_msg)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [b.institution_id, b.institution_number, b.institution_name, b.issuer_type||'Institution',
         b.addr_line1, b.addr_line2, b.city, b.country, b.postal_code, b.state_province, msg]);
    }
    res.redirect('/institution?id=' + encodeURIComponent(b.institution_id));
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
    render(res, 'prefix', { active: 'Prefix', title: 'Prefix Configuration',
      list, sel, issuers, tab: req.query.tab || 'processing' });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/prefix', async (req, res) => {
  try {
    const b = req.body;
    const vals = [b.prefix, Number(b.pan_length||16), b.issuer_id, b.prefix_type, b.route_type,
                  b.member_number_on_track?1:0, b.include_holds?1:0,
                  b.expiration_check_option, b.fraud_option, Number(b.max_pin_retry||3)];
    if (b.id) {
      await db.run(`UPDATE prefixes SET prefix=$1, pan_length=$2, issuer_id=$3, prefix_type=$4,
        route_type=$5, member_number_on_track=$6, include_holds=$7, expiration_check_option=$8,
        fraud_option=$9, max_pin_retry=$10 WHERE id=$11`, [...vals, b.id]);
      res.redirect('/prefix?id=' + b.id);
    } else {
      const row = await db.run(`INSERT INTO prefixes (prefix, pan_length, issuer_id, prefix_type,
        route_type, member_number_on_track, include_holds, expiration_check_option,
        fraud_option, max_pin_retry) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, vals);
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
    const hosts   = (await db.all('SELECT interface_name FROM hosts ORDER BY interface_name')).map((h) => h.interface_name);
    const limits  = (await db.all('SELECT name FROM limit_profiles ORDER BY name')).map((l) => l.name);
    const issuers = (await db.all('SELECT institution_id FROM institutions ORDER BY institution_id')).map((i) => i.institution_id);
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
      issuer_id,limit_profile,issuer_surcharge_profile,instrument_type,route_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [b.profile_ref, Number(row.m)+1, b.destination_routing_profile, b.issuer_id,
       b.limit_profile, b.issuer_surcharge_profile, b.instrument_type, b.route_type]);
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
    const result = await authorize({ pan: b.pan, amount: Number(b.amount), txn_type: b.txn_type, source: b.source });
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

// ─── Profile (any authenticated user) ────────────────────────────────────────
app.get('/profile', async (req, res) => {
  try {
    const user = await db.get('SELECT id,username,email,role,active,last_login,created_at FROM users WHERE id=$1',
      [req.session.user.id]);
    render(res, 'profile', { active: 'Profile', title: 'My Profile', user, msg: null, error: null });
  } catch (err) { res.status(500).send(err.message); }
});

app.post('/profile/password', async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const renderProfile = async (error, msg) => {
    const user = await db.get('SELECT id,username,email,role,active,last_login,created_at FROM users WHERE id=$1',
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
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => console.log(`BASE24-eps Simulator → http://localhost:${PORT}`));
}

module.exports = app;
