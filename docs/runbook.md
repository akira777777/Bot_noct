# Bot Noct Runbook

## Purpose

Operational guidance for deployment verification, incident triage, rollback, and data recovery.

## Standard Deployment Verification

Run before or immediately after deployment:

- `npm test`
- `npm run smoke:api`
- `npm run build:web`

Then verify:

- `GET /healthz` returns `200`
- `GET /api/catalog` returns `{ ok: true }`
- if `BOT_ENABLED=true`, Telegram `/start` works and one request can be created

## Post-Deploy Smoke

- API:
  - `GET /api/catalog`
  - `GET /api/admin/leads` with `X-Api-Key`
- Dashboard:
  - admin page loads
  - requests list renders
- Bot:
  - client opens menu
  - request flow reaches confirm
  - admin receives request notification
- Observability:
  - request logs contain `requestId`, status, and duration

## Incident Triage

1. Check deploy status and recent logs.
2. Check `/healthz`.
3. If API is failing:
   - inspect `requestId`
   - identify failing route and payload shape
4. If Telegram is failing:
   - inspect bot startup/runtime logs
   - verify token and delivery mode
5. If issue is user-facing and active, rollback first.

## Queue Rate Limits (Burst Control)

Configured Bull queue limits (applied via queue `limiter`):

- `messages`: max **30** jobs per **1000 ms**
- `webhooks`: max **100** jobs per **1000 ms**
- `notifications`: max **50** jobs per **1000 ms**

Operational note: spikes above these values are queued and drained at the configured rate; this is expected and not an incident by itself.

## Common Failure Modes

- Missing `BOT_TOKEN` with `BOT_ENABLED=true`
- `TELEGRAM_DELIVERY_MODE=webhook` without a usable `WEBHOOK_DOMAIN`
- missing `API_SECRET` in production causing admin HTTP API to fail closed
- Redis unavailable, causing cache/queue fallback or degraded background processing

## Rollback Procedure

1. Roll back application code or container image.
2. Re-check:
   - `/healthz`
   - `/api/catalog`
   - Telegram `/start` if bot mode is enabled
3. If data recovery is required:
   - `npm run backup`
   - `npm run restore-check`
   - restore the SQLite file used by `DB_PATH`
4. Re-run a smoke request through the system.

## Backup and Restore Drill

Create backup:

```bash
npm run backup
```

Verify integrity:

```bash
npm run restore-check
```

Recovery drill:

1. Stop the app
2. Replace the DB file at `DB_PATH` with a verified backup
3. Start the app
4. Validate:
   - dialogs exist
   - requests exist
   - canonical statuses render as expected

## Severity Guidance

- P1: service unavailable, cannot create requests, admin API unavailable unexpectedly
- P2: one major flow degraded, including Telegram delivery failures or callback actions failing
- P3: non-blocking UI/copy/reporting issues
