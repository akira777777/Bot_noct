# Bot_noct

Lawful inquiry bot on `Telegraf + Express + SQLite + Next.js`.

The repository keeps the existing API paths and SQLite tables for backward compatibility, but the product domain is now a neutral catalog and request workflow in Russian.

## What It Does

- Telegram bot for catalog browsing, request creation, follow-up questions, and admin replies
- Express API for public catalog access, request creation, tracking, and admin operations
- Next.js dashboard for request management and reporting
- SQLite storage with automatic migrations and default lawful sample catalog
- Optional Redis cache and Bull queues
- Queue burst limits (Bull limiter): `messages` 30 jobs/sec, `webhooks` 100 jobs/sec, `notifications` 50 jobs/sec
- API-only runtime via `BOT_ENABLED=false` for smoke checks, tests, and non-Telegram environments

## Runtime Modes

- `BOT_ENABLED=true` (default): starts the API and Telegram runtime
- `BOT_ENABLED=false`: starts only the API/web stack; bot-only config is skipped

This split is intentional: API, cache, logger, migrations, health checks, and tests must not depend on `BOT_TOKEN`.

## Canonical Request Statuses

- `new`
- `in_progress`
- `called_back`
- `proposal_sent`
- `fulfilled`
- `closed`

Legacy `awaiting_payment` is normalized to `proposal_sent` on reads and updates. Public interfaces keep existing route names for compatibility.

## Commands

```bash
npm start
npm run dev
npm test
npm run lint
npm run smoke:api
npm run build:web
npm run backup
npm run restore-check
```

## Quick Start

```bash
git clone <repo-url>
cd Bot_noct
npm install
npm --prefix web install
cp .env.example .env
npm start
```

For API-only local checks:

```bash
BOT_ENABLED=false npm run smoke:api
```

On Windows PowerShell:

```powershell
$env:BOT_ENABLED='false'
npm run smoke:api
```

## Environment

Base runtime config can load without Telegram secrets:

```env
NODE_ENV=development
BOT_ENABLED=true
PORT=3000
DB_PATH=./data/bot.sqlite
API_SECRET=replace_with_strong_secret
CORS_ORIGIN=
WEB_APP_URL=
API_COMPRESSION=true
REDIS_HOST=localhost
REDIS_PORT=6379
LOG_LEVEL=info
LOG_FORMAT=json
```

Bot-specific variables are only required when `BOT_ENABLED=true`:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_ID=123456789
TELEGRAM_DELIVERY_MODE=polling
WEBHOOK_DOMAIN=
TELEGRAM_STARTUP_TIMEOUT_MS=15000
ALLOW_BOT_LAUNCH_FAILURE=false
```

See [.env.example](.env.example), [DEPLOYMENT.md](DEPLOYMENT.md), and [DEPLOYMENT_PRODUCTION.md](DEPLOYMENT_PRODUCTION.md).

## HTTP API

Public endpoints remain unchanged:

- `GET /api/catalog`
- `POST /api/lead`
- `GET /api/lead/track/:token/status`

Admin endpoints remain under:

- `GET /api/admin/*`
- `PATCH /api/admin/*`

Health endpoints:

- `GET /healthz`
- `GET /readyz`
- `GET /livez`
- `GET /health`

## Architecture

- `index.js`: bootstrap, database, cache, queues, bot runtime, web server, shutdown
- `src/config/env.js`: base runtime config
- `src/config/bot.js`: bot-only config resolver
- `src/db/sqlite.js`: SQLite setup and lawful default seeds
- `src/db/migrations/`: schema and data migrations
- `src/web/server.js`: Express app, health routes, public/admin API
- `src/bot.js`: Telegram handlers and services
- `web/`: Next.js admin dashboard

## Verification Flow

Recommended local verification after changes:

```bash
npm test
npm run smoke:api
npm run lint
npm run build:web
```

For manual QA, use [docs/manual-test-checklist.md](docs/manual-test-checklist.md). For operational recovery and rollback, use [docs/runbook.md](docs/runbook.md).
