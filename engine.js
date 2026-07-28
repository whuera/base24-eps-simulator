'use strict';

const { db } = require('./db/database');

const ACTION_CODES = {
  '00': 'Approved',
  '05': 'Do not honor',
  '14': 'Invalid card number (no prefix match)',
  '51': 'Insufficient funds',
  '61': 'Exceeds withdrawal amount limit',
  '65': 'Exceeds withdrawal count limit',
  '91': 'Issuer or switch inoperative',
};

async function findPrefix(pan) {
  const rows = await db.all('SELECT * FROM prefixes ORDER BY LENGTH(prefix) DESC');
  return rows.find((r) => pan.startsWith(r.prefix)) || null;
}

async function todayTotals(issuerId) {
  const row = await db.get(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS sum
    FROM journal
    WHERE issuer_id = $1 AND action_code = '00'
      AND created_at::date = CURRENT_DATE`, [issuerId]);
  return { count: Number(row.cnt), sum: Number(row.sum) };
}

async function nextStan() {
  const row = await db.get('SELECT COUNT(*) AS n FROM journal');
  return String((Number(row.n) + 1) % 1000000).padStart(6, '0');
}

async function authorize(txn) {
  const steps = [];
  const pan     = String(txn.pan || '').replace(/\D/g, '');
  const amount  = Number(txn.amount || 0);
  const source  = txn.source || 'ATM';
  const txnType = txn.txn_type || 'Withdrawal';
  const stan    = await nextStan();

  const log = (m) => steps.push(m);
  log(`ACQ: transaccion ${txnType} recibida desde ${source} — PAN ${maskPan(pan)}, monto ${amount.toFixed(2)}`);

  // 1. Prefix lookup
  const prefix = await findPrefix(pan);
  if (!prefix) {
    log('ACQ: no se encontro registro Prefix para el PAN → tarjeta invalida');
    return finalize({ stan, pan, amount, txnType, source,
      prefix_matched: null, issuer_id: null, on_us: 0,
      limit_profile: null, limit_result: 'N/A', routed_to: null,
      action_code: '14', steps });
  }
  log(`PREFIX: coincide "${prefix.prefix}" (len ${prefix.pan_length}) → Issuer ${prefix.issuer_id}, tipo ${prefix.prefix_type}, Route Type ${prefix.route_type}`);

  const onUs = prefix.prefix_type === 'On-Us' ? 1 : 0;
  const issuer = await db.get('SELECT * FROM institutions WHERE institution_id = $1', [prefix.issuer_id]);
  if (issuer) log(`ISS: Issuer resuelto → ${issuer.institution_id} (${issuer.institution_name})`);

  // 2. Route selection via Source Routing Profile (STAR_SRC)
  const profile = await db.get('SELECT * FROM routing_profiles WHERE name = $1', ['STAR_SRC']);
  let dest = null;
  if (profile) {
    const dests = await db.all(
      'SELECT * FROM routing_destinations WHERE profile_ref = $1 ORDER BY seq', [profile.id]);
    dest = dests.find((d) => matchInstrument(d.instrument_type, source) &&
                (!d.issuer_id || d.issuer_id === prefix.issuer_id)) ||
           dests.find((d) => matchInstrument(d.instrument_type, source)) ||
           dests[0] || null;
  }
  const limitName = (dest && dest.limit_profile) || 'LMT_STD';
  const limit = await db.get('SELECT * FROM limit_profiles WHERE name = $1', [limitName]);

  // 3. Limit Profile check
  let limitResult = 'OK';
  if (limit) {
    log(`LIM: aplicando Limit Profile ${limit.name} (max/txn ${limit.max_amount_per_txn}, diario ${limit.daily_amount_limit}, conteo ${limit.daily_count_limit})`);
    const totals = await todayTotals(prefix.issuer_id);
    if (amount < Number(limit.min_amount)) {
      limitResult = 'Monto menor al minimo';
    } else if (amount > Number(limit.max_amount_per_txn)) {
      limitResult = 'Excede limite por transaccion';
      log('LIM: RECHAZO — excede limite por transaccion');
      return finalize({ stan, pan, amount, txnType, source,
        prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
        limit_profile: limitName, limit_result: limitResult, routed_to: null,
        action_code: '61', steps });
    } else if (totals.sum + amount > Number(limit.daily_amount_limit)) {
      limitResult = 'Excede limite diario';
      log('LIM: RECHAZO — excede acumulado diario');
      return finalize({ stan, pan, amount, txnType, source,
        prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
        limit_profile: limitName, limit_result: limitResult, routed_to: null,
        action_code: '61', steps });
    } else if (totals.count + 1 > limit.daily_count_limit) {
      limitResult = 'Excede conteo diario';
      log('LIM: RECHAZO — excede conteo diario de transacciones');
      return finalize({ stan, pan, amount, txnType, source,
        prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
        limit_profile: limitName, limit_result: limitResult, routed_to: null,
        action_code: '65', steps });
    }
    log('LIM: dentro de limites → OK');
  }

  // 4. Routing / authorization
  let routedTo, action;
  if (onUs) {
    routedTo = 'ON-US AUTHORIZER (interno)';
    action = '00';
    log('RTR: transaccion On-Us → autorizador interno del Issuer');
    log('AUT: autorizacion aprobada por el emisor');
  } else if (dest) {
    routedTo = dest.destination_routing_profile;
    const host = await db.get('SELECT * FROM hosts WHERE interface_name = $1', [routedTo]);
    action = host ? '00' : '91';
    log(`RTR: transaccion Not-On-Us → ruteada a destino ${routedTo} (${host ? host.kind : 'destino no configurado'})`);
    log(action === '00' ? 'AUT: respuesta aprobada por el destino externo' : 'AUT: destino inoperativo');
  } else {
    routedTo = null;
    action = '91';
    log('RTR: sin destino disponible en Source Routing Profile → switch inoperativo');
  }

  return finalize({ stan, pan, amount, txnType, source,
    prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
    limit_profile: limitName, limit_result: limitResult, routed_to: routedTo,
    action_code: action, steps });
}

function matchInstrument(instr, source) {
  if (!instr || instr === 'Any') return true;
  return instr.toUpperCase() === String(source).toUpperCase();
}

function maskPan(pan) {
  if (pan.length <= 10) return pan;
  return pan.slice(0, 6) + '*'.repeat(pan.length - 10) + pan.slice(-4);
}

async function finalize(r) {
  const desc = ACTION_CODES[r.action_code] || 'Unknown';
  r.steps.push(`JRNL: transaccion journalizada — Action Code ${r.action_code} (${desc})`);
  const row = await db.run(`
    INSERT INTO journal (stan, pan, amount, txn_type, source, prefix_matched, issuer_id,
      on_us, limit_profile, limit_result, routed_to, action_code, action_desc, steps_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [r.stan, maskPan(r.pan), r.amount, r.txnType, r.source,
     r.prefix_matched, r.issuer_id, r.on_us,
     r.limit_profile, r.limit_result, r.routed_to,
     r.action_code, desc, JSON.stringify(r.steps)]);
  return {
    id: row.id, stan: r.stan, pan: maskPan(r.pan), amount: r.amount,
    txn_type: r.txnType, source: r.source, prefix_matched: r.prefix_matched,
    issuer_id: r.issuer_id, on_us: r.on_us, limit_profile: r.limit_profile,
    limit_result: r.limit_result, routed_to: r.routed_to,
    action_code: r.action_code, action_desc: desc, steps: r.steps,
    approved: r.action_code === '00',
  };
}

module.exports = { authorize, ACTION_CODES };
