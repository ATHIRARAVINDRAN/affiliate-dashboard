import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverPath = path.join(root, 'server.mjs');

async function freePort() {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startDashboard(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'affiliate-dashboard-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), DATA_FILE: path.join(dir, 'clicks.ndjson'),
      ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password',
      INGEST_TOKEN: 'test-ingest-token', ALLOWED_ORIGINS: '',
      GA4_MEASUREMENT_ID: '', GA4_API_SECRET: '', GA4_SITES: '{}',
      TIQETS_API_TOKEN: '', TIQETS_API_TOKEN_FILE: path.join(dir, 'no-token'),
      ...overrides,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), delay(1000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Dashboard exited during startup: ${stderr}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return { base, dir };
    } catch {}
    await delay(50);
  }
  throw new Error(`Dashboard did not start: ${stderr}`);
}

async function login(base) {
  const response = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'test-admin', password: 'test-password' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, /^affiliate_session=[^;]+;/);
  return setCookie.split(';')[0];
}

async function jsonResponse(base, route, init = {}) {
  const response = await fetch(`${base}${route}`, { redirect: 'manual', ...init });
  const body = await response.json();
  return { response, body };
}

test('login form creates a session that protects the dashboard and API, then logout revokes it', async (t) => {
  const { base } = await startDashboard(t);
  const home = await fetch(base, { redirect: 'manual' });
  assert.equal(home.status, 303);
  assert.equal(home.headers.get('location'), '/login');
  const loginPage = await fetch(`${base}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /name="password"/);
  assert.equal((await jsonResponse(base, '/api/stats')).response.status, 401);

  const wrong = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'test-admin', password: 'wrong' }),
  });
  assert.equal(wrong.status, 303);
  assert.equal(wrong.headers.get('location'), '/login?error=1');
  assert.equal(wrong.headers.get('set-cookie'), null);

  const cookie = await login(base);
  assert.equal((await fetch(base, { headers: { cookie }, redirect: 'manual' })).status, 200);
  assert.equal((await jsonResponse(base, '/api/stats', { headers: { cookie } })).response.status, 200);
  const logout = await fetch(`${base}/logout`, {
    method: 'POST', redirect: 'manual', headers: { cookie, origin: base },
  });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get('location'), '/login');
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.equal((await jsonResponse(base, '/api/stats', { headers: { cookie } })).response.status, 401);
});

test('CSV orders are idempotent and a matching click ID gives exact attribution', async (t) => {
  const { base } = await startDashboard(t);
  const cookie = await login(base);
  const click = await fetch(`${base}/collect`, {
    method: 'POST',
    headers: { 'x-ingest-token': 'test-ingest-token', 'content-type': 'application/json' },
    body: JSON.stringify({ click_id: 'click-001', site: 'example.test', affiliate_provider: 'tiqets',
      affiliate_product: 'canal-tour', source_page: 'https://example.test/guide', campaign: 'paid-guide', gclid: 'ad-001' }),
  });
  assert.equal(click.status, 204);

  const header = 'Order Date,Product,Order ID,Click ID,Bookings,Order Value,Commission,Currency,Status';
  const rows = [
    '2026-10-08,Canal Tour,order-001,click-001,1,100,10,EUR,fulfilled',
    '2026-10-08,Museum,order-002,unknown-click,1,40,2,EUR,fulfilled',
  ];
  const route = '/api/import?provider=tiqets&site=example.test';
  const importCsv = (text) => jsonResponse(base, route, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'text/csv' }, body: text,
  });
  const first = await importCsv([header, ...rows].join('\n'));
  assert.equal(first.response.status, 200);
  assert.equal(first.body.added, 2);
  const again = await importCsv([header, ...rows].join('\n'));
  assert.equal(again.body.added, 0);
  assert.equal(again.body.updated, 0);

  const statsRoute = '/api/stats?site=example.test&from=2026-10-01&to=2026-10-31';
  let stats = (await jsonResponse(base, statsRoute, { headers: { cookie } })).body;
  assert.equal(stats.kpis.conversions.v, 2);
  assert.equal(stats.kpis.commission.v, 12);
  assert.deepEqual(stats.attribution, { exactLinked: 1, count: 2 });
  const linked = stats.bookings.find((row) => row.order_id === 'order-001');
  assert.equal(linked.attribution_status, 'exact');
  assert.equal(linked.click.campaign, 'paid-guide');
  assert.equal(linked.click.gclid, 'ad-001');
  assert.equal(stats.bookings.find((row) => row.order_id === 'order-002').attribution_status, 'unlinked');

  const revised = await importCsv([header, rows[0].replace(',100,10,', ',100,12,'), rows[1]].join('\n'));
  assert.equal(revised.body.added, 0);
  assert.equal(revised.body.updated, 1);
  stats = (await jsonResponse(base, statsRoute, { headers: { cookie } })).body;
  assert.equal(stats.kpis.conversions.v, 2);
  assert.equal(stats.kpis.commission.v, 14);
});

test('Tiqets sync paginates orders, applies refunds, and remains idempotent', async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const backfillStart = new Date(Date.now() - 65 * 86400000).toISOString().slice(0, 10);
  const seen = [];
  const api = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    seen.push({ path: url.pathname, page: url.searchParams.get('page'),
      start: url.searchParams.get('start_date'), end: url.searchParams.get('end_date'),
      pageSize: url.searchParams.get('page_size'), auth: req.headers.authorization });
    if (req.headers.authorization !== 'Token test-tiqets-token') { res.writeHead(401); return res.end(); }
    const order = (id, clickId, value, commission) => ({
      order_reference_id: id, click_id: clickId, product_id: 101,
      order_fulfilled_at: `${today}T10:00:00Z`, currency: 'EUR',
      sale_order_value_incl_vat: value, commission_excl_vat: commission,
    });
    let payload;
    const includesToday = url.searchParams.get('start_date') <= today && url.searchParams.get('end_date') >= today;
    if (!includesToday) {
      payload = { success: true, pagination: { total: 0, page: 1, page_size: 100 },
        [url.pathname.endsWith('/refunds') ? 'refunds' : 'orders']: [] };
    } else if (url.pathname === '/v2/reports/orders') {
      payload = { success: true, pagination: { total: 2, page: Number(url.searchParams.get('page')), page_size: 100 },
        orders: url.searchParams.get('page') === '1'
          ? [order('tiqets-001', 'tiqets-click-001', 100, 10)]
          : [order('tiqets-002', '', 50, 5)] };
    } else if (url.pathname === '/v2/reports/refunds') {
      payload = { success: true, pagination: { total: 1, page: 1, page_size: 100 },
        refunds: [{ order_reference_id: 'tiqets-001', refunded_at: `${today}T12:00:00Z`,
          sale_order_value_incl_vat: -30, commission_excl_vat: -3 }] };
    } else { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const apiPort = api.address().port;
  const { base } = await startDashboard(t, {
    TIQETS_API_TOKEN: 'test-tiqets-token',
    TIQETS_API_BASE_URL: `http://127.0.0.1:${apiPort}/v2`,
    TIQETS_SYNC_START_DATE: backfillStart,
    TIQETS_SITE: 'example.test',
  });
  const cookie = await login(base);
  await fetch(`${base}/collect`, {
    method: 'POST',
    headers: { 'x-ingest-token': 'test-ingest-token', 'content-type': 'application/json' },
    body: JSON.stringify({ click_id: 'tiqets-click-001', site: 'example.test', affiliate_provider: 'tiqets' }),
  });
  const sync = () => jsonResponse(base, '/api/sync/tiqets', { method: 'POST', headers: { cookie, origin: base } });
  const first = await sync();
  assert.equal(first.response.status, 200);
  assert.equal(first.body.orders, 2);
  const second = await sync();
  assert.equal(second.body.added, 0);
  assert.equal(second.body.updated, 0);
  assert.ok(seen.some((call) => call.path === '/v2/reports/orders' && call.page === '2'));
  assert.ok(seen.some((call) => call.path === '/v2/reports/refunds'));
  assert.ok(seen.some((call) => call.start === backfillStart));
  assert.ok(seen.every((call) => (Date.parse(call.end) - Date.parse(call.start)) / 86400000 <= 29));
  assert.ok(seen.every((call) => call.auth === 'Token test-tiqets-token' && call.pageSize === '100' && call.start && call.end));

  const stats = (await jsonResponse(base, `/api/stats?site=example.test&from=${today}&to=${today}`, { headers: { cookie } })).body;
  assert.equal(stats.kpis.conversions.v, 2);
  assert.equal(stats.kpis.revenue.v, 120);
  assert.equal(stats.kpis.commission.v, 12);
  assert.deepEqual(stats.attribution, { exactLinked: 1, count: 2 });
  const refunded = stats.bookings.find((row) => row.order_id === 'tiqets-001');
  assert.equal(refunded.status, 'partially_refunded');
  assert.equal(refunded.revenue, 70);
  assert.equal(refunded.commission, 7);
  assert.equal(refunded.attribution_status, 'exact');
});
