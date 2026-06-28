# Marketing Intelligence Layer (MIL)

In-house marketing data + attribution spine for Eassylife. Ingests Meta + Google
ad spend, joins it against first-party booking conversions, and resolves
deterministic (click-ID) attribution — so "blended cost per first order by
city/category/campaign" is one SQL join. Action/LLM/notification seams are built
now and wired to **dry-run**; the GEO-audit and anomaly/autonomy modules attach
later without spine rework.

> Standalone service. Stack: **Fastify 5 + TypeScript + Drizzle/node-postgres +
> BullMQ 5 + Anthropic SDK**, Postgres schema `marketing`. Multi-tenant on
> `app ∈ {services, society}` (services live now). Modular monolith, files <300 lines.

## Stack & conventions
- ESM (`"type": "module"`), `.js` import specifiers in TS source, strict mode.
- Money is **NUMERIC INR rupees** (no paise), matching the booking source of truth.
- **Migrations are explicit, hand-authored SQL** in `drizzle/`, applied by
  `scripts/migrate.ts`. We never run `drizzle-kit push` / auto-sync.
  `npm run migrate:generate` is a drafting aid only.

## Quick start (local)
```bash
cp .env.example .env            # fill DATABASE_URL, REDIS_URL, the two tokens
docker compose -f docker-compose.dev.yml up -d   # local Postgres+Redis (optional)
npm install
npm run check-env               # fail-fast env validation
npm run migrate                 # apply drizzle/*.sql in order
npm run dev                     # Fastify on :5100, GET /health
npm run typecheck && npm test
```

## Layout
```
src/
  config/env.ts            zod fail-fast env validator (frozen export)
  shared/
    db/                    pg.Pool + drizzle (typed query layer)
    redis/  queue/         ioredis + BullMQ wiring (workers/schedulers)
    logger/  middleware/   pino + service-token bearer guard
    types/                 AppKind tenant type
    schema/marketing/      one Drizzle table per file (typed query layer)
  marketing/{ingest,attribution,actions,context,serving,jobs}/   (phases 1–5)
  notifications/           in-house WhatsApp seam (phase 5)
drizzle/                   hand-authored SQL migrations (source of truth for DB)
scripts/                   migrate.ts (runner), check-env.ts, seed.ts
tests/                     vitest (unit) + Testcontainers (integration/e2e)
```

## Datastore portability (Supabase → E2E)
Nothing uses Supabase-only features. Swapping to E2E managed Postgres is a
`DATABASE_URL` change plus re-running `drizzle/0000_init.sql` (extension + schema).
Always connect via the **direct/session** endpoint, not the transaction pooler.

See the full build plan: `~/.claude/plans/eassy-feature-concurrent-book.md`.
