import test from 'node:test';
import assert from 'node:assert/strict';
import { csvRecords, reconcileTiqets } from '../reconcile-tiqets.mjs';

const row = (id, extra = {}) => ({ Status: 'fulfilled', 'Order ID': id, 'Basket ID': 'basket-1', 'Click ID': 'click-1',
  'Ordered At': 'October 7, 2026, 14:45:24', 'Refund Date': '', Commission: '$ 1.17', ...extra });
const click = { click_id: 'click-1', site: 'amsterdamairportto.city', provider: 'tiqets', gclid: 'RealClick_123',
  ts: '2026-10-07T12:00:00Z', ad_user_data: 'GRANTED', ad_personalization: 'DENIED', is_bot: 0 };
const options = { currency: 'USD', utcOffset: '+02:00', now: Date.parse('2026-10-08T00:00:00Z') };

test('parses the actual BOM/quoted Tiqets format and combines package lines once per basket', () => {
  const text = '\uFEFFStatus,Order ID,Basket ID,Click ID,Ordered At,Refund Date,Commission\r\nfulfilled,o1,basket-1,click-1,"October 7, 2026, 14:45:24",,$ 1.17\r\n';
  const parsed = csvRecords(text);
  const rows = [...parsed, row('o2'), row('o3', { Commission: '$ 0.07' }), ...parsed];
  const result = reconcileTiqets(rows, [click], options);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].lineItems, 3);
  assert.deepEqual(result.candidates[0].event, { transactionId: 'tiqets-basket-basket-1', eventTimestamp: '2026-10-07T12:45:24.000Z',
    conversionValue: 2.41, currency: 'USD', adIdentifiers: { gclid: 'RealClick_123' },
    consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' } });
  assert.equal(result.uploadAttempted, false);
});

test('historical rows without click IDs cannot be assigned using campaign or proximity', () => {
  const result = reconcileTiqets([row('o1', { 'Click ID': '', Campaign: 'amsterroute_ads_c1_a2' })], [click], options);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.blocked[0].reasons.includes('missing_click_id'));
  assert.ok(result.blocked[0].reasons.includes('no_exact_click_match'));
});

test('requires consent, currency and an explicit timestamp offset; unknown is never granted', () => {
  const result = reconcileTiqets([row('o1')], [{ ...click, ad_user_data: 'UNKNOWN', ad_personalization: 'UNKNOWN' }]);
  assert.equal(result.candidates.length, 0);
  for (const reason of ['ad_user_data_consent_not_granted', 'unknown_ad_personalization_consent', 'unconfirmed_currency', 'unconfirmed_order_timezone_or_timestamp']) {
    assert.ok(result.blocked[0].reasons.includes(reason), reason);
  }
});

test('rejects refunds, conflicting IDs, bots, stale clicks and invalid chronology', () => {
  const cases = [
    [[row('o1', { 'Refund Date': 'October 8, 2026' })], [click], 'unfulfilled_or_refunded'],
    [[row('o1'), row('o2', { 'Click ID': 'different' })], [click], 'conflicting_click_ids'],
    [[row('o1')], [click, click], 'duplicate_click_id'],
    [[row('o1')], [{ ...click, is_bot: 1 }], 'bot_click'],
    [[row('o1')], [{ ...click, ts: '2026-06-01T00:00:00Z' }], 'click_older_than_90_days'],
    [[row('o1')], [{ ...click, ts: '2026-10-07T13:00:00Z' }], 'invalid_event_chronology'],
    [[row('o1'), row('o1', { Commission: '$ 4.00' })], [click], 'conflicting_order_rows'],
  ];
  for (const [rows, clicks, reason] of cases) {
    const result = reconcileTiqets(rows, clicks, options);
    assert.equal(result.candidates.length, 0);
    assert.ok(result.blocked[0].reasons.includes(reason), reason);
  }
});
