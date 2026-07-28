'use strict';

const path = require('path');
const express = require('express');
const db = require('./db/database');
const { authorize, ACTION_CODES } = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

// Menu del shell EPS Development - ESNCService
const MENUS = ['File', 'Edit', 'Configure', 'System Operations', 'Customer Management', 'View', 'Window', 'Help'];

function render(res, view, opts = {}) {
  res.render(view, Object.assign({ menus: MENUS, active: '', title: '' }, opts));
}

// ---------- Desktop ----------
app.get('/', (req, res) => {
  const counts = {
    institutions: db.prepare('SELECT COUNT(*) n FROM institutions').get().n,
    hosts: db.prepare('SELECT COUNT(*) n FROM hosts').get().n,
    prefixes: db.prepare('SELECT COUNT(*) n FROM prefixes').get().n,
    routing: db.prepare('SELECT COUNT(*) n FROM routing_profiles').get().n,
    journal: db.prepare('SELECT COUNT(*) n FROM journal').get().n,
  };
  render(res, 'desktop', { active: '', title: 'EPS Development - ESNCService', counts });
});

// ---------- Institution ----------
app.get('/institution', (req, res) => {
  const list = db.prepare('SELECT * FROM institutions ORDER BY institution_id').all();
  const sel = req.query.id
    ? db.prepare('SELECT * FROM institutions WHERE institution_id=?').get(req.query.id)
    : list[0];
  const contacts = sel ? db.prepare('SELECT * FROM contacts WHERE institution_ref=?').all(sel.id) : [];
  render(res, 'institution', { active: 'Institution', title: 'Institution Configuration',
    list, sel, contacts, tab: req.query.tab || 'address' });
});

app.post('/institution', (req, res) => {
  const b = req.body;
  const exists = db.prepare('SELECT id FROM institutions WHERE institution_id=?').get(b.institution_id);
  const data = {
    institution_id: b.institution_id, institution_number: b.institution_number,
    institution_name: b.institution_name, issuer_type: b.issuer_type || 'Institution',
    addr_line1: b.addr_line1, addr_line2: b.addr_line2, city: b.city, country: b.country,
    postal_code: b.postal_code, state_province: b.state_province,
    status_msg: `2 - Successful save of Institution ID ${b.institution_id}.`,
  };
  if (exists) {
    db.prepare(`UPDATE institutions SET institution_number=@institution_number,
      institution_name=@institution_name, issuer_type=@issuer_type, addr_line1=@addr_line1,
      addr_line2=@addr_line2, city=@city, country=@country, postal_code=@postal_code,
      state_province=@state_province, status_msg=@status_msg WHERE institution_id=@institution_id`).run(data);
  } else {
    db.prepare(`INSERT INTO institutions (institution_id, institution_number, institution_name,
      issuer_type, addr_line1, addr_line2, city, country, postal_code, state_province, status_msg)
      VALUES (@institution_id,@institution_number,@institution_name,@issuer_type,@addr_line1,
      @addr_line2,@city,@country,@postal_code,@state_province,@status_msg)`).run(data);
  }
  res.redirect('/institution?id=' + encodeURIComponent(b.institution_id));
});

app.post('/institution/delete', (req, res) => {
  db.prepare('DELETE FROM institutions WHERE institution_id=?').run(req.body.institution_id);
  res.redirect('/institution');
});

// ---------- Host / Interchange ----------
app.get('/host', (req, res) => {
  const list = db.prepare('SELECT * FROM hosts ORDER BY interface_name').all();
  const sel = req.query.name
    ? db.prepare('SELECT * FROM hosts WHERE interface_name=?').get(req.query.name)
    : list[0];
  const profiles = db.prepare('SELECT name FROM routing_profiles').all().map((r) => r.name);
  render(res, 'host', { active: 'Host/Interchange', title: 'ISO Interface Configuration',
    list, sel, profiles, tab: req.query.tab || 'processing' });
});

