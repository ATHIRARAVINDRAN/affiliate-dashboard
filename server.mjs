/**
 * affiliate-dashboard — centralized affiliate analytics for every site.
 * Zero runtime dependencies (Node http + NDJSON/JSON file store). Basic-auth UI.
 *
 *   POST /collect          ingest a click       (ingest token OR allowed-origin)
 *   GET  /api/stats        aggregated JSON       (Basic Auth)
 *   POST /api/import       import GYG CSV export  (Basic Auth; ?dryRun=1 to preview)
 *   GET  /api/config       read goals/targets    (Basic Auth)
 *   POST /api/config       write goals/targets   (Basic Auth)
 *   GET  /api/export       CSV export            (Basic Auth; ?type=clicks|conversions)
 *   POST /api/reset        clear all data        (Basic Auth)
 *   GET  /                 dashboard UI          (Basic Auth)
 *   GET  /health           liveness
 *
 * Conversions/revenue come from CSV import (GetYourGuide has no click-level API).
 * When GA4_MEASUREMENT_ID + GA4_API_SECRET are set, imported conversions are also
 * mirrored to GA4 via the Measurement Protocol so Google is a 2nd source of truth.
 *
 * Env: PORT, ADMIN_USER, ADMIN_PASS, INGEST_TOKEN, ALLOWED_ORIGINS, DATA_FILE,
 *      GA4_MEASUREMENT_ID, GA4_API_SECRET, DEFAULT_CURRENCY
 */
import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'clicks.ndjson');
const DATA_DIR = path.dirname(DATA_FILE);
const CONV_FILE = path.join(DATA_DIR, 'conversions.ndjson');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID || '';
const GA4_API_SECRET = process.env.GA4_API_SECRET || '';
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'EUR';
fs.mkdirSync(DATA_DIR, { recursive: true });

const DASHBOARD_HTML = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'); }
  catch { return '<!doctype html><title>Affiliate Analytics</title><p>dashboard.html missing</p>'; }
})();

/* ─────────────────────────────── auth ─────────────────────────────── */
const eq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
function authed(req) {
  if (!ADMIN_PASS) return true;
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return eq(u, ADMIN_USER) && eq(p, ADMIN_PASS);
}
function requireAuth(req, res) {
  if (authed(req)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Affiliate Dashboard"' });
  res.end('Authentication required');
  return false;
}

/* ───────────────────────── user-agent parsing ─────────────────────── */
function parseUA(ua) {
  ua = ua || '';
  const device = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua) ? 'tablet'
    : /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua) ? 'mobile'
    : ua ? 'desktop' : 'unknown';
  let browser = 'Other';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Version\/.*Safari/.test(ua)) browser = 'Safari';
  let os = 'Other';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';
  const bot = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|monitor|curl|wget/i.test(ua);
  return { device, browser, os, bot };
}

