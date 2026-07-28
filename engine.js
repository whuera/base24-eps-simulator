'use strict';

const { db } = require('./db/database');

const ACTION_CODES = {
  '00': 'Approved',
  '05': 'Do Not Honor',
  '14': 'Invalid Card Number — No Prefix Match',
  '41': 'Lost Card, Pick Up',
  '43': 'Stolen Card, Pick Up',
  '51': 'Insufficient Funds',
  '54': 'Expired Card',
  '55': 'Incorrect PIN / PIN Retries Exceeded',
  '61': 'Exceeds Withdrawal Amount Limit',
  '65': 'Exceeds Withdrawal Frequency Limit',
  '91': 'Issuer or Switch Inoperative',
  '96': 'System Malfunction',
};

const TXN_CODES = {
  'Withdrawal'      : 'W',
  'Purchase'        : 'P',
  'Balance Inquiry' : 'B',
  'Transfer'        : 'T',
  'Reversal'        : 'R',
};

// ─── Prefix lookup (longest-prefix-first) ─────────────────────────────────
async function findPrefix(pan) {
  const rows = await db.all('SELECT * FROM prefixes ORDER BY LENGTH(prefix) DESC');
  return rows.find((r) => pan.startsWith(r.prefix)) || null;
}

// ─── Card lookup ─────────────────────────────────────────────────────────────
async function findCard(pan) {
  return db.get('SELECT * FROM cards WHERE pan=$1', [pan]);
}

// ─── Primary account for card ─────────────────────────────────────────────
async function findPrimaryAccount(pan, accountType) {
  // Prefer matching account_type, then first account
  const accts = await db.all(
    'SELECT * FROM accounts WHERE card_pan=$1 AND status=$2 ORDER BY id',
    [pan, 'Active']);
  return accts.find((a) => a.account_type === accountType) || accts[0] || null;
}