app.post('/host', (req, res) => {
  const b = req.body;
  const exists = db.prepare('SELECT id FROM hosts WHERE interface_name=?').get(b.interface_name);
  const data = {
    interface_name: b.interface_name, kind: b.kind || 'Interchange',
    cutover_time: b.cutover_time, time_offset: b.time_offset,
    statistics_interval: Number(b.statistics_interval || 0), settlement_days: b.settlement_days,
    source_routing_profile: b.source_routing_profile, acquirer_txn_profile: b.acquirer_txn_profile,
    issuer_txn_profile: b.issuer_txn_profile, context_profile: b.context_profile,
    iso_message_profile: b.iso_message_profile, action_code_profile: b.action_code_profile,
    acquirer_surcharge_profile: b.acquirer_surcharge_profile,
    currency_conversion_fee_profile: b.currency_conversion_fee_profile,
  };
  if (exists) {
    db.prepare(`UPDATE hosts SET kind=@kind, cutover_time=@cutover_time, time_offset=@time_offset,
      statistics_interval=@statistics_interval, settlement_days=@settlement_days,
      source_routing_profile=@source_routing_profile, acquirer_txn_profile=@acquirer_txn_profile,
      issuer_txn_profile=@issuer_txn_profile, context_profile=@context_profile,
      iso_message_profile=@iso_message_profile, action_code_profile=@action_code_profile,
      acquirer_surcharge_profile=@acquirer_surcharge_profile,
      currency_conversion_fee_profile=@currency_conversion_fee_profile
      WHERE interface_name=@interface_name`).run(data);
  } else {
    db.prepare(`INSERT INTO hosts (interface_name, kind, cutover_time, time_offset,
      statistics_interval, settlement_days, source_routing_profile, acquirer_txn_profile,
      issuer_txn_profile, context_profile, iso_message_profile, action_code_profile,
      acquirer_surcharge_profile, currency_conversion_fee_profile)
      VALUES (@interface_name,@kind,@cutover_time,@time_offset,@statistics_interval,
      @settlement_days,@source_routing_profile,@acquirer_txn_profile,@issuer_txn_profile,
      @context_profile,@iso_message_profile,@action_code_profile,@acquirer_surcharge_profile,
      @currency_conversion_fee_profile)`).run(data);
  }
  res.redirect('/host?name=' + encodeURIComponent(b.interface_name));
});

app.post('/host/delete', (req, res) => {
  db.prepare('DELETE FROM hosts WHERE interface_name=?').run(req.body.interface_name);
  res.redirect('/host');
});

// ---------- Prefix ----------
app.get('/prefix', (req, res) => {
  const list = db.prepare('SELECT * FROM prefixes ORDER BY prefix').all();
  const sel = req.query.id
    ? db.prepare('SELECT * FROM prefixes WHERE id=?').get(req.query.id)
    : list[0];
  const issuers = db.prepare('SELECT institution_id, institution_name FROM institutions ORDER BY institution_id').all();
  render(res, 'prefix', { active: 'Prefix', title: 'Prefix Configuration',
    list, sel, issuers, tab: req.query.tab || 'processing' });
});

app.post('/prefix', (req, res) => {
  const b = req.body;
  const data = {
    prefix: b.prefix, pan_length: Number(b.pan_length || 16), issuer_id: b.issuer_id,
    prefix_type: b.prefix_type, route_type: b.route_type,
    member_number_on_track: b.member_number_on_track ? 1 : 0,
    include_holds: b.include_holds ? 1 : 0,
    expiration_check_option: b.expiration_check_option, fraud_option: b.fraud_option,
    max_pin_retry: Number(b.max_pin_retry || 3),
  };
  if (b.id) {
    db.prepare(`UPDATE prefixes SET prefix=@prefix, pan_length=@pan_length, issuer_id=@issuer_id,
      prefix_type=@prefix_type, route_type=@route_type, member_number_on_track=@member_number_on_track,
      include_holds=@include_holds, expiration_check_option=@expiration_check_option,
      fraud_option=@fraud_option, max_pin_retry=@max_pin_retry WHERE id=@id`).run(Object.assign(data, { id: b.id }));
    res.redirect('/prefix?id=' + b.id);
  } else {
    const info = db.prepare(`INSERT INTO prefixes (prefix, pan_length, issuer_id, prefix_type,
      route_type, member_number_on_track, include_holds, expiration_check_option, fraud_option, max_pin_retry)
      VALUES (@prefix,@pan_length,@issuer_id,@prefix_type,@route_type,@member_number_on_track,
      @include_holds,@expiration_check_option,@fraud_option,@max_pin_retry)`).run(data);
    res.redirect('/prefix?id=' + info.lastInsertRowid);
  }
});

