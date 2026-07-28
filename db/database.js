'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── Async helper (mirrors the old synchronous SQLite API) ───────────────────
const db = {
  async get(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows[0] || null;
  },
  async all(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows;
  },
  // For INSERT ... RETURNING id / UPDATE / DELETE
  async run(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows[0] || {};
  },
};

// ─── Schema (idempotent) ─────────────────────────────────────────────────────
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS institutions (
      id                 SERIAL PRIMARY KEY,
      institution_id     TEXT UNIQUE NOT NULL,
      institution_number TEXT,
      institution_name   TEXT,
      issuer_type        TEXT DEFAULT 'Institution',
      addr_line1         TEXT, addr_line2 TEXT,
      city               TEXT, country TEXT,
      postal_code        TEXT, state_province TEXT,
      settings_json      TEXT DEFAULT '{}',
      status_msg         TEXT DEFAULT '',
      created_at         TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id              SERIAL PRIMARY KEY,
      institution_ref INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
      contact TEXT, phone TEXT, email TEXT, comments TEXT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hosts (
      id                              SERIAL PRIMARY KEY,
      interface_name                  TEXT UNIQUE NOT NULL,
      kind                            TEXT DEFAULT 'Interchange',
      cutover_time                    TEXT DEFAULT '12:00 am',
      time_offset                     TEXT DEFAULT '00:00',
      statistics_interval             INTEGER DEFAULT 0,
      settlement_days                 TEXT DEFAULT '7-Day',
      source_routing_profile          TEXT,
      acquirer_txn_profile            TEXT,
      issuer_txn_profile              TEXT,
      context_profile                 TEXT,
      iso_message_profile             TEXT,
      action_code_profile             TEXT,
      acquirer_surcharge_profile      TEXT,
      currency_conversion_fee_profile TEXT,
      created_at                      TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS prefixes (
      id                      SERIAL PRIMARY KEY,
      prefix                  TEXT NOT NULL,
      pan_length              INTEGER DEFAULT 16,
      issuer_id               TEXT,
      prefix_type             TEXT DEFAULT 'On-Us',
      route_type              TEXT DEFAULT 'Acquirer and Issuer',
      member_number_on_track  INTEGER DEFAULT 0,
      include_holds           INTEGER DEFAULT 0,
      expiration_check_option TEXT DEFAULT '{none}',
      fraud_option            TEXT DEFAULT 'Do Not Use Fraud System',
      max_pin_retry           INTEGER DEFAULT 3,
      created_at              TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS limit_profiles (
      id                 SERIAL PRIMARY KEY,
      name               TEXT UNIQUE NOT NULL,
      description        TEXT,
      min_amount         NUMERIC DEFAULT 0,
      max_amount_per_txn NUMERIC DEFAULT 1000000,
      daily_amount_limit NUMERIC DEFAULT 1000000,
      daily_count_limit  INTEGER DEFAULT 9999,
      created_at         TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS routing_profiles (
      id          SERIAL PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS routing_destinations (
      id                          SERIAL PRIMARY KEY,
      profile_ref                 INTEGER NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
      seq                         INTEGER DEFAULT 1,
      destination_routing_profile TEXT,
      issuer_id                   TEXT,
      limit_profile               TEXT,
      issuer_surcharge_profile    TEXT,
      instrument_type             TEXT DEFAULT 'ATM',
      route_type                  TEXT DEFAULT 'Acquirer & Issuer'
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS journal (
      id             SERIAL PRIMARY KEY,
      stan           TEXT,
      pan            TEXT,
      amount         NUMERIC,
      txn_type       TEXT,
      source         TEXT,
      prefix_matched TEXT,
      issuer_id      TEXT,
      on_us          INTEGER,
      limit_profile  TEXT,
      limit_result   TEXT,
      routed_to      TEXT,
      action_code    TEXT,
      action_desc    TEXT,
      steps_json     TEXT DEFAULT '[]',
      created_at     TIMESTAMP DEFAULT NOW()
    )`);
}

// ─── Seed data (runs only when institutions table is empty) ──────────────────
async function seedIfEmpty() {
  const row = await db.get('SELECT COUNT(*) AS n FROM institutions');
  if (Number(row.n) > 0) return;

  const bnk1 = await db.run(`
    INSERT INTO institutions (institution_id, institution_number, institution_name, issuer_type,
      addr_line1, city, country, postal_code, state_province, status_msg)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    ['BNK1','10000000123','FIRSTSTATEBANK','Institution',
     '100 Main Street','Omaha','US','68102','NE',
     '2 - Successful view of Institution ID BNK1.']);

  await db.run(`
    INSERT INTO institutions (institution_id, institution_number, institution_name, issuer_type,
      addr_line1, city, country, postal_code, state_province, status_msg)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    ['PCBA_INST','20000000456','POS CARD INSTITUTION','Institution',
     '55 Market Ave','Dallas','US','75201','TX',
     '2 - Successful view of Institution ID PCBA_INST.']);

  await db.run(
    'INSERT INTO contacts (institution_ref, contact, phone, email, comments) VALUES ($1,$2,$3,$4,$5)',
    [bnk1.id, 'Operations Desk', '+1 402 555 0100', 'ops@firststatebank.example', 'Primary']);

  await db.run(`
    INSERT INTO hosts (interface_name, kind, cutover_time, time_offset, statistics_interval,
      settlement_days, source_routing_profile, acquirer_txn_profile, issuer_txn_profile,
      context_profile, iso_message_profile, action_code_profile, acquirer_surcharge_profile)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    ['VISA_BASE1','Interchange','12:00 am','00:00',0,'7-Day',
     'STAR_SRC','QA_ACQ_TXN','QA_ISS_ALL','CTX_VISA','MSG_VISA','ACT_CDE_VISA','']);

  await db.run(`
    INSERT INTO hosts (interface_name, kind, cutover_time, settlement_days, source_routing_profile,
      acquirer_txn_profile, issuer_txn_profile, context_profile, iso_message_profile, action_code_profile)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    ['STAR_HOST','Host','12:00 am','5-Day','STAR_SRC',
     'QA_ACQ_TXN','QA_ISS_ALL','CTX_STAR','MSG_STAR','ACT_CDE_STAR']);

  for (const [prefix, len, issuer, type, route] of [
    ['160107',16,'PCBA_INST','On-Us','Acquirer and Issuer'],
    ['510510',16,'BNK1','On-Us','Acquirer and Issuer'],
    ['400000',16,'BNK1','Not-On-Us','Issuer only'],
  ]) {
    await db.run(
      'INSERT INTO prefixes (prefix, pan_length, issuer_id, prefix_type, route_type) VALUES ($1,$2,$3,$4,$5)',
      [prefix, len, issuer, type, route]);
  }

  await db.run(
    'INSERT INTO limit_profiles (name, description, min_amount, max_amount_per_txn, daily_amount_limit, daily_count_limit) VALUES ($1,$2,$3,$4,$5,$6)',
    ['LMT_STD','Standard ATM/POS limits',1,500,2000,10]);
  await db.run(
    'INSERT INTO limit_profiles (name, description, min_amount, max_amount_per_txn, daily_amount_limit, daily_count_limit) VALUES ($1,$2,$3,$4,$5,$6)',
    ['LMT_VIP','High limits',1,5000,20000,40]);

  const src = await db.run(
    'INSERT INTO routing_profiles (name, description) VALUES ($1,$2) RETURNING id',
    ['STAR_SRC','Source Routing Profile principal']);

  for (const [seq, dest, issuer, lmt, instr, rt] of [
    [1,'STAR_HOST','PCBA_INST','LMT_STD','ATM','Acquirer & Issuer'],
    [2,'VISA_BASE1','BNK1',    'LMT_STD','POS','Issuer only'],
    [3,'VISA_BASE1','',        'LMT_VIP','Any','Acquirer & Issuer'],
  ]) {
    await db.run(`
      INSERT INTO routing_destinations (profile_ref, seq, destination_routing_profile, issuer_id,
        limit_profile, issuer_surcharge_profile, instrument_type, route_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [src.id, seq, dest, issuer, lmt, '', instr, rt]);
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const ready = initSchema()
  .then(() => seedIfEmpty())
  .catch((err) => console.error('DB init error:', err.message));

module.exports = { db, pool, ready };
