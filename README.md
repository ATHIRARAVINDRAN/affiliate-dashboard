# affiliate-dashboard
Centralized affiliate click dashboard (zero-dep Node, Basic-Auth). Deployed on Coolify.
- `POST /collect` (header `x-ingest-token`) — ingest a click from any site's tracker
- `GET /` and `/api/stats` — Basic-Auth dashboard
- Env: `ADMIN_USER`, `ADMIN_PASS`, `INGEST_TOKEN`, `PORT`, `DATA_FILE` (mount /data as a volume)