app.post('/prefix/delete', (req, res) => {
  db.prepare('DELETE FROM prefixes WHERE id=?').run(req.body.id);
  res.redirect('/prefix');
});

// ---------- Routing ----------
app.get('/routing', (req, res) => {
  const list = db.prepare('SELECT * FROM routing_profiles ORDER BY name').all();
  const sel = req.query.id
    ? db.prepare('SELECT * FROM routing_profiles WHERE id=?').get(req.query.id)
    : list[0];
  const dests = sel ? db.prepare('SELECT * FROM routing_destinations WHERE profile_ref=? ORDER BY seq').all(sel.id) : [];
  const hosts = db.prepare('SELECT interface_name FROM hosts ORDER BY interface_name').all().map((h) => h.interface_name);
  const limits = db.prepare('SELECT name FROM limit_profiles ORDER BY name').all().map((l) => l.name);
  const issuers = db.prepare('SELECT institution_id FROM institutions ORDER BY institution_id').all().map((i) => i.institution_id);
  render(res, 'routing', { active: 'Routing', title: 'Source Routing Profile',
    list, sel, dests, hosts, limits, issuers });
});

app.post('/routing', (req, res) => {
  const b = req.body;
  let profileId = b.id;
  if (profileId) {
    db.prepare('UPDATE routing_profiles SET name=?, description=? WHERE id=?').run(b.name, b.description, profileId);
  } else {
    const info = db.prepare('INSERT INTO routing_profiles (name, description) VALUES (?,?)').run(b.name, b.description);
    profileId = info.lastInsertRowid;
  }
  res.redirect('/routing?id=' + profileId);
});

app.post('/routing/destination', (req, res) => {
  const b = req.body;
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) m FROM routing_destinations WHERE profile_ref=?').get(b.profile_ref).m) + 1;
  db.prepare(`INSERT INTO routing_destinations (profile_ref, seq, destination_routing_profile,
    issuer_id, limit_profile, issuer_surcharge_profile, instrument_type, route_type)
    VALUES (?,?,?,?,?,?,?,?)`).run(b.profile_ref, seq, b.destination_routing_profile,
    b.issuer_id, b.limit_profile, b.issuer_surcharge_profile, b.instrument_type, b.route_type);
  res.redirect('/routing?id=' + b.profile_ref);
});

app.post('/routing/destination/delete', (req, res) => {
  const d = db.prepare('SELECT profile_ref FROM routing_destinations WHERE id=?').get(req.body.id);
  db.prepare('DELETE FROM routing_destinations WHERE id=?').run(req.body.id);
  res.redirect('/routing?id=' + (d ? d.profile_ref : ''));
});

// ---------- Simulator / Journal ----------
app.get('/simulator', (req, res) => {
  const journal = db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT 50').all();
  const prefixes = db.prepare('SELECT * FROM prefixes ORDER BY prefix').all();
  render(res, 'simulator', { active: 'System Operations', title: 'Transaction Simulator',
    journal, prefixes, result: null,
    form: { pan: '1601070000001234', amount: '120.00', txn_type: 'Withdrawal', source: 'ATM' } });
});

app.post('/simulator', (req, res) => {
  const b = req.body;
  const result = authorize({ pan: b.pan, amount: Number(b.amount), txn_type: b.txn_type, source: b.source });
  const journal = db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT 50').all();
  const prefixes = db.prepare('SELECT * FROM prefixes ORDER BY prefix').all();
  render(res, 'simulator', { active: 'System Operations', title: 'Transaction Simulator',
    journal, prefixes, result, form: b });
});

app.post('/simulator/clear', (req, res) => {
  db.prepare('DELETE FROM journal').run();
  res.redirect('/simulator');
});

// JSON API (para integraciones / pruebas)
app.post('/api/authorize', (req, res) => {
  res.json(authorize({
    pan: req.body.pan, amount: Number(req.body.amount),
    txn_type: req.body.txn_type, source: req.body.source,
  }));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`BASE24-eps Simulator escuchando en http://localhost:${PORT}`);
  });
}

module.exports = app;