/* ─────────────────────────── click ingestion ──────────────────────── */
async function appendClick(ev, req) {
  const ua = req.headers['user-agent'] || '';
  const fromUA = parseUA(ua);
  const ip = (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
  const row = {
    ts: new Date().toISOString(),
    site: ev.site || '',
    provider: ev.affiliate_provider || ev.provider || '',
    product: ev.affiliate_product || ev.product || '',
    link_url: ev.link_url || '',
    link_domain: ev.link_domain || '',
    source_page: ev.source_page || '',
    source: ev.source || '',
    medium: ev.medium || '',
    campaign: ev.campaign || '',
    term: ev.term || '',
    content: ev.content || '',
    gclid: ev.gclid || '',
    fbclid: ev.fbclid || '',
    geo: ev.geo_country || ev.geo || req.headers['cf-ipcountry'] || '',
    device: ev.device || fromUA.device,
    browser: ev.browser || fromUA.browser,
    os: ev.os || fromUA.os,
    language: (ev.language || (req.headers['accept-language'] || '').split(',')[0] || '').trim(),
    visitor: ev.visitor_id || ev.visitor || (ip ? 'ip:' + ip : ''),
    is_bot: ev.is_bot != null ? Number(ev.is_bot) : (fromUA.bot ? 1 : 0),
  };
  await fsp.appendFile(DATA_FILE, JSON.stringify(row) + '\n');
  return row;
}
async function readNdjson(file) {
  let raw = '';
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out;
}
const readClicks = () => readNdjson(DATA_FILE);
const readConversions = () => readNdjson(CONV_FILE);

async function readConfig() {
  try { return JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8')); }
  catch { return { goalClicks: 0, goalRevenue: 0 }; }
}
async function writeConfig(c) {
  const safe = { goalClicks: Number(c.goalClicks) || 0, goalRevenue: Number(c.goalRevenue) || 0 };
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(safe, null, 2));
  return safe;
}

/* ───────────────────────────── CSV parsing ────────────────────────── */
/** RFC-4180-ish parser: handles quotes, embedded commas/newlines, CRLF. */
function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignore */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
/** Parse a numeric cell that may carry currency symbols & EU/US separators. */
function parseNum(s) {
  if (s == null) return 0;
  let t = String(s).replace(/[^0-9.,-]/g, '').trim();
  if (!t) return 0;
  const hasC = t.includes(','), hasD = t.includes('.');
  if (hasC && hasD) { // last separator is the decimal one
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (hasC) { // comma only → decimal if it looks like one, else thousands
    t = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}
const COLMAP = {
  date: /date|day|month|period/i,
  product: /activity|product|tour|experience|title|name|offer/i,
  bookings: /booking|order|sale(?!s amount)|conversion|qty|quantit|units?\b/i,
  revenue: /revenue|turnover|gmv|sales amount|booking value|gross|total value|order value/i,
  commission: /commission|earning|payout|income|net|reward/i,
  currency: /currency|ccy/i,
  clicks: /click/i,
};
function mapColumns(header) {
  const idx = {};
  header.forEach((h, i) => {
    for (const [key, re] of Object.entries(COLMAP)) {
      if (idx[key] == null && re.test(h)) idx[key] = i;
    }
  });
  return idx;
}
function normalizeDate(s) {
  if (!s) return '';
  const t = s.trim();
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/); // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/); // DD-MM-YYYY (GYG/EU default)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{4})[-/](\d{1,2})$/); // YYYY-MM
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-01`;
  const d = Date.parse(t);
  return Number.isNaN(d) ? '' : new Date(d).toISOString().slice(0, 10);
}
/** Parse a GYG-style CSV export into normalized conversion rows. */
function parseConversionCsv(text, { provider, site }) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { rows: [], columns: {}, header: rows[0] || [] };
  const header = rows[0].map((h) => h.trim());
  const idx = mapColumns(header);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k) => (idx[k] != null ? r[idx[k]] : '');
    const bookings = idx.bookings != null ? Math.round(parseNum(get('bookings'))) : 1;
    const revenue = parseNum(get('revenue'));
    const commission = idx.commission != null ? parseNum(get('commission')) : 0;
    const date = normalizeDate(get('date'));
    const product = (get('product') || '').trim();
    if (!date && !product && !revenue && !commission) continue;
    out.push({
      date: date || new Date().toISOString().slice(0, 10),
      site: site || '',
      provider: provider || 'getyourguide',
      product,
      bookings: bookings || (revenue || commission ? 1 : 0),
      revenue, commission,
      currency: (get('currency') || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY,
      imported_at: new Date().toISOString(),
    });
  }
  const matched = Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, header[i]]));
  return { rows: out, columns: matched, header };
}

/* ───────────────────── GA4 measurement-protocol mirror ─────────────── */
function mirrorToGA4(convRows) {
  if (!GA4_MEASUREMENT_ID || !GA4_API_SECRET || !convRows.length) return;
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(GA4_API_SECRET)}`;
  for (const c of convRows) {
    try {
      const body = JSON.stringify({
        client_id: `${Math.floor(Math.random() * 1e10)}.${Math.floor(Date.parse(c.date) / 1000) || Math.floor(Date.now() / 1000)}`,
        events: [{
          name: 'affiliate_conversion',
          params: {
            value: c.commission || c.revenue || 0, currency: c.currency,
            affiliate_provider: c.provider, affiliate_product: c.product || '(unknown)',
            site: c.site || '', bookings: c.bookings, source: 'gyg_import', engagement_time_msec: 1,
          },
        }],
      });
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {});
    } catch {}
  }
}

/* ───────────────────────────── aggregation ────────────────────────── */
function inc(m, k, by = 1) { k = k || '(none)'; m[k] = (m[k] || 0) + by; }
function topN(m, n = 12) { return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v })); }
function pathOf(u) { try { return new URL(u, 'http://x').pathname || '/'; } catch { return u || '(direct)'; } }
const pct = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Tally clicks within a window → {total, unique, bots, byDayClicks, byProvider}. */
function clickWindow(rows, fromT, toT, site) {
  let total = 0, bots = 0; const visitors = new Set(); const byDay = {}; const byProvider = {};
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (t < fromT || t >= toT) continue;
    if (site && r.site !== site) continue;
    if (r.is_bot) { bots++; continue; }
    total++;
    if (r.visitor) visitors.add(r.visitor);
    inc(byDay, r.ts.slice(0, 10));
    inc(byProvider, r.provider || '(none)');
  }
  return { total, unique: visitors.size, bots, byDay, byProvider };
}
/** Tally conversions within a window → totals + per-provider/day/product. */
function convWindow(rows, fromT, toT, site) {
  let bookings = 0, revenue = 0, commission = 0; let currency = DEFAULT_CURRENCY;
  const byDay = {}, byProvider = {}, byProduct = {}; const provRev = {}, provComm = {};
  for (const c of rows) {
    const t = Date.parse(c.date);
    if (Number.isNaN(t) || t < fromT || t >= toT) continue;
    if (site && c.site && c.site !== site) continue;
    bookings += c.bookings || 0; revenue += c.revenue || 0; commission += c.commission || 0;
    if (c.currency) currency = c.currency;
    inc(byDay, c.date, c.bookings || 0);
    inc(byProvider, c.provider || '(none)', c.bookings || 0);
    inc(provRev, c.provider || '(none)', c.revenue || 0);
    inc(provComm, c.provider || '(none)', c.commission || 0);
    if (c.product) { inc(byProduct, c.product, c.bookings || 0); }
  }
  return { bookings, revenue: round2(revenue), commission: round2(commission), currency, byDay, byProvider, byProduct, provRev, provComm };
}

