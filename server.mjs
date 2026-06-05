/**
 * affiliate-dashboard — centralized click analytics for all affiliate sites.
 * Zero dependencies (Node http + NDJSON file store). Basic-auth protected.
 *
 *   POST /collect      ingest a click (token OR allowed-origin)
 *   GET  /api/stats    aggregated JSON (Basic Auth)
 *   POST /api/reset    clear all data   (Basic Auth)
 *   GET  /             dashboard UI     (Basic Auth)
 *   GET  /health       liveness
 *
 * Env: PORT, ADMIN_USER, ADMIN_PASS, INGEST_TOKEN, ALLOWED_ORIGINS, DATA_FILE
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'clicks.ndjson');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

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
    // For server beacons the tracker sends these; for browser beacons we derive from the request UA.
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
async function readClicks() {
  let raw = '';
  try { raw = await fsp.readFile(DATA_FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out;
}
function inc(m, k) { k = k || '(none)'; m[k] = (m[k] || 0) + 1; }
function topN(m, n = 12) { return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v })); }
function pathOf(u) { try { return new URL(u, 'http://x').pathname || '/'; } catch { return u || '(direct)'; } }

function aggregate(rows, { from, to, site, includeBots } = {}) {
  const fromT = from ? Date.parse(from) : -Infinity;
  const toT = to ? Date.parse(to) + 86400000 : Infinity;
  const m = { site: {}, provider: {}, product: {}, page: {}, source: {}, device: {}, browser: {}, os: {}, geo: {}, lang: {}, day: {}, hour: {} };
  const visitors = new Set();
  let total = 0, bots = 0;
  const recent = [];
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (t < fromT || t > toT) continue;
    if (site && r.site !== site) continue;
    if (r.is_bot && !includeBots) { bots++; continue; }
    total++;
    if (r.visitor) visitors.add(r.visitor);
    inc(m.site, r.site); inc(m.provider, r.provider); inc(m.product, `${r.provider}/${r.product}`);
    inc(m.page, r.source_page ? pathOf(r.source_page) : (r.source || '(direct)'));
    inc(m.source, r.source || (r.source_page ? new URL(r.source_page, 'http://x').hostname : '(direct)'));
    inc(m.device, r.device); inc(m.browser, r.browser); inc(m.os, r.os);
    inc(m.geo, r.geo); inc(m.lang, r.language);
    inc(m.day, r.ts.slice(0, 10)); inc(m.hour, String(new Date(r.ts).getUTCHours()).padStart(2, '0'));
    recent.push(r);
  }
  recent.reverse();
  return {
    total, uniqueVisitors: visitors.size, bots,
    sites: topN(m.site, 50), providers: topN(m.provider), products: topN(m.product),
    pages: topN(m.page), sources: topN(m.source), devices: topN(m.device), browsers: topN(m.browser),
    os: topN(m.os), geo: topN(m.geo), languages: topN(m.lang),
    byDay: Object.entries(m.day).sort().map(([k, v]) => ({ key: k, count: v })),
    byHour: Array.from({ length: 24 }, (_, i) => { const k = String(i).padStart(2, '0'); return { key: k, count: m.hour[k] || 0 }; }),
    recent: recent.slice(0, 150),
  };
}
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => resolve(d)); });
}

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
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/stats') {
      if (!requireAuth(req, res)) return;
      const data = aggregate(await readClicks(), {
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        site: url.searchParams.get('site') || undefined,
        includeBots: url.searchParams.get('bots') === '1',
      });
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(data));
    }
    if (url.pathname === '/') {
      if (!requireAuth(req, res)) return;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE);
    }
    res.writeHead(404); res.end('not found');
  } catch { res.writeHead(500); res.end('error'); }
});
server.listen(PORT, () => console.log(`affiliate-dashboard on :${PORT} (data: ${DATA_FILE})`));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Affiliate Analytics</title>
<style>
:root{
  --bg:#0b0e14;--bg2:#0f131c;--card:#141925;--card2:#1a2030;--line:#222a3a;--line2:#2c3650;
  --txt:#eef2f8;--mut:#8a94a8;--mut2:#5c6678;--acc:#6ea8ff;--acc2:#9b8cff;
  --green:#36d399;--amber:#f5c518;--red:#f87272;--grad:linear-gradient(90deg,#6ea8ff,#9b8cff);
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 700px at 80% -10%,#16203a 0%,var(--bg) 55%),var(--bg);color:var(--txt);
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--acc)}
header{position:sticky;top:0;z-index:10;display:flex;gap:14px;align-items:center;flex-wrap:wrap;
  padding:14px 26px;background:rgba(11,14,20,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:16px;letter-spacing:.02em}
.brand .dot{width:11px;height:11px;border-radius:50%;background:var(--grad);box-shadow:0 0 14px #6ea8ff88}
.sp{flex:1}
.ctrl{display:flex;align-items:center;gap:8px;color:var(--mut)}
select,button{font:inherit;color:var(--txt);background:var(--card2);border:1px solid var(--line2);border-radius:10px;padding:8px 12px;cursor:pointer}
.seg{display:flex;background:var(--card2);border:1px solid var(--line2);border-radius:10px;overflow:hidden}
.seg button{border:0;border-radius:0;background:transparent;padding:8px 12px;color:var(--mut)}
.seg button.on{background:var(--grad);color:#0b0e14;font-weight:700}
button.danger{background:transparent;border-color:#5a2230;color:#f8a0a0}
button.danger:hover{background:#2a121a}
main{max-width:1280px;margin:0 auto;padding:24px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin-bottom:20px}
.kpi{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:18px;padding:18px 20px;position:relative;overflow:hidden}
.kpi::after{content:"";position:absolute;right:-30px;top:-30px;width:90px;height:90px;background:var(--grad);opacity:.07;border-radius:50%}
.kpi .n{font-size:34px;font-weight:800;letter-spacing:-.02em}
.kpi .l{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
.kpi .s{color:var(--mut2);font-size:12px;margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.grid.three{grid-template-columns:repeat(3,1fr)}
@media(max-width:900px){.grid,.grid.three{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px 20px;margin-bottom:16px}
.panel h2{font-size:12px;margin:0 0 14px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;display:flex;align-items:center;gap:8px}
.panel h2 .c{margin-left:auto;color:var(--mut2);font-weight:600}
.bar{display:grid;grid-template-columns:1fr 44px;gap:10px;align-items:center;margin:7px 0}
.bar .t{position:relative;background:#0c1018;border:1px solid var(--line);border-radius:8px;height:26px;overflow:hidden}
.bar .f{position:absolute;inset:0;width:var(--w);background:var(--grad);opacity:.85;border-radius:8px;transition:width .5s}
.bar .lab{position:absolute;left:10px;top:0;line-height:26px;font-size:12.5px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;max-width:88%}
.bar .c{font-variant-numeric:tabular-nums;color:var(--mut);text-align:right;font-size:13px}
.chart{height:150px;display:flex;align-items:flex-end;gap:4px}
.chart .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:3px;min-width:0}
.chart .b{background:var(--grad);border-radius:4px 4px 0 0;min-height:2px;opacity:.85}
.chart .b:hover{opacity:1}
.axis{display:flex;justify-content:space-between;color:var(--mut2);font-size:11px;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
td .pill{background:var(--card2);border:1px solid var(--line2);border-radius:999px;padding:2px 9px;font-size:11px}
.mut{color:var(--mut)} .empty{color:var(--mut2);padding:8px 0}
.scroll{overflow:auto;max-height:420px}
</style></head><body>
<header>
  <div class="brand"><span class="dot"></span> Affiliate Analytics</div>
  <span class="sp"></span>
  <div class="ctrl">Site
    <select id="site"><option value="">All sites</option></select>
  </div>
  <div class="seg" id="range">
    <button data-d="7">7d</button><button data-d="30" class="on">30d</button><button data-d="90">90d</button><button data-d="0">All</button>
  </div>
  <button id="refresh" title="Refresh">↻</button>
  <button class="danger" id="reset" title="Clear all data">Clear data</button>
</header>
<main id="app"><p class="mut">Loading…</p></main>
<script>
const $=s=>document.querySelector(s);
let RANGE=30;
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function bars(items){if(!items||!items.length)return '<div class="empty">No data</div>';const mx=Math.max(...items.map(i=>i.count),1);
  return items.map(i=>'<div class="bar"><div class="t"><div class="f" style="--w:'+(i.count/mx*100)+'%"></div><span class="lab">'+esc(i.key)+'</span></div><span class="c">'+i.count+'</span></div>').join('')}
function panel(title,inner,count){return '<div class="panel"><h2>'+title+(count!=null?'<span class="c">'+count+'</span>':'')+'</h2>'+inner+'</div>'}
function kpi(n,l,s){return '<div class="kpi"><div class="n">'+n+'</div><div class="l">'+l+'</div>'+(s?'<div class="s">'+s+'</div>':'')+'</div>'}
async function load(){
  const p=new URLSearchParams(); const sv=$('#site').value; if(sv)p.set('site',sv);
  if(RANGE>0){const f=new Date(Date.now()-RANGE*864e5).toISOString().slice(0,10);p.set('from',f)}
  const d=await (await fetch('/api/stats?'+p)).json();
  if($('#site').children.length<=1)d.sites.forEach(s=>{const o=document.createElement('option');o.value=o.textContent=s.key;$('#site').appendChild(o)});
  const mx=Math.max(...d.byDay.map(x=>x.count),1);
  const topProv=d.providers[0]?d.providers[0].key:'—';
  $('#app').innerHTML=
    '<div class="kpis">'
    +kpi(d.total.toLocaleString(),'Clicks', RANGE>0?('last '+RANGE+' days'):'all time')
    +kpi(d.uniqueVisitors.toLocaleString(),'Unique visitors')
    +kpi(d.sites.length,'Sites')
    +kpi(topProv,'Top provider')
    +kpi(d.bots.toLocaleString(),'Bot clicks','excluded')
    +'</div>'
    +panel('Clicks over time',
      '<div class="chart">'+d.byDay.map(x=>'<div class="col" title="'+x.key+': '+x.count+'"><div class="b" style="height:'+(x.count/mx*130)+'px"></div></div>').join('')+'</div>'
      +'<div class="axis"><span>'+(d.byDay[0]?d.byDay[0].key:'')+'</span><span>'+(d.byDay.at(-1)?d.byDay.at(-1).key:'')+'</span></div>')
    +'<div class="grid">'
      +panel('By project',bars(d.sites),d.sites.length)
      +panel('By provider',bars(d.providers),d.providers.length)
      +panel('Top products / merchants',bars(d.products))
      +panel('Top landing pages (click source)',bars(d.pages))
      +panel('Traffic source',bars(d.sources))
      +panel('By hour (UTC)',bars(d.byHour))
    +'</div>'
    +'<div class="grid three">'
      +panel('Devices',bars(d.devices))
      +panel('Browsers',bars(d.browsers))
      +panel('Operating system',bars(d.os))
      +panel('Countries',bars(d.geo))
      +panel('Languages',bars(d.languages))
      +panel('&nbsp;','<div class="empty">Conversions/revenue come from each affiliate network\\'s own reporting (GYG has no click-level API).</div>')
    +'</div>'
    +panel('Recent clicks',
      '<div class="scroll"><table><thead><tr><th>Time</th><th>Site</th><th>Provider</th><th>Product</th><th>Device</th><th>Browser</th><th>Country</th><th>From page</th></tr></thead><tbody>'
      +(d.recent.length?d.recent.map(r=>'<tr><td class="mut">'+new Date(r.ts).toLocaleString()+'</td><td>'+esc(r.site)+'</td><td><span class="pill">'+esc(r.provider)+'</span></td><td>'+esc(r.product)+'</td><td>'+esc(r.device)+'</td><td>'+esc(r.browser)+'</td><td>'+esc(r.geo||'—')+'</td><td class="mut">'+esc(r.source_page?new URL(r.source_page,'http://x').pathname:'')+'</td></tr>').join(''):'<tr><td colspan="8" class="empty">No clicks yet</td></tr>')
      +'</tbody></table></div>',d.recent.length);
}
$('#site').onchange=load; $('#refresh').onclick=load;
document.querySelectorAll('#range button').forEach(b=>b.onclick=()=>{document.querySelectorAll('#range button').forEach(x=>x.classList.remove('on'));b.classList.add('on');RANGE=+b.dataset.d;load()});
$('#reset').onclick=async()=>{if(!confirm('Clear ALL collected click data? This cannot be undone.'))return;await fetch('/api/reset',{method:'POST'});load()};
load();
</script></body></html>`;
