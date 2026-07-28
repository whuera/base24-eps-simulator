'use strict';

/*
 * Motor de simulacion de autorizacion/ruteo BASE24-eps (didactico).
 * Reproduce el flujo descrito en los manuales:
 *   1. Acquirer recibe la transaccion (ATM / POS / Interchange).
 *   2. Se extrae el prefijo del PAN y se busca el registro Prefix.
 *   3. Se resuelve el Issuer (Institution) y si es On-Us o Not-On-Us.
 *   4. Se aplica el Limit Profile.
 *   5. Routing: On-Us -> autorizador interno; Not-On-Us -> Source Routing
 *      Profile elige un destino Host/Interchange.
 *   6. Se genera un Action Code y se journaliza.
 */

const db = require('./db/database');

const ACTION_CODES = {
  '00': 'Approved',
  '05': 'Do not honor',
  '14': 'Invalid card number (no prefix match)',
  '51': 'Insufficient funds',
  '61': 'Exceeds withdrawal amount limit',
  '65': 'Exceeds withdrawal count limit',
  '91': 'Issuer or switch inoperative',
};

function findPrefix(pan) {
  const rows = db.prepare('SELECT * FROM prefixes ORDER BY LENGTH(prefix) DESC').all();
  return rows.find((r) => pan.startsWith(r.prefix)) || null;
}

function todayTotals(issuerId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS sum
    FROM journal
    WHERE issuer_id = ? AND action_code = '00'
      AND date(created_at) = date('now')`).get(issuerId);
  return { count: row.cnt, sum: row.sum };
}

function nextStan() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM journal').get().n + 1;
  return String(n % 1000000).padStart(6, '0');
}

/**
 * @param {{pan:string, amount:number, txn_type:string, source:string}} txn
 */
function authorize(txn) {
  const steps = [];
  const pan = String(txn.pan || '').replace(/\D/g, '');
  const amount = Number(txn.amount || 0);
  const source = txn.source || 'ATM';
  const txnType = txn.txn_type || 'Withdrawal';
  const stan = nextStan();

  const log = (m) => steps.push(m);
  log(`ACQ: transaccion ${txnType} recibida desde ${source} — PAN ${maskPan(pan)}, monto ${amount.toFixed(2)}`);

  // 1. Prefix lookup
  const prefix = findPrefix(pan);
  if (!prefix) {
    log('ACQ: no se encontro registro Prefix para el PAN → tarjeta invalida');
    return finalize({ stan, pan, amount, txnType, source,
      prefix_matched: null, issuer_id: null, on_us: 0,
      limit_profile: null, limit_result: 'N/A', routed_to: null,
      action_code: '14', steps });
  }
  log(`PREFIX: coincide "${prefix.prefix}" (len ${prefix.pan_length}) → Issuer ${prefix.issuer_id}, tipo ${prefix.prefix_type}, Route Type ${prefix.route_type}`);

  const onUs = prefix.prefix_type === 'On-Us' ? 1 : 0;
  const issuer = db.prepare('SELECT * FROM institutions WHERE institution_id = ?').get(prefix.issuer_id);
  if (issuer) log(`ISS: Issuer resuelto → ${issuer.institution_id} (${issuer.institution_name})`);

  // 2. Route selection via Source Routing Profile (STAR_SRC)
  const profile = db.prepare('SELECT * FROM routing_profiles WHERE name = ?').get('STAR_SRC');
  let dest = null;
  if (profile) {
    const dests = db.prepare('SELECT * FROM routing_destinations WHERE profile_ref = ? ORDER BY seq').all(profile.id);
    dest = dests.find((d) => matchInstrument(d.instrument_type, source) &&
              (!d.issuer_id || d.issuer_id === prefix.issuer_id)) ||
           dests.find((d) => matchInstrument(d.instrument_type, source)) ||
           dests[0] || null;
  }
  const limitName = (dest && dest.limit_profile) || 'LMT_STD';
  const limit = db.prepare('SELECT * FROM limit_profiles WHERE name = ?').get(limitName);

  // 3. Limit Profile check
  let limitResult = 'OK';
  if (limit) {
    log(`LIM: aplicando Limit Profile ${limit.name} (max/txn ${limit.max_amount_per_txn}, diario ${limit.daily_amount_limit}, conteo ${limit.daily_count_limit})`);
    const totals = todayTotals(prefix.issuer_id);
    if (amount < limit.min_amount) {
      limitResult = 'Monto menor al minimo';
    } else if (amount > limit.max_amount_per_txn) {
      limitResult = 'Excede limite por transaccion';
      log('LIM: RECHAZO — excede limite por transaccion');
      return finalize({ stan, pan, amount, txnType, source,
        prefix_matched: prefix.prefix, issuer_id: prefix.issuer_id, on_us: onUs,
        limit_profile: limitName, limit_result: limitResult, routed_to: null,
        action_code: '61', steps });
    } else if (totals.sum + amount > limit.daily_amount_limit) {
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
    const host = db.prepare('SELECT * FROM hosts WHERE interface_name = ?').get(routedTo);
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

function finalize(r) {
  const desc = ACTION_CODES[r.action_code] || 'Unknown';
  r.steps.push(`JRNL: transaccion journalizada — Action Code ${r.action_code} (${desc})`);
  const info = db.prepare(`INSERT INTO journal
    (stan, pan, amount, txn_type, source, prefix_matched, issuer_id, on_us,
     limit_profile, limit_result, routed_to, action_code, action_desc, steps_json)
    VALUES (@stan,@pan,@amount,@txn_type,@source,@prefix_matched,@issuer_id,@on_us,
     @limit_profile,@limit_result,@routed_to,@action_code,@action_desc,@steps_json)`).run({
    stan: r.stan, pan: maskPan(r.pan), amount: r.amount, txn_type: r.txnType, source: r.source,
    prefix_matched: r.prefix_matched, issuer_id: r.issuer_id, on_us: r.on_us,
    limit_profile: r.limit_profile, limit_result: r.limit_result, routed_to: r.routed_to,
    action_code: r.action_code, action_desc: desc, steps_json: JSON.stringify(r.steps),
  });
  return {
    id: info.lastInsertRowid, stan: r.stan, pan: maskPan(r.pan), amount: r.amount,
    txn_type: r.txnType, source: r.source, prefix_matched: r.prefix_matched,
    issuer_id: r.issuer_id, on_us: r.on_us, limit_profile: r.limit_profile,
    limit_result: r.limit_result, routed_to: r.routed_to,
    action_code: r.action_code, action_desc: desc, steps: r.steps,
    approved: r.action_code === '00',
  };
}

module.exports = { authorize, ACTION_CODES };
