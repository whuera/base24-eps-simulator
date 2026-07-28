'use strict';

/*
 * Capa de datos SQLite para el simulador BASE24-eps.
 * Crea el esquema (idempotente) y siembra datos de ejemplo tomados
 * de los manuales de ACI: Institution BNK1, Host VISA_BASE1,
 * Prefix 160107, Source Routing Profile STAR_SRC, etc.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'base24eps.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS institutions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      institution_id     TEXT UNIQUE NOT NULL,
      institution_number TEXT,
      institution_name   TEXT,
      issuer_type        TEXT DEFAULT 'Institution',
      addr_line1         TEXT, addr_line2 TEXT,
      city               TEXT, country TEXT,
      postal_code        TEXT, state_province TEXT,
      settings_json      TEXT DEFAULT '{}',
      status_msg         TEXT DEFAULT '',
      created_at         TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      institution_ref INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
      contact         TEXT, phone TEXT, email TEXT, comments TEXT
    );

    CREATE TABLE IF NOT EXISTS hosts (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      interface_name         TEXT UNIQUE NOT NULL,
      kind                   TEXT DEFAULT 'Interchange',   -- Host | Interchange
      cutover_time           TEXT DEFAULT '12:00 am',
      time_offset            TEXT DEFAULT '00:00',
      statistics_interval    INTEGER DEFAULT 0,
      settlement_days        TEXT DEFAULT '7-Day',         -- 5-Day | 7-Day
      source_routing_profile TEXT,
      acquirer_txn_profile   TEXT,
      issuer_txn_profile     TEXT,
      context_profile        TEXT,
      iso_message_profile    TEXT,
      action_code_profile    TEXT,
      acquirer_surcharge_profile TEXT,
      currency_conversion_fee_profile TEXT,
      created_at             TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prefixes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      prefix         TEXT NOT NULL,
      pan_length     INTEGER DEFAULT 16,
      issuer_id      TEXT,                                 -- institution_id del emisor
      prefix_type    TEXT DEFAULT 'On-Us',                 -- On-Us | System | Not-On-Us
      route_type     TEXT DEFAULT 'Acquirer and Issuer',   -- Acquirer and Issuer | Issuer only
      member_number_on_track INTEGER DEFAULT 0,
      include_holds  INTEGER DEFAULT 0,
      expiration_check_option TEXT DEFAULT '{none}',
      fraud_option   TEXT DEFAULT 'Do Not Use Fraud System',
      max_pin_retry  INTEGER DEFAULT 3,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS limit_profiles (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT UNIQUE NOT NULL,
      description         TEXT,
      min_amount          REAL DEFAULT 0,
      max_amount_per_txn  REAL DEFAULT 1000000,
      daily_amount_limit  REAL DEFAULT 1000000,
      daily_count_limit   INTEGER DEFAULT 9999,
      created_at          TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS routing_profiles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS routing_destinations (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_ref               INTEGER NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
      seq                       INTEGER DEFAULT 1,
      destination_routing_profile TEXT,                   -- normalmente un interface_name de hosts
      issuer_id                 TEXT,
      limit_profile             TEXT,
      issuer_surcharge_profile  TEXT,
      instrument_type           TEXT DEFAULT 'ATM',        -- ATM | POS | Any
      route_type                TEXT DEFAULT 'Acquirer & Issuer'
    );

    CREATE TABLE IF NOT EXISTS journal (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      stan          TEXT,
      pan           TEXT,
      amount        REAL,
      txn_type      TEXT,
      source        TEXT,
      prefix_matched TEXT,
      issuer_id     TEXT,
      on_us         INTEGER,
      limit_profile TEXT,
      limit_result  TEXT,
      routed_to     TEXT,
      action_code   TEXT,
      action_desc   TEXT,
      steps_json    TEXT DEFAULT '[]',
      created_at    TEXT DEFAULT (datetime('now'))
    );
  `);
}

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM institutions').get().n;
  if (count > 0) return;

  const insInst = db.prepare(`INSERT INTO institutions
    (institution_id, institution_number, institution_name, issuer_type,
     addr_line1, city, country, postal_code, state_province, status_msg)
    VALUES (@institution_id,@institution_number,@institution_name,@issuer_type,
     @addr_line1,@city,@country,@postal_code,@state_province,@status_msg)`);

  const bnk1 = insInst.run({
    institution_id: 'BNK1', institution_number: '10000000123',
    institution_name: 'FIRSTSTATEBANK', issuer_type: 'Institution',
    addr_line1: '100 Main Street', city: 'Omaha', country: 'US',
    postal_code: '68102', state_province: 'NE',
    status_msg: '2 - Successful view of Institution ID BNK1.'
  });
  insInst.run({
    institution_id: 'PCBA_INST', institution_number: '20000000456',
    institution_name: 'POS CARD INSTITUTION', issuer_type: 'Institution',
    addr_line1: '55 Market Ave', city: 'Dallas', country: 'US',
    postal_code: '75201', state_province: 'TX',
    status_msg: '2 - Successful view of Institution ID PCBA_INST.'
  });

  db.prepare(`INSERT INTO contacts (institution_ref, contact, phone, email, comments)
    VALUES (?,?,?,?,?)`).run(bnk1.lastInsertRowid,
    'Operations Desk', '+1 402 555 0100', 'ops@firststatebank.example', 'Primary');

  db.prepare(`INSERT INTO hosts
    (interface_name, kind, cutover_time, time_offset, statistics_interval, settlement_days,
     source_routing_profile, acquirer_txn_profile, issuer_txn_profile, context_profile,
     iso_message_profile, action_code_profile, acquirer_surcharge_profile)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'VISA_BASE1', 'Interchange', '12:00 am', '00:00', 0, '7-Day',
    'STAR_SRC', 'QA_ACQ_TXN', 'QA_ISS_ALL', 'CTX_VISA', 'MSG_VISA', 'ACT_CDE_VISA', '');

  db.prepare(`INSERT INTO hosts
    (interface_name, kind, cutover_time, settlement_days, source_routing_profile,
     acquirer_txn_profile, issuer_txn_profile, context_profile, iso_message_profile, action_code_profile)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'STAR_HOST', 'Host', '12:00 am', '5-Day', 'STAR_SRC',
    'QA_ACQ_TXN', 'QA_ISS_ALL', 'CTX_STAR', 'MSG_STAR', 'ACT_CDE_STAR');

  db.prepare(`INSERT INTO prefixes
    (prefix, pan_length, issuer_id, prefix_type, route_type)
    VALUES (?,?,?,?,?)`).run('160107', 16, 'PCBA_INST', 'On-Us', 'Acquirer and Issuer');
  db.prepare(`INSERT INTO prefixes
    (prefix, pan_length, issuer_id, prefix_type, route_type)
    VALUES (?,?,?,?,?)`).run('510510', 16, 'BNK1', 'On-Us', 'Acquirer and Issuer');
  db.prepare(`INSERT INTO prefixes
    (prefix, pan_length, issuer_id, prefix_type, route_type)
    VALUES (?,?,?,?,?)`).run('400000', 16, 'BNK1', 'Not-On-Us', 'Issuer only');

  db.prepare(`INSERT INTO limit_profiles
    (name, description, min_amount, max_amount_per_txn, daily_amount_limit, daily_count_limit)
    VALUES (?,?,?,?,?,?)`).run('LMT_STD', 'Standard ATM/POS limits', 1, 500, 2000, 10);
  db.prepare(`INSERT INTO limit_profiles
    (name, description, min_amount, max_amount_per_txn, daily_amount_limit, daily_count_limit)
    VALUES (?,?,?,?,?,?)`).run('LMT_VIP', 'High limits', 1, 5000, 20000, 40);

  const src = db.prepare(`INSERT INTO routing_profiles (name, description) VALUES (?,?)`)
    .run('STAR_SRC', 'Source Routing Profile principal');
  const insDest = db.prepare(`INSERT INTO routing_destinations
    (profile_ref, seq, destination_routing_profile, issuer_id, limit_profile,
     issuer_surcharge_profile, instrument_type, route_type)
    VALUES (?,?,?,?,?,?,?,?)`);
  insDest.run(src.lastInsertRowid, 1, 'STAR_HOST', 'PCBA_INST', 'LMT_STD', '', 'ATM', 'Acquirer & Issuer');
  insDest.run(src.lastInsertRowid, 2, 'VISA_BASE1', 'BNK1', 'LMT_STD', '', 'POS', 'Issuer only');
  insDest.run(src.lastInsertRowid, 3, 'VISA_BASE1', '', 'LMT_VIP', '', 'Any', 'Acquirer & Issuer');
}

initSchema();
seedIfEmpty();

module.exports = db;