function aggregate(clicks, conversions, { from, to, site, includeBots } = {}) {
  const now = Date.now();
  const fromT = from ? Date.parse(from) : -Infinity;
  const toT = to ? Date.parse(to) + 86400000 : now + 86400000;
  const spanFinite = Number.isFinite(fromT);
  const span = spanFinite ? (toT - fromT) : 0;
  const prevFromT = spanFinite ? fromT - span : -Infinity;
  const prevToT = spanFinite ? fromT : -Infinity;

  // segment maps (current window, bots excluded unless includeBots)
  const m = { site: {}, provider: {}, product: {}, page: {}, source: {}, device: {}, browser: {}, os: {}, geo: {}, lang: {} };
  const byHour = {}; const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const visitors = new Set(); let total = 0, bots = 0; const recent = []; const byDayClicks = {};
  for (const r of clicks) {
    const t = Date.parse(r.ts);
    if (t < fromT || t >= toT) continue;
    if (site && r.site !== site) continue;
    if (r.is_bot && !includeBots) { bots++; continue; }
    total++;
    if (r.visitor) visitors.add(r.visitor);
    inc(m.site, r.site); inc(m.provider, r.provider); inc(m.product, `${r.provider}/${r.product}`);
    inc(m.page, r.source_page ? pathOf(r.source_page) : (r.source || '(direct)'));
    inc(m.source, r.source || (r.source_page ? (() => { try { return new URL(r.source_page).hostname; } catch { return '(direct)'; } })() : '(direct)'));
    inc(m.device, r.device); inc(m.browser, r.browser); inc(m.os, r.os);
    inc(m.geo, r.geo); inc(m.lang, r.language);
    inc(byDayClicks, r.ts.slice(0, 10));
    const d = new Date(r.ts); inc(byHour, String(d.getUTCHours()).padStart(2, '0'));
    heat[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++; // Mon-first
    recent.push(r);
  }
  recent.reverse();

  // conversion windows (current + previous)
  const cw = convWindow(conversions, fromT, toT, site);
  const pcw = spanFinite ? convWindow(conversions, prevFromT, prevToT, site) : null;
  const prevClk = spanFinite ? clickWindow(clicks, prevFromT, prevToT, site) : null;
  const hasConversions = conversions.length > 0;

  // day series merging clicks + conversions + revenue
  const allDays = new Set([...Object.keys(byDayClicks), ...Object.keys(cw.byDay)]);
  const byDay = [...allDays].sort().map((k) => ({ key: k, clicks: byDayClicks[k] || 0, conversions: cw.byDay[k] || 0 }));

  // per-provider performance join (clicks ⨝ conversions)
  const provKeys = new Set([...Object.keys(m.provider), ...Object.keys(cw.byProvider)]);
  const providers = [...provKeys].map((k) => {
    const c = m.provider[k] || 0; const conv = cw.byProvider[k] || 0;
    const comm = round2(cw.provComm[k] || 0); const rev = round2(cw.provRev[k] || 0);
    return { key: k, clicks: c, conversions: conv, revenue: rev, commission: comm,
      epc: c ? round2(comm / c) : 0, cr: c ? round2((conv / c) * 100) : 0 };
  }).sort((a, b) => b.clicks - a.clicks);

  const mk = (v, prev) => ({ v: round2(v), prev: prev == null ? null : round2(prev), delta: prev == null ? null : pct(v, prev) });
  const cr = total ? (cw.bookings / total) * 100 : 0;
  const epc = total ? cw.commission / total : 0;
  const epv = visitors.size ? cw.commission / visitors.size : 0;
  const aov = cw.bookings ? cw.revenue / cw.bookings : 0;
  const pTotal = prevClk ? prevClk.total : null;
  const pUnique = prevClk ? prevClk.unique : null;
  const pBook = pcw ? pcw.bookings : null;
  const pRev = pcw ? pcw.revenue : null;
  const pComm = pcw ? pcw.commission : null;
  const pCr = prevClk && prevClk.total ? (pcw.bookings / prevClk.total) * 100 : null;
  const pEpc = prevClk && prevClk.total ? pcw.commission / prevClk.total : null;
  const pAov = pcw && pcw.bookings ? pcw.revenue / pcw.bookings : null;

  const kpis = {
    clicks: mk(total, pTotal), unique: mk(visitors.size, pUnique),
    conversions: mk(cw.bookings, pBook), revenue: mk(cw.revenue, pRev), commission: mk(cw.commission, pComm),
    cr: mk(cr, pCr), epc: mk(epc, pEpc), epv: mk(epv, null), aov: mk(aov, pAov), bots: { v: bots },
  };

  // goals progress (this calendar month)
  const insights = buildInsights({ total, bots, visitors: visitors.size, byHour, heat, m, providers, hasConversions, cr, kpis, currency: cw.currency });

  return {
    range: { from: spanFinite ? from : null, to: to || null, days: spanFinite ? Math.round(span / 86400000) : 0 },
    hasConversions, currency: cw.currency,
    kpis,
    byDay,
    byHour: Array.from({ length: 24 }, (_, i) => { const k = String(i).padStart(2, '0'); return { key: k, count: byHour[k] || 0 }; }),
    heatmap: heat,
    sites: topN(m.site, 50), providers,
    products: topN(m.product), convProducts: topN(cw.byProduct),
    pages: topN(m.page), sources: topN(m.source),
    devices: topN(m.device), browsers: topN(m.browser), os: topN(m.os), geo: topN(m.geo), languages: topN(m.lang),
    insights, recent: recent.slice(0, 150),
  };
}

/** Heuristic, human-readable cues — the "what should I do next" layer. */
function buildInsights({ total, bots, visitors, byHour, heat, m, providers, hasConversions, cr, currency }) {
  const out = [];
  if (!total) { out.push({ severity: 'info', title: 'No clicks yet', text: 'Once your affiliate links get traffic, performance cues will appear here.' }); return out; }
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // conversion rate vs industry benchmark (1–5%)
  if (hasConversions) {
    if (cr >= 5) out.push({ severity: 'good', title: `Conversion rate ${cr.toFixed(1)}%`, text: 'Above the 5% top-quartile benchmark — your traffic is high-intent. Scale the sources feeding it.' });
    else if (cr >= 1) out.push({ severity: 'info', title: `Conversion rate ${cr.toFixed(1)}%`, text: 'Within the healthy 1–5% range. Push toward 5%+ by tightening landing-page → product match.' });
    else out.push({ severity: 'warn', title: `Conversion rate ${cr.toFixed(1)}%`, text: 'Below the 1% benchmark. Check that links point to the most relevant product and that pages set expectations.' });

    // best & leaking provider by EPC / clicks-without-conversions
    const withClicks = providers.filter((p) => p.clicks > 0);
    const best = withClicks.filter((p) => p.epc > 0).sort((a, b) => b.epc - a.epc)[0];
    if (best) out.push({ severity: 'good', title: `Best EPC: ${best.key}`, text: `${currency} ${best.epc.toFixed(2)} per click. Send more traffic here — it earns the most per click.` });
    const median = withClicks.map((p) => p.clicks).sort((a, b) => a - b)[Math.floor(withClicks.length / 2)] || 0;
    const leak = withClicks.filter((p) => p.conversions === 0 && p.clicks >= Math.max(5, median)).sort((a, b) => b.clicks - a.clicks)[0];
    if (leak) out.push({ severity: 'bad', title: `Leak: ${leak.key}`, text: `${leak.clicks} clicks, 0 conversions in range. Re-check the destination link/product or the page's promise.` });
  } else {
    out.push({ severity: 'info', title: 'Add revenue data', text: 'Import your GetYourGuide CSV export to unlock EPC, conversion rate, revenue & ROI (GYG has no click API).' });
  }

  // best window from heatmap
  let bd = 0, bh = 0, bv = -1;
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) if (heat[d][h] > bv) { bv = heat[d][h]; bd = d; bh = h; }
  if (bv > 0) out.push({ severity: 'info', title: 'Peak traffic window', text: `${DOW[bd]} around ${String(bh).padStart(2, '0')}:00 UTC sees the most clicks. Time posts, emails & ad budget to land just before it.` });

  // top landing page share
  const pages = topN(m.page, 1)[0];
  if (pages && pages.count / total >= 0.35) out.push({ severity: 'info', title: 'Concentrated traffic', text: `${Math.round((pages.count / total) * 100)}% of clicks start on “${pages.key}”. It's your workhorse — A/B test its CTA for outsized gains.` });

  // geo concentration
  const geo = topN(m.geo, 1)[0];
  if (geo && geo.key && geo.key !== '(none)' && geo.count / total >= 0.4) out.push({ severity: 'info', title: 'Geo concentration', text: `${Math.round((geo.count / total) * 100)}% of clicks are from ${geo.key}. Localising copy/currency for it could lift conversion.` });

  // bot rate
  const botRate = bots / (total + bots);
  if (botRate >= 0.15) out.push({ severity: 'warn', title: `High bot rate ${(botRate * 100).toFixed(0)}%`, text: 'A large share of traffic is automated (already excluded from KPIs). Worth checking your sources for low-quality referrals.' });

  // device mix
  const dev = topN(m.device, 3); const totalDev = dev.reduce((s, d) => s + d.count, 0) || 1;
  const mobile = (m.device['mobile'] || 0) / totalDev;
  if (mobile >= 0.6) out.push({ severity: 'info', title: 'Mobile-first audience', text: `${Math.round(mobile * 100)}% of clicks are on mobile. Make sure the booking flow & CTA are flawless on small screens.` });

  return out.slice(0, 7);
}

