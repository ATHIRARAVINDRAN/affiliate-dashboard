// Local review only. This module has no network or upload capability.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function csvRecords(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(cell); cell = '';
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else cell += c;
  }
  if (quoted) throw Error('Unclosed CSV quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift() || [];
  if (new Set(header).size !== header.length) throw Error('Duplicate CSV columns');
  return rows.filter((r) => r.some(Boolean)).map((r) => {
    if (r.length !== header.length) throw Error('CSV row length does not match header');
    return Object.fromEntries(header.map((h, i) => [h.trim(), r[i].trim()]));
  });
}

const months = 'January February March April May June July August September October November December'.split(' ');
function orderTimestamp(raw, offset) {
  if (!/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset || '')) return null;
  const m = /^(\w+) (\d{1,2}), (\d{4}), (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!m || !months.includes(m[1])) return null;
  const iso = `${m[3]}-${String(months.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}T${m[4]}:${m[5]}:${m[6]}${offset}`;
  const parsed = Date.parse(iso);
  // Reject dates which JS would silently roll into another month.
  const local = new Date(Date.UTC(+m[3], months.indexOf(m[1]), +m[2]));
  if (local.getUTCDate() !== +m[2] || +m[4] > 23 || +m[5] > 59 || +m[6] > 59 || !Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}
function commissionCents(raw) {
  const match = /^(?:\$|€|£)?\s*(\d+(?:,\d{3})*)(?:\.(\d{1,2}))?$/.exec(raw);
  return match ? +match[1].replaceAll(',', '') * 100 + +(match[2] || '').padEnd(2, '0') : null;
}
const validAdId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(id);

export function reconcileTiqets(orders, clicks = [], { currency, utcOffset, now = Date.now(), site = 'amsterdamairportto.city' } = {}) {
  for (const row of orders) {
    for (const column of ['Status', 'Order ID', 'Basket ID', 'Click ID', 'Ordered At', 'Refund Date', 'Commission']) {
      if (typeof row[column] !== 'string') throw Error(`Missing Tiqets report column: ${column}`);
    }
  }
  const grouped = new Map();
  for (const [i, row] of orders.entries()) {
    const basket = row['Basket ID'] || `missing-basket-row-${i}`;
    if (!grouped.has(basket)) grouped.set(basket, []);
    grouped.get(basket).push(row);
  }
  const candidates = [], blocked = [];
  for (const [basket, inputRows] of grouped) {
    const reasons = new Set();
    // Repeated exports must not double commission. Conflicting versions require review.
    const byOrder = new Map();
    for (const row of inputRows) {
      const id = row['Order ID'];
      if (!id) reasons.add('missing_order_id');
      if (byOrder.has(id) && JSON.stringify(byOrder.get(id)) !== JSON.stringify(row)) reasons.add('conflicting_order_rows');
      byOrder.set(id, row);
    }
    const rows = [...byOrder.values()];
    if (!rows[0]['Basket ID']) reasons.add('missing_basket_id');
    if (rows.some((r) => r.Status !== 'fulfilled' || r['Refund Date'])) reasons.add('unfulfilled_or_refunded');
    const ids = new Set(rows.map((r) => r['Click ID']).filter(Boolean));
    if (rows.some((r) => !r['Click ID'])) reasons.add('missing_click_id');
    if (ids.size > 1) reasons.add('conflicting_click_ids');
    const clickId = ids.size === 1 ? [...ids][0] : '';
    const matches = clicks.filter((c) => c.click_id === clickId && c.provider === 'tiqets' && c.site === site);
    if (matches.length !== 1) reasons.add(matches.length ? 'duplicate_click_id' : 'no_exact_click_match');
    const click = matches.length === 1 ? matches[0] : {};
    const adIdentifiers = Object.fromEntries(['gclid', 'gbraid', 'wbraid'].filter((key) => validAdId(click[key])).map((key) => [key, click[key]]));
    if (!Object.keys(adIdentifiers).length) reasons.add('missing_google_click_id');
    if (Number(click.is_bot)) reasons.add('bot_click');
    if (click.ad_user_data !== 'GRANTED') reasons.add('ad_user_data_consent_not_granted');
    if (!['GRANTED', 'DENIED'].includes(click.ad_personalization)) reasons.add('unknown_ad_personalization_consent');
    if (!Intl.supportedValuesOf('currency').includes(currency)) reasons.add('unconfirmed_currency');
    const symbols = new Set(rows.map((r) => r.Commission.match(/^[$€£]/)?.[0]).filter(Boolean));
    if (symbols.size > 1 || (symbols.has('€') && currency !== 'EUR') || (symbols.has('£') && currency !== 'GBP')
      || (symbols.has('$') && !['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD'].includes(currency))) reasons.add('currency_symbol_mismatch');
    const timestamps = rows.map((r) => orderTimestamp(r['Ordered At'], utcOffset));
    if (timestamps.some((t) => !t)) reasons.add('unconfirmed_order_timezone_or_timestamp');
    const eventTimestamp = timestamps.every(Boolean) ? timestamps.sort().at(-1) : null;
    const clickTime = Date.parse(click.ts);
    if (!Number.isFinite(clickTime)) reasons.add('missing_click_timestamp');
    if (eventTimestamp && (clickTime > Date.parse(eventTimestamp) || Date.parse(eventTimestamp) > now)) reasons.add('invalid_event_chronology');
    if (Number.isFinite(clickTime) && now - clickTime > 90 * 86400000) reasons.add('click_older_than_90_days');
    const amounts = rows.map((r) => commissionCents(r.Commission));
    if (amounts.some((n) => n === null) || amounts.reduce((a, b) => a + b, 0) <= 0) reasons.add('invalid_commission');
    const summary = { basketId: basket, lineItems: rows.length, commission: amounts.every((n) => n !== null) ? amounts.reduce((a, b) => a + b, 0) / 100 : null };
    if (reasons.size) blocked.push({ ...summary, reasons: [...reasons] });
    else candidates.push({ ...summary, event: { transactionId: `tiqets-basket-${basket}`, eventTimestamp,
      conversionValue: summary.commission, currency, adIdentifiers,
      consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: `CONSENT_${click.ad_personalization}` } } });
  }
  return { mode: 'local_review_only', uploadAttempted: false, inputRows: orders.length, baskets: grouped.size, candidates, blocked };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = args.filter((arg) => arg.startsWith('--'));
  const paths = args.filter((arg) => !arg.startsWith('--'));
  const [ordersPath, clicksPath] = paths;
  if (!ordersPath) throw Error('Usage: node reconcile-tiqets.mjs orders.csv [clicks.csv] [--currency=USD] [--utc-offset=+02:00]');
  if (paths.length > 2 || options.some((arg) => !/^--(?:currency|utc-offset|site)=.+$/.test(arg))) throw Error('Unrecognized argument');
  const opts = Object.fromEntries(options.map((value) => { const i = value.indexOf('='); return [value.slice(2, i), value.slice(i + 1)]; }));
  const result = reconcileTiqets(csvRecords(readFileSync(ordersPath, 'utf8')), clicksPath ? csvRecords(readFileSync(clicksPath, 'utf8')) : [], {
    currency: opts.currency, utcOffset: opts['utc-offset'], site: opts.site,
  });
  console.log(JSON.stringify(result, null, 2));
}
