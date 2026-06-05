/**
 * affiliate-dashboard — centralized click analytics for all affiliate sites.
 * Zero dependencies (Node http + an NDJSON file store). Basic-auth protected.
 *
 *   POST /collect      ingest a click  (header: x-ingest-token: $INGEST_TOKEN)
 *   GET  /api/stats    aggregated JSON (Basic Auth)
 *   GET  /             dashboard UI    (Basic Auth)
 *   GET  /health       liveness        (open)
 *
 * Env: PORT, ADMIN_USER, ADMIN_PASS, INGEST_TOKEN, DATA_FILE (default data/clicks.ndjson)
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'clicks.ndjson');

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

const eq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function checkBasicAuth(req) {
  if (!ADMIN_PASS) return true; // no pass configured → open (dev only)
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return eq(u, ADMIN_USER) && eq(p, ADMIN_PASS);
}

function requireAuth(req, res) {
  if (checkBasicAuth(req)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Affiliate Dashboard"' });
  res.end('Authentication required');
  return false;
}

async function appendClick(ev) {
  const row = {
    ts: new Date().toISOString(),
    site: ev.site || '',
    provider: ev.affiliate_provider || ev.provider || '',
    product: ev.affiliate_product || ev.product || '',
    link_domain: ev.link_domain || '',
    source_page: ev.source_page || '',
    source: ev.source || '',
    medium: ev.medium || '',
    campaign: ev.campaign || '',
    geo: ev.geo_country || '',
    click_id: ev.click_id || '',
  };
  await fsp.appendFile(DATA_FILE, JSON.stringify(row) + '\n');
  return row;
}

async function readClicks() {
  let raw = '';
  try { raw = await fsp.readFile(DATA_FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function inc(map, key) { if (!key) key = '(none)'; map[key] = (map[key] || 0) + 1; }
function topN(map, n = 10) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
}

function aggregate(rows, { from, to, site } = {}) {
  const fromT = from ? Date.parse(from) : -Infinity;
  const toT = to ? Date.parse(to) + 86400000 : Infinity; // inclusive day
  const bySite = {}, byProvider = {}, byProduct = {}, bySource = {}, byDay = {}, byHour = {}, byGeo = {};
  let total = 0;
  const recent = [];
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (t < fromT || t > toT) continue;
    if (site && r.site !== site) continue;
    total++;
    inc(bySite, r.site);
    inc(byProvider, r.provider);
    inc(byProduct, `${r.provider}/${r.product}`);
    inc(bySource, r.source_page ? new URL(r.source_page, 'http://x').pathname : (r.source || '(direct)'));
    inc(byGeo, r.geo);
    inc(byDay, r.ts.slice(0, 10));
    inc(byHour, String(new Date(r.ts).getUTCHours()).padStart(2, '0'));
    recent.push(r);
  }
  recent.reverse();
  return {
    total,
    sites: topN(bySite, 50),
    providers: topN(byProvider, 50),
    products: topN(byProduct, 15),
    sources: topN(bySource, 15),
    geo: topN(byGeo, 15),
    byDay: Object.entries(byDay).sort().map(([k, v]) => ({ key: k, count: v })),
    byHour: Array.from({ length: 24 }, (_, i) => ({ key: String(i).padStart(2, '0'), count: byHour[String(i).padStart(2, '0')] || 0 })),
    recent: recent.slice(0, 100),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(d));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }

    if (url.pathname === '/collect' && req.method === 'POST') {
      if (INGEST_TOKEN && req.headers['x-ingest-token'] !== INGEST_TOKEN) {
        res.writeHead(403); return res.end('forbidden');
      }
      const body = await readBody(req);
      let ev = {}; try { ev = JSON.parse(body || '{}'); } catch {}
      await appendClick(ev);
      res.writeHead(204); return res.end();
    }

    if (url.pathname === '/api/stats') {
      if (!requireAuth(req, res)) return;
      const rows = await readClicks();
      const data = aggregate(rows, {
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        site: url.searchParams.get('site') || undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    if (url.pathname === '/') {
      if (!requireAuth(req, res)) return;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500); res.end('error');
  }
});

server.listen(PORT, () => console.log(`affiliate-dashboard on :${PORT}  (data: ${DATA_FILE})`));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Affiliate Dashboard</title>
<style>
  :root{--bg:#0e1116;--card:#171b22;--line:#262c36;--txt:#e6e9ef;--mut:#8b94a3;--acc:#5b8cff;--good:#36c98d}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  header{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:16px 22px;border-bottom:1px solid var(--line)}
  h1{font-size:17px;margin:0;font-weight:700}.sp{flex:1}
  select,input{background:var(--card);color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit}
  main{padding:22px;max-width:1180px;margin:0 auto}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:18px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .kpi .n{font-size:30px;font-weight:800}.kpi .l{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
  .panel h2{font-size:13px;margin:0 0 12px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
  .bar{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin:6px 0}
  .bar .t{position:relative;background:#10141b;border-radius:6px;height:22px;overflow:hidden}
  .bar .f{position:absolute;inset:0;width:var(--w);background:linear-gradient(90deg,#3a5bd0,#5b8cff);border-radius:6px}
  .bar .lab{position:absolute;left:8px;top:0;line-height:22px;font-size:12px;white-space:nowrap}
  .bar .c{font-variant-numeric:tabular-nums;color:var(--mut);min-width:38px;text-align:right}
  .spark{display:flex;align-items:flex-end;gap:3px;height:90px}
  .spark div{flex:1;background:linear-gradient(180deg,#5b8cff,#2a3a78);border-radius:3px 3px 0 0;min-height:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
  th{color:var(--mut);font-weight:600}.mut{color:var(--mut)}
</style></head><body>
<header>
  <h1>📊 Affiliate Dashboard</h1>
  <span class="sp"></span>
  <label class="mut">Site <select id="site"><option value="">All</option></select></label>
  <label class="mut">From <input type="date" id="from"></label>
  <label class="mut">To <input type="date" id="to"></label>
</header>
<main id="app"><p class="mut">Loading…</p></main>
<script>
const $=(s)=>document.querySelector(s);
function bars(items,total){if(!items.length)return '<p class="mut">No data</p>';const max=Math.max(...items.map(i=>i.count),1);
  return items.map(i=>'<div class="bar"><div class="t"><div class="f" style="--w:'+(i.count/max*100)+'%"></div><span class="lab">'+esc(i.key)+'</span></div><span class="c">'+i.count+'</span></div>').join('')}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function load(){
  const p=new URLSearchParams();['site','from','to'].forEach(k=>{const v=$('#'+k).value;if(v)p.set(k,v)});
  const d=await (await fetch('/api/stats?'+p)).json();
  // site filter options
  if($('#site').children.length<=1){d.sites.forEach(s=>{const o=document.createElement('option');o.value=o.textContent=s.key;$('#site').appendChild(o)})}
  const sparkMax=Math.max(...d.byDay.map(x=>x.count),1);
  $('#app').innerHTML=
    '<div class="kpis">'
    +kpi(d.total,'Total clicks')
    +kpi(d.sites.length,'Sites')
    +kpi(d.providers.length,'Providers')
    +kpi(d.byDay.length,'Active days')
    +'</div>'
    +'<div class="panel"><h2>Clicks per day</h2><div class="spark">'+d.byDay.map(x=>'<div title="'+x.key+': '+x.count+'" style="height:'+(x.count/sparkMax*100)+'%"></div>').join('')+'</div>'
      +'<div class="mut" style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px"><span>'+(d.byDay[0]?.key||'')+'</span><span>'+(d.byDay.at(-1)?.key||'')+'</span></div></div>'
    +'<div class="grid">'
      +panel('By project (site)',bars(d.sites))
      +panel('By provider',bars(d.providers))
      +panel('Top products',bars(d.products))
      +panel('Top source pages',bars(d.sources))
      +panel('By hour (UTC)',bars(d.byHour))
      +panel('By country',bars(d.geo))
    +'</div>'
    +'<div class="panel"><h2>Recent clicks</h2><table><tr><th>Time</th><th>Site</th><th>Provider</th><th>Product</th><th>From</th><th>Geo</th></tr>'
      +d.recent.map(r=>'<tr><td class="mut">'+new Date(r.ts).toLocaleString()+'</td><td>'+esc(r.site)+'</td><td>'+esc(r.provider)+'</td><td>'+esc(r.product)+'</td><td class="mut">'+esc(r.source_page||'')+'</td><td>'+esc(r.geo||'')+'</td></tr>').join('')
    +'</table></div>';
}
function kpi(n,l){return '<div class="kpi"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
function panel(t,inner){return '<div class="panel"><h2>'+t+'</h2>'+inner+'</div>'}
['site','from','to'].forEach(k=>$('#'+k).addEventListener('change',load));
load();
</script></body></html>`;