/* ───────────────────────────── CSV export ─────────────────────────── */
function toCSV(rows, cols) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

/* ───────────────────────────── http server ────────────────────────── */
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 8e6) req.destroy(); }); req.on('end', () => resolve(d)); });
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const origin = req.headers['origin'] || '';
  const corsOk = ALLOWED_ORIGINS.includes(origin);
  try {
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }

    if (url.pathname === '/collect' && req.method === 'OPTIONS') {
      res.writeHead(corsOk ? 204 : 403, corsOk ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } : {});
      return res.end();
    }
    if (url.pathname === '/collect' && req.method === 'POST') {
      const tokenOk = INGEST_TOKEN && req.headers['x-ingest-token'] === INGEST_TOKEN;
      if (!tokenOk && !corsOk) { res.writeHead(403); return res.end('forbidden'); }
      if (corsOk) res.setHeader('access-control-allow-origin', origin);
      let ev = {}; try { ev = JSON.parse((await readBody(req)) || '{}'); } catch {}
      await appendClick(ev, req);
      res.writeHead(204); return res.end();
    }

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      await fsp.writeFile(DATA_FILE, '');
      const what = url.searchParams.get('what') || 'all';
      if (what === 'all' || what === 'conversions') { try { await fsp.writeFile(CONV_FILE, ''); } catch {} }
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/import' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const provider = url.searchParams.get('provider') || 'getyourguide';
      const site = url.searchParams.get('site') || '';
      const dryRun = url.searchParams.get('dryRun') === '1';
      const text = await readBody(req);
      const parsed = parseConversionCsv(text, { provider, site });
      if (!parsed.rows.length) return json(res, 400, { ok: false, error: 'No rows parsed. Check the CSV has a header row with date/product/bookings/revenue/commission columns.', header: parsed.header });
      const totals = parsed.rows.reduce((a, r) => ({ bookings: a.bookings + r.bookings, revenue: a.revenue + r.revenue, commission: a.commission + r.commission }), { bookings: 0, revenue: 0, commission: 0 });
      if (dryRun) return json(res, 200, { ok: true, dryRun: true, count: parsed.rows.length, columns: parsed.columns, header: parsed.header, totals: { bookings: totals.bookings, revenue: round2(totals.revenue), commission: round2(totals.commission) }, currency: parsed.rows[0].currency, sample: parsed.rows.slice(0, 8) });
      await fsp.appendFile(CONV_FILE, parsed.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      let mirrored = 0; if (GA4_MEASUREMENT_ID && GA4_API_SECRET) { mirrorToGA4(parsed.rows); mirrored = parsed.rows.length; }
      return json(res, 200, { ok: true, count: parsed.rows.length, columns: parsed.columns, mirroredToGA4: mirrored, totals: { bookings: totals.bookings, revenue: round2(totals.revenue), commission: round2(totals.commission) } });
    }

    if (url.pathname === '/api/config') {
      if (!requireAuth(req, res)) return;
      if (req.method === 'POST') { let b = {}; try { b = JSON.parse(await readBody(req)); } catch {} return json(res, 200, await writeConfig(b)); }
      return json(res, 200, await readConfig());
    }

    if (url.pathname === '/api/export') {
      if (!requireAuth(req, res)) return;
      const type = url.searchParams.get('type') || 'clicks';
      const rows = type === 'conversions' ? await readConversions() : await readClicks();
      const cols = type === 'conversions'
        ? ['date', 'site', 'provider', 'product', 'bookings', 'revenue', 'commission', 'currency']
        : ['ts', 'site', 'provider', 'product', 'source_page', 'source', 'campaign', 'device', 'browser', 'os', 'geo', 'language', 'visitor', 'is_bot'];
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${type}.csv"` });
      return res.end(toCSV(rows, cols));
    }

    if (url.pathname === '/api/stats') {
      if (!requireAuth(req, res)) return;
      const [clicks, conversions, config] = await Promise.all([readClicks(), readConversions(), readConfig()]);
      const data = aggregate(clicks, conversions, {
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        site: url.searchParams.get('site') || undefined,
        includeBots: url.searchParams.get('bots') === '1',
      });
      // month-to-date goal progress (independent of the selected range)
      const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
      const mClk = clickWindow(clicks, monthStart.getTime(), Date.now() + 1, url.searchParams.get('site') || undefined);
      const mConv = convWindow(conversions, monthStart.getTime(), Date.now() + 86400000, url.searchParams.get('site') || undefined);
      data.goals = config;
      data.goalProgress = {
        clicks: { target: config.goalClicks || 0, current: mClk.total, pct: config.goalClicks ? Math.min(100, Math.round((mClk.total / config.goalClicks) * 100)) : null },
        revenue: { target: config.goalRevenue || 0, current: round2(mConv.commission || mConv.revenue), pct: config.goalRevenue ? Math.min(100, Math.round(((mConv.commission || mConv.revenue) / config.goalRevenue) * 100)) : null },
      };
      data.gaMirror = Boolean(GA4_MEASUREMENT_ID && GA4_API_SECRET);
      return json(res, 200, data);
    }

    if (url.pathname === '/') {
      if (!requireAuth(req, res)) return;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(DASHBOARD_HTML);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500); res.end('error'); }
});
server.listen(PORT, () => console.log(`affiliate-dashboard on :${PORT} (data dir: ${DATA_DIR}, GA4 mirror: ${GA4_MEASUREMENT_ID ? 'on' : 'off'})`));
