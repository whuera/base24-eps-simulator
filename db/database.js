'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── Async helper ────────────────────────────────────────────────────────────
const db = {
  async get(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows[0] || null;
  },
  async all(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows;
  },
  async run(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows[0] || {};
  },
};

// ─── Schema ──────────────────────────────────────────────────────────────────
async function initSchema() {
  // Session store
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid"    VARCHAR   NOT NULL COLLATE "default",
      "sess"   JSON      NOT NULL,
      "expire" TIMESTAMP NOT NULL,
      PRIMARY KEY ("sid")
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT DEFAULT 'user',
      active        BOOLEAN DEFAULT true,
      last_login    TIMESTAMP,
      created_at    TIMESTAMP DEFAULT NOW(),
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS institutions (
      id                      SERIAL PRIMARY KEY,
      institution_id          TEXT UNIQUE NOT NULL,
      institution_number      TEXT,
      institution_name        TEXT,
      issuer_type             TEXT DEFAULT 'Institution',
      addr_line1              TEXT, addr_line2 TEXT,
      city                    TEXT, country TEXT,
      postal_code             TEXT, state_province TEXT,
      timezone                TEXT DEFAULT 'UTC',
      currency_code           TEXT DEFAULT '840',
      destination_routing_profile TEXT,
      cutover_time            TEXT DEFAULT '12:00 am',
      settings_json           TEXT DEFAULT '{}',
      status_msg              TEXT DEFAULT '',
      created_at              TIMESTAMP DEFAULT NOW()
    )`);

  // Migrate: add columns if they don't exist
  for (const col of [
    `ALTER TABLE institutions ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC'`,
    `ALTER TABLE institutions ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT '840'`,
    `ALTER TABLE institutions ADD COLUMN IF NOT EXISTS destination_routing_profile TEXT`,
    `ALTER TABLE institutions ADD COLUMN IF NOT EXISTS cutover_time TEXT DEFAULT '12:00 am'`,
  ]) { await pool.query(col).catch(() => {}); }

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
      id                          SERIAL PRIMARY KEY,
      prefix                      TEXT NOT NULL,
      pan_length                  INTEGER DEFAULT 16,
      issuer_id                   TEXT,
      prefix_type                 TEXT DEFAULT 'On-Us',
      route_type                  TEXT DEFAULT 'Acquirer and Issuer',
      destination_routing_profile TEXT,
      member_number_on_track      INTEGER DEFAULT 0,
      include_holds               INTEGER DEFAULT 0,
      expiration_check_option     TEXT DEFAULT '{none}',
      fraud_option                TEXT DEFAULT 'Do Not Use Fraud System',
      max_pin_retry               INTEGER DEFAULT 3,
      created_at                  TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(
    `ALTER TABLE prefixes ADD COLUMN IF NOT EXISTS destination_routing_profile TEXT`
  ).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS limit_profiles (
      id                 SERIAL PRIMARY KEY,
      name               TEXT UNIQUE NOT NULL,
      description        TEXT,
      currency_code      TEXT DEFAULT 'USD',
      min_amount         NUMERIC DEFAULT 0,
      max_amount_per_txn NUMERIC DEFAULT 1000000,
      daily_amount_limit NUMERIC DEFAULT 1000000,
      daily_count_limit  INTEGER DEFAULT 9999,
      period_type        TEXT DEFAULT 'Rolling Daily',
      created_at         TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(
    `ALTER TABLE limit_profiles ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'USD'`
  ).catch(() => {});
  await pool.query(
    `ALTER TABLE limit_profiles ADD COLUMN IF NOT EXISTS period_type TEXT DEFAULT 'Rolling Daily'`
  ).catch(() => {});

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
      txn_code                    TEXT DEFAULT 'Any',
      limit_profile               TEXT,
      issuer_surcharge_profile    TEXT,
      instrument_type             TEXT DEFAULT 'ATM',
      route_type                  TEXT DEFAULT 'Acquirer & Issuer'
    )`);
  await pool.query(
    `ALTER TABLE routing_destinations ADD COLUMN IF NOT EXISTS txn_code TEXT DEFAULT 'Any'`
  ).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS destination_routing_profiles (
      id                     SERIAL PRIMARY KEY,
      name                   TEXT UNIQUE NOT NULL,
      description            TEXT,
      dest_route_floor_limit NUMERIC DEFAULT 0.00,
      currency_code          TEXT DEFAULT 'USD',
      txn_auditing_ind       BOOLEAN DEFAULT false,
      alt_floor_limit_algo   TEXT DEFAULT '',
      alt_floor_limit_check  BOOLEAN DEFAULT false,
      floor_limit            NUMERIC DEFAULT 0.00,
      over_limit_action      TEXT DEFAULT 'Decline',
      under_limit_action     TEXT DEFAULT 'Decline',
      created_at             TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS routing_config_dest (
      id               SERIAL PRIMARY KEY,
      profile_ref      INTEGER NOT NULL REFERENCES destination_routing_profiles(id) ON DELETE CASCADE,
      route_code       TEXT NOT NULL,
      account_type_1   TEXT DEFAULT 'Savings',
      account_type_2   TEXT DEFAULT 'Checking',
      cust_auth_method TEXT DEFAULT 'PIN',
      created_at       TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dest_src_relationships (
      id                   SERIAL PRIMARY KEY,
      dest_routing_profile TEXT NOT NULL,
      src_routing_profile  TEXT NOT NULL,
      txn_code             TEXT DEFAULT '**',
      route_code           TEXT DEFAULT '',
      created_at           TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id              SERIAL PRIMARY KEY,
      pan             TEXT UNIQUE NOT NULL,
      cardholder_name TEXT,
      expiry_date     TEXT,
      card_type       TEXT DEFAULT 'Debit',
      status          TEXT DEFAULT 'Active',
      issuer_id       TEXT,
      limit_profile   TEXT DEFAULT 'LMT_STD',
      account_type1   TEXT DEFAULT 'Savings',
      account_type2   TEXT DEFAULT 'Checking',
      pin_retries     INTEGER DEFAULT 0,
      max_pin_retry   INTEGER DEFAULT 3,
      created_at      TIMESTAMP DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id              SERIAL PRIMARY KEY,
      account_id      TEXT UNIQUE NOT NULL,
      card_pan        TEXT REFERENCES cards(pan) ON DELETE CASCADE,
      account_type    TEXT DEFAULT 'Savings',
      status          TEXT DEFAULT 'Active',
      available_bal   NUMERIC DEFAULT 0.00,
      ledger_bal      NUMERIC DEFAULT 0.00,
      currency_code   TEXT DEFAULT 'USD',
      limit_profile   TEXT,
      created_at      TIMESTAMP DEFAULT NOW()
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
      card_status    TEXT,
      limit_profile  TEXT,
      limit_result   TEXT,
      routed_to      TEXT,
      action_code    TEXT,
      action_desc    TEXT,
      steps_json     TEXT DEFAULT '[]',
      created_at     TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(
    `ALTER TABLE journal ADD COLUMN IF NOT EXISTS card_status TEXT`
  ).catch(() => {});
}

// ─── DRP Seed ────────────────────────────────────────────────────────────────
async function seedDRPData() {
  const n = await db.get('SELECT COUNT(*) AS n FROM destination_routing_profiles');
  if (Number(n.n) > 0) return;

  const drp1 = await db.run(`
    INSERT INTO destination_routing_profiles (name, description, dest_route_floor_limit, floor_limit, over_limit_action, under_limit_action)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    ['HISO93_DEST_01','HISO93 Primary Destination Profile', 0.00, 0.00, 'Decline', 'Decline']);

  const drp2 = await db.run(`
    INSERT INTO destination_routing_profiles (name, description, dest_route_floor_limit, floor_limit, over_limit_action, under_limit_action)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    ['VISA_DEST_01','VISA Base-1 Destination Profile', 0.00, 0.00, 'Decline', 'Decline']);

  for (const [rc, at1, at2, cam] of [
    ['RTRN','Savings','Checking','PIN'],
    ['PUR', 'Savings','Checking','PIN'],
    ['WDL', 'Savings','Checking','PIN'],
    ['INQ', 'Savings','Checking','PIN'],
    ['XFER','Savings','Checking','PIN'],
  ]) {
    await db.run(`INSERT INTO routing_config_dest (profile_ref,route_code,account_type_1,account_type_2,cust_auth_method)
      VALUES ($1,$2,$3,$4,$5)`, [drp1.id, rc, at1, at2, cam]);
  }
  for (const [rc, at1, at2, cam] of [
    ['PUR','Savings','Credit','PIN'],
    ['WDL','Savings','Checking','PIN'],
  ]) {
    await db.run(`INSERT INTO routing_config_dest (profile_ref,route_code,account_type_1,account_type_2,cust_auth_method)
      VALUES ($1,$2,$3,$4,$5)`, [drp2.id, rc, at1, at2, cam]);
  }

  for (const [drp, srp, txn, rc] of [
    ['HISO93_DEST_01','ATMDH_ACQRTE',               '**',                            'RTRN'],
    ['HISO93_DEST_01','VISA_SRC',                    '00 (Purchase)',                 'PUR' ],
    ['HISO93_DEST_01','VISA_SRC',                    '01 (Withdrawal/Cash Advance)',  'WDL' ],
    ['HISO93_DEST_01','VISA_SRC',                    '09 (Purchase with Cash back)',  'PUR' ],
    ['HISO93_DEST_01','VISA_SRC',                    '20 (Return)',                   'RTRN'],
    ['HISO93_DEST_01','VISA_SRC',                    '30 (Available Funds Inquiry)',  'INQ' ],
    ['HISO93_DEST_01','VISA_SRC',                    '40 (Transfer)',                 'XFER'],
    ['VISA_DEST_01',  'STAR_SRC',                    '**',                            'PUR' ],
  ]) {
    await db.run(`INSERT INTO dest_src_relationships (dest_routing_profile,src_routing_profile,txn_code,route_code)
      VALUES ($1,$2,$3,$4)`, [drp, srp, txn, rc]);
  }
}

// ─── Seed ────────────────────────────────────────────────────────────────────
async function seedIfEmpty() {
  // Admin user
  const adminExists = await db.get('SELECT id FROM users WHERE username=$1', ['admin']);
  if (!adminExists) {
    const hash = await bcrypt.hash('Admin123!', 10);
    await db.run(
      `INSERT INTO users (username, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
      ['admin', 'admin@mobilpymes.local', hash, 'admin']);
    console.log('Usuario admin creado: admin / Admin123!');
  }

  // Always seed DRP demo data if table is empty (handles upgrades too)
  await seedDRPData();

  const count = await db.get('SELECT COUNT(*) AS n FROM institutions');
  if (Number(count.n) > 0) return;

  // ── Institutions ─────────────────────────────────────────────────────────
  const bnk1 = await db.run(`
    INSERT INTO institutions (institution_id, institution_number, institution_name, issuer_type,
      addr_line1, city, country, postal_code, state_province, timezone, currency_code,
      cutover_time, status_msg)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    ['BNK1','10000000123','FIRSTSTATEBANK','Institution',
     '100 Main Street','Omaha','US','68102','NE','CST','840',
     '12:00 am','2 - Successful view of Institution ID BNK1.']);

  const pcba = await db.run(`
    INSERT INTO institutions (institution_id, institution_number, institution_name, issuer_type,
      addr_line1, city, country, postal_code, state_province, timezone, currency_code,
      cutover_time, status_msg)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    ['PCBA_INST','20000000456','POS CARD INSTITUTION','Institution',
     '55 Market Ave','Dallas','US','75201','TX','CST','840',
     '12:00 am','2 - Successful view of Institution ID PCBA_INST.']);

  await db.run(
    'INSERT INTO contacts (institution_ref, contact, phone, email, comments) VALUES ($1,$2,$3,$4,$5)',
    [bnk1.id,'Operations Desk','+1 402 555 0100','ops@firststatebank.example','Primary contact']);

  await db.run(
    'INSERT INTO contacts (institution_ref, contact, phone, email, comments) VALUES ($1,$2,$3,$4,$5)',
    [pcba.id,'Help Desk','+1 214 555 0200','help@pcba.example','24x7 Support']);

  // ── Hosts ─────────────────────────────────────────────────────────────────
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

  await db.run(`
    INSERT INTO hosts (interface_name, kind, cutover_time, settlement_days, source_routing_profile,
      acquirer_txn_profile, issuer_txn_profile, context_profile, iso_message_profile, action_code_profile)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    ['MASTERCARD_BNET','Interchange','12:00 am','7-Day','STAR_SRC',
     'QA_ACQ_TXN','QA_ISS_ALL','CTX_MC','MSG_MC','ACT_CDE_MC']);

  // ── Prefixes ──────────────────────────────────────────────────────────────
  for (const [p, l, i, t, r, drp] of [
    ['160107',16,'PCBA_INST','On-Us',     'Acquirer and Issuer', null],
    ['510510',16,'BNK1',     'On-Us',     'Acquirer and Issuer', null],
    ['400000',16,'BNK1',     'Not-On-Us', 'Acquirer and Issuer', 'VISA_BASE1'],
    ['222100',16,'PCBA_INST','Not-On-Us', 'Issuer only',         'MASTERCARD_BNET'],
  ]) {
    await db.run(
      `INSERT INTO prefixes (prefix,pan_length,issuer_id,prefix_type,route_type,destination_routing_profile)
       VALUES ($1,$2,$3,$4,$5,$6)`, [p,l,i,t,r,drp]);
  }

  // ── Limit Profiles ────────────────────────────────────────────────────────
  await db.run(
    `INSERT INTO limit_profiles (name,description,currency_code,min_amount,max_amount_per_txn,daily_amount_limit,daily_count_limit,period_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['LMT_STD','Standard ATM/POS limits','USD',1,500,2000,10,'Rolling Daily']);
  await db.run(
    `INSERT INTO limit_profiles (name,description,currency_code,min_amount,max_amount_per_txn,daily_amount_limit,daily_count_limit,period_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['LMT_VIP','High-value cardholder limits','USD',1,5000,20000,40,'Rolling Daily']);
  await db.run(
    `INSERT INTO limit_profiles (name,description,currency_code,min_amount,max_amount_per_txn,daily_amount_limit,daily_count_limit,period_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['LMT_POS','POS Purchase limits','USD',0.01,2000,5000,25,'Rolling Daily']);
  await db.run(
    `INSERT INTO limit_profiles (name,description,currency_code,min_amount,max_amount_per_txn,daily_amount_limit,daily_count_limit,period_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['LMT_INTL','International transaction limits','USD',1,1000,3000,8,'Rolling Daily']);

  // ── Routing Profiles ──────────────────────────────────────────────────────
  const src = await db.run(
    'INSERT INTO routing_profiles (name,description) VALUES ($1,$2) RETURNING id',
    ['STAR_SRC','Main Source Routing Profile — evaluates all card types and instruments']);

  for (const [seq, dest, issuer, txn, lmt, instr, rt] of [
    [1,'STAR_HOST',    'PCBA_INST','Any',                'LMT_STD', 'ATM',         'Acquirer & Issuer'],
    [2,'VISA_BASE1',   'BNK1',     'Purchase',           'LMT_POS', 'POS',         'Acquirer & Issuer'],
    [3,'MASTERCARD_BNET','',       'Any',                'LMT_INTL','Interchange', 'Acquirer & Issuer'],
    [4,'VISA_BASE1',   '',         'Any',                'LMT_VIP', 'Any',         'Acquirer & Issuer'],
  ]) {
    await db.run(`
      INSERT INTO routing_destinations (profile_ref,seq,destination_routing_profile,issuer_id,
        txn_code,limit_profile,issuer_surcharge_profile,instrument_type,route_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [src.id,seq,dest,issuer,txn,lmt,'',instr,rt]);
  }

  // ── Cards (On-Us cards for demo) ─────────────────────────────────────────
  const cards = [
    ['1601070000001234','JOHN DOE',      '1228','Debit',  'Active', 'PCBA_INST','LMT_STD', 'Savings','Checking'],
    ['1601070000005678','JANE SMITH',    '0927','Debit',  'Active', 'PCBA_INST','LMT_VIP', 'Savings','Checking'],
    ['1601070000009999','BOB BLOCKED',   '0626','Debit',  'Blocked','PCBA_INST','LMT_STD', 'Savings','Checking'],
    ['5105100000001234','ALICE JOHNSON', '1128','Debit',  'Active', 'BNK1',     'LMT_STD', 'Savings','Checking'],
    ['5105100000005678','CARLOS RUIZ',   '0826','Credit', 'Active', 'BNK1',     'LMT_VIP', 'Credit', 'Credit'],
    ['5105100000009012','DIANA EXPIRED', '0124','Debit',  'Expired','BNK1',     'LMT_STD', 'Savings','Checking'],
  ];
  for (const [pan, name, exp, type, status, issuer, lmt, acc1, acc2] of cards) {
    await db.run(
      `INSERT INTO cards (pan, cardholder_name, expiry_date, card_type, status, issuer_id,
        limit_profile, account_type1, account_type2)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [pan, name, exp, type, status, issuer, lmt, acc1, acc2]);
  }

  // ── Accounts (Positive Balance) ───────────────────────────────────────────
  const acctData = [
    ['SV-16010700001234','1601070000001234','Savings','Active', 1500.00,1500.00,'USD','LMT_STD'],
    ['CK-16010700001234','1601070000001234','Checking','Active',  250.00,  250.00,'USD','LMT_STD'],
    ['SV-16010700005678','1601070000005678','Savings','Active',25000.00,25000.00,'USD','LMT_VIP'],
    ['SV-51051000001234','5105100000001234','Savings','Active',  800.00,  800.00,'USD','LMT_STD'],
    ['CR-51051000005678','5105100000005678','Credit', 'Active', 5000.00, 4750.00,'USD','LMT_VIP'],
  ];
  for (const [aid, pan, atype, st, avail, ledg, cur, lmt] of acctData) {
    await db.run(
      `INSERT INTO accounts (account_id, card_pan, account_type, status,
        available_bal, ledger_bal, currency_code, limit_profile)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [aid, pan, atype, st, avail, ledg, cur, lmt]);
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const ready = initSchema()
  .then(() => seedIfEmpty())
  .catch((err) => console.error('DB init error:', err.message));

module.exports = { db, pool, ready };
