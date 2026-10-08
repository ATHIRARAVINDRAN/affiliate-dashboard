# affiliate-dashboard
Centralized affiliate click dashboard (zero-dep Node, Basic-Auth). Deployed on Coolify.
- `POST /collect` (header `x-ingest-token`) — ingest a click from any site's tracker
- `GET /` and `/api/stats` — Basic-Auth dashboard
- Env: `ADMIN_USER`, `ADMIN_PASS`, `INGEST_TOKEN`, `PORT`, `DATA_FILE` (mount /data as a volume)

## Tiqets → Google Ads preparation (no upload)

The current login/session protection covers `/api/export?type=clicks` and `/api/export?type=conversions`. Click exports now include the exact `click_id`, `gclid`, `gbraid`, `wbraid`, UTC click time and recorded consent fields. Missing consent remains `UNKNOWN`; exports are `Cache-Control: no-store`. Conversion exports preserve Order/Basket/Click IDs, status, raw order timestamp and refund date. Protect downloaded exports as advertising identifiers and delete them after reconciliation.

Google/Facebook ad IDs expire from API responses after `AD_CLICK_RETENTION_DAYS` (default 90, clamped to 1–90). They are redacted from the NDJSON file on startup and once daily using serialized, atomic writes. Aggregate click rows and affiliate join IDs remain. External backups and downloaded exports need their own retention policy. Back up `/data` before deploying; preserve the mounted volume, ingest token and login settings. This migration blanks old ad IDs, so inspect the chosen retention period before rollout.

Run locally with the actual Tiqets order-details CSV and the authenticated click export:

```sh
node reconcile-tiqets.mjs orders.csv clicks.csv --currency=USD --utc-offset=+02:00
```

The currency and offset above are examples: confirm both for the actual report. Split reports across offset changes. Without those values the script reports blockers. It groups package components by Basket ID, deduplicates Order IDs, and values each booking at summed commission, not order value. Missing/ambiguous IDs, refunds, bots, stale clicks, invalid chronology and uncertain consent go to `blocked`; no campaign/time/device matching is attempted. Candidates are local review data, not a complete Google API request, and the script never makes network calls.

The consent gates are deliberately conservative local review rules. Google supports different consent/default treatments depending on the selected API/account setup; these rules are not assertions that every GCLID import technically requires `GRANTED`. Review the applicable settings before changing them; do not upload the internal `UNKNOWN` value as a Google enum.

Actual upload still requires a verified Google Ads conversion action/account, a verified Tiqets click-ID roundtrip, correct report currency/timezone, consent/policy review, a supported ingestion integration, conversion-window checks, an upload ledger and cancellation/restatement handling. For new integrations use [Data Manager](https://developers.google.com/data-manager/api/devguides/events), considering [the legacy endpoint restriction](https://developers.google.com/google-ads/api/docs/conversions/upload-offline). Keep any future commission action secondary until verified. This script does not implement cancellation adjustments or claim the CSV's expected commission has been paid.