// ─── Today's totals for limit check ─────────────────────────────────────────
async function todayTotals(issuerId, cardPan) {
  const params = cardPan
    ? [cardPan]
    : [issuerId];
  const col   = cardPan ? 'pan' : 'issuer_id';
  const row   = await db.get(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS sum
    FROM journal
    WHERE ${col} = $1 AND action_code = '00'
      AND created_at::date = CURRENT_DATE`, params);
  return { count: Number(row.cnt), sum: Number(row.sum) };
}

// ─── STAN generation ─────────────────────────────────────────────────────────
async function nextStan() {
  const row = await db.get('SELECT COALESCE(MAX(CAST(stan AS BIGINT)),0) AS m FROM journal');
  return String((Number(row.m) + 1) % 1000000).padStart(6, '0');
}

// ─── Card expiry check ────────────────────────────────────────────────────
function isExpired(expiryMMYY) {
  if (!expiryMMYY || expiryMMYY.length !== 4) return false;
  const mm = parseInt(expiryMMYY.slice(0, 2), 10);
  const yy = parseInt(expiryMMYY.slice(2), 10) + 2000;
  const now = new Date();
  const expEnd = new Date(yy, mm, 1); // first day of next month after expiry
  return now >= expEnd;
}

// ─── Routing destination matching ────────────────────────────────────────────
function matchDest(dest, source, issuerID, txnCode) {
  const instrOk   = !dest.instrument_type || dest.instrument_type === 'Any'
    || dest.instrument_type.toUpperCase() === (source || '').toUpperCase();
  const issuerOk  = !dest.issuer_id || dest.issuer_id === issuerID;
  const txnCodeOk = !dest.txn_code || dest.txn_code === 'Any'
    || dest.txn_code === txnCode;
  return instrOk && issuerOk && txnCodeOk;
}

// ─── Main authorization engine ────────────────────────────────────────────
async function authorize(txn) {
  const steps   = [];
  const pan     = String(txn.pan  || '').replace(/\D/g, '');
  const amount  = Number(txn.amount || 0);
  const source  = txn.source   || 'ATM';
  const txnType = txn.txn_type || 'Withdrawal';
  const txnCode = TXN_CODES[txnType] || 'W';
  const stan    = await nextStan();

  const log = (m) => steps.push(m);
  log(`[MDACQ] TXN-IN | ${txnType.toUpperCase()} | ${source} | PAN: ${maskPan(pan)} | AMT: ${amount.toFixed(2)}`);

  // ─── 1. PRFX — Prefix lookup ────────────────────────────────────────────
  const prefix = await findPrefix(pan);
  if (!prefix) {
    log(`[PRFX] FAIL — No prefix match for PAN ${maskPan(pan)}`);
    return finalize({ stan, pan, amount, txnType, source, cardStatus: null,
      prefix_matched: null, issuer_id: null, on_us: 0,
      limit_profile: null, limit_result: 'N/A', routed_to: null,
      action_code: '14', steps });
  }
  const onUs = prefix.prefix_type === 'On-Us' ? 1 : 0;
  log(`[PRFX] MATCH "${prefix.prefix}" (len=${prefix.pan_length}) | Issuer: ${prefix.issuer_id} | Type: ${prefix.prefix_type} | RouteType: ${prefix.route_type}`);

  // ─── 2. INST — Resolve institution ──────────────────────────────────────
  const issuer = await db.get('SELECT * FROM institutions WHERE institution_id=$1', [prefix.issuer_id]);
  if (issuer) log(`[INST] Resolved issuer: ${issuer.institution_id} — ${issuer.institution_name}`);

  // ─── 3. ISS / CARD — On-Us card validation ──────────────────────────────
  let card       = null;
  let cardStatus = null;
  let limitName  = 'LMT_STD';

  if (onUs) {
    card = await findCard(pan);
    if (card) {
      cardStatus = card.status;
      limitName  = card.limit_profile || 'LMT_STD';
      log(`[ISS] Card found: ${card.cardholder_name} | Status: ${card.status} | Type: ${card.card_type} | Limit: ${limitName}`);

      // Card status checks
      if (card.status === 'Blocked') {
        log(`[ISS] REJECT — Card is BLOCKED (Do Not Honor)`);
        return finalize({ stan, pan, amount, txnType, source, cardStatus,
          prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
          limit_profile: limitName, limit_result: 'Card Blocked', routed_to: 'INTERNAL IAUT',
          action_code: '05', steps });
      }
      if (card.status === 'Lost') {
        log(`[ISS] REJECT — Card reported LOST — Pick Up`);
        return finalize({ stan, pan, amount, txnType, source, cardStatus,
          prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
          limit_profile: limitName, limit_result: 'Lost Card', routed_to: 'INTERNAL IAUT',
          action_code: '41', steps });
      }
      if (card.status === 'Stolen') {
        log(`[ISS] REJECT — Card reported STOLEN — Pick Up`);
        return finalize({ stan, pan, amount, txnType, source, cardStatus,
          prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
          limit_profile: limitName, limit_result: 'Stolen Card', routed_to: 'INTERNAL IAUT',
          action_code: '43', steps });
      }
      if (card.status === 'Expired' || isExpired(card.expiry_date)) {
        log(`[ISS] REJECT — Card EXPIRED (expiry ${card.expiry_date})`);
        return finalize({ stan, pan, amount, txnType, source, cardStatus: 'Expired',
          prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
          limit_profile: limitName, limit_result: 'Expired Card', routed_to: 'INTERNAL IAUT',
          action_code: '54', steps });
      }

      // PIN retry check (simulated via PIN option on prefix)
      if (txn.wrong_pin) {
        const maxRetry = card.max_pin_retry || prefix.max_pin_retry || 3;
        const newRetries = (card.pin_retries || 0) + 1;
        await db.run('UPDATE cards SET pin_retries=$1 WHERE pan=$2', [newRetries, pan]);
        if (newRetries >= maxRetry) {
          await db.run(`UPDATE cards SET status='Blocked' WHERE pan=$1`, [pan]);
          log(`[ISS] REJECT — PIN retry count (${newRetries}) exceeded max (${maxRetry}). Card BLOCKED.`);
          return finalize({ stan, pan, amount, txnType, source, cardStatus: 'Blocked',
            prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
            limit_profile: limitName, limit_result: 'PIN Retries Exceeded', routed_to: 'INTERNAL IAUT',
            action_code: '55', steps });
        }
        log(`[ISS] REJECT — Incorrect PIN (retry ${newRetries}/${maxRetry})`);
        return finalize({ stan, pan, amount, txnType, source, cardStatus,
          prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
          limit_profile: limitName, limit_result: 'Wrong PIN', routed_to: 'INTERNAL IAUT',
          action_code: '55', steps });
      }

      // For withdrawals: check positive balance
      if (txnType === 'Withdrawal' || txnType === 'Purchase') {
        const acct = await findPrimaryAccount(pan, card.account_type1);
        if (acct) {
          log(`[POSBAL] Account ${acct.account_id} | Available: ${Number(acct.available_bal).toFixed(2)} ${acct.currency_code}`);
          if (Number(acct.available_bal) < amount) {
            log(`[POSBAL] REJECT — Insufficient funds (need ${amount.toFixed(2)}, have ${Number(acct.available_bal).toFixed(2)})`);
            return finalize({ stan, pan, amount, txnType, source, cardStatus,
              prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
              limit_profile: limitName, limit_result: 'Insufficient Funds', routed_to: 'INTERNAL IAUT',
              action_code: '51', steps });
          }
        }
      }
    } else {
      log(`[ISS] No card record on file — applying prefix default limits`);
    }
  }

  // ─── 4. RTR — Routing decision ───────────────────────────────────────────
  let destProfile = null;
  let limitFromDest = null;

  if (onUs) {
    // On-Us → Internal IAUT authorizer
    log(`[RTR] On-Us → Route to INTERNAL IAUT (${prefix.issuer_id})`);
    destProfile = `IAUT:${prefix.issuer_id}`;
  } else if (prefix.route_type === 'Issuer only' && prefix.destination_routing_profile) {
    // Not-On-Us + Issuer Only → use prefix's Destination Routing Profile directly
    destProfile  = prefix.destination_routing_profile;
    log(`[RTR] RouteType=Issuer Only → Destination from Prefix: ${destProfile}`);
  } else {
    // Not-On-Us + Acquirer & Issuer → Source Routing Profile from acquiring host
    // We use the first applicable host's source_routing_profile, or 'STAR_SRC' as default
    const acqHost = await db.get(`SELECT * FROM hosts WHERE source_routing_profile IS NOT NULL ORDER BY id LIMIT 1`);
    const srcProfileName = (acqHost && acqHost.source_routing_profile) || 'STAR_SRC';
    log(`[RTR] RouteType=Acquirer & Issuer → Evaluating Source Routing Profile: ${srcProfileName}`);

    const profile = await db.get('SELECT * FROM routing_profiles WHERE name=$1', [srcProfileName]);
    if (profile) {
      const dests = await db.all(
        'SELECT * FROM routing_destinations WHERE profile_ref=$1 ORDER BY seq', [profile.id]);
      log(`[RTR] Profile has ${dests.length} destination(s) — evaluating in sequence order`);

      const matched = dests.find((d) => matchDest(d, source, prefix.issuer_id, txnCode))
        || dests.find((d) => matchDest(d, source, null, txnCode))
        || dests[0] || null;

      if (matched) {
        destProfile   = matched.destination_routing_profile;
        limitFromDest = matched.limit_profile;
        log(`[RTR] Seq ${matched.seq} matched → Destination: ${destProfile} | Limit: ${limitFromDest || 'none'} | Instrument: ${matched.instrument_type}`);
      } else {
        log(`[RTR] No matching destination in profile ${srcProfileName}`);
      }
    } else {
      log(`[RTR] Source Routing Profile "${srcProfileName}" not found`);
    }
  }

  // ─── 5. LIM — Limit Profile check ───────────────────────────────────────
  if (!onUs && limitFromDest) limitName = limitFromDest;
  const limit = await db.get('SELECT * FROM limit_profiles WHERE name=$1', [limitName]);
  let limitResult = 'OK';

  if (limit && txnType !== 'Balance Inquiry') {
    log(`[LIM] Profile: ${limit.name} | Min: ${limit.min_amount} | Max/txn: ${limit.max_amount_per_txn} | Daily: ${limit.daily_amount_limit} | Count: ${limit.daily_count_limit}`);
    const maskedPan = maskPan(pan);
    const totals = await todayTotals(prefix.issuer_id, onUs ? maskedPan : null);
    log(`[LIM] Today totals: count=${totals.count}, sum=${totals.sum.toFixed(2)}`);

    if (amount < Number(limit.min_amount)) {
      limitResult = `Below minimum (${limit.min_amount})`;
      log(`[LIM] REJECT — Amount below minimum`);
      return finalize({ stan, pan, amount, txnType, source, cardStatus,
        prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
        limit_profile: limitName, limit_result: limitResult, routed_to: destProfile,
        action_code: '05', steps });
    }
    if (amount > Number(limit.max_amount_per_txn)) {
      limitResult = `Exceeds per-txn limit (${limit.max_amount_per_txn})`;
      log(`[LIM] REJECT — Exceeds per-transaction limit`);
      return finalize({ stan, pan, amount, txnType, source, cardStatus,
        prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
        limit_profile: limitName, limit_result: limitResult, routed_to: destProfile,
        action_code: '61', steps });
    }
    if (totals.sum + amount > Number(limit.daily_amount_limit)) {
      limitResult = `Exceeds daily amount (${limit.daily_amount_limit})`;
      log(`[LIM] REJECT — Exceeds daily cumulative amount`);
      return finalize({ stan, pan, amount, txnType, source, cardStatus,
        prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
        limit_profile: limitName, limit_result: limitResult, routed_to: destProfile,
        action_code: '61', steps });
    }
    if (totals.count + 1 > limit.daily_count_limit) {
      limitResult = `Exceeds daily count (${limit.daily_count_limit})`;
      log(`[LIM] REJECT — Exceeds daily transaction count`);
      return finalize({ stan, pan, amount, txnType, source, cardStatus,
        prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
        limit_profile: limitName, limit_result: limitResult, routed_to: destProfile,
        action_code: '65', steps });
    }
    log(`[LIM] PASS — within all limits`);
  }

  // ─── 6. AUT — Authorization ──────────────────────────────────────────────
  let action;
  if (onUs) {
    // Approved by internal IAUT
    action = '00';
    log(`[IAUT] APPROVE — internal issuer authorization OK`);
    // Deduct balance if applicable
    if (card && (txnType === 'Withdrawal' || txnType === 'Purchase')) {
      const acct = await findPrimaryAccount(pan, card.account_type1);
      if (acct) {
        await db.run(
          'UPDATE accounts SET available_bal=$1 WHERE account_id=$2',
          [Number(acct.available_bal) - amount, acct.account_id]);
        log(`[IAUT] Balance updated: ${acct.account_id} → ${(Number(acct.available_bal) - amount).toFixed(2)}`);
      }
      // Reset PIN retries on successful transaction
      if (card.pin_retries > 0) {
        await db.run('UPDATE cards SET pin_retries=0 WHERE pan=$1', [pan]);
      }
    }
  } else {
    // External host lookup
    const host = destProfile && !destProfile.startsWith('IAUT:')
      ? await db.get('SELECT * FROM hosts WHERE interface_name=$1', [destProfile])
      : null;
    if (host) {
      action = '00';
      log(`[AUT] APPROVE — External host "${host.interface_name}" (${host.kind}) responded OK`);
    } else {
      action = '91';
      log(`[AUT] REJECT — Destination host "${destProfile || 'none'}" is inoperative or not found`);
    }
  }

  return finalize({ stan, pan, amount, txnType, source, cardStatus,
    prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
    limit_profile: limitName, limit_result: limitResult, routed_to: destProfile,
    action_code: action, steps });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function maskPan(pan) {
  if (pan.length <= 10) return pan;
  return pan.slice(0, 6) + '*'.repeat(pan.length - 10) + pan.slice(-4);
}

async function finalize(r) {
  const desc = ACTION_CODES[r.action_code] || 'Unknown';
  const approved = r.action_code === '00';
  r.steps.push(`[JRNL] Stan=${r.stan} | AC=${r.action_code} | ${desc} | ${approved ? '✓ APPROVED' : '✗ DECLINED'}`);
  const row = await db.run(`
    INSERT INTO journal (stan, pan, amount, txn_type, source, prefix_matched, issuer_id,
      on_us, card_status, limit_profile, limit_result, routed_to, action_code, action_desc, steps_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [r.stan, maskPan(r.pan), r.amount, r.txnType, r.source,
     r.prefix_matched, r.issuer_id, r.on_us, r.cardStatus,
     r.limit_profile, r.limit_result, r.routed_to,
     r.action_code, desc, JSON.stringify(r.steps)]);
  return {
    id: row.id, stan: r.stan, pan: maskPan(r.pan), amount: r.amount,
    txn_type: r.txnType, source: r.source,
    prefix_matched: r.prefix_matched, issuer_id: r.issuer_id,
    on_us: r.on_us, card_status: r.cardStatus,
    limit_profile: r.limit_profile, limit_result: r.limit_result,
    routed_to: r.routed_to, action_code: r.action_code,
    action_desc: desc, steps: r.steps, approved,
  };
}

module.exports = { authorize, ACTION_CODES, TXN_CODES, maskPan };
