# Cloning MIL for a new marketplace

MIL is clone-and-configure: standing up a second instance for a different
marketplace is **env config + one documented SQL edit**, no code changes.

Everything tenant-specific is driven by env (see `.env.instance.example`). The
**only** source edit is the DB `CHECK (app IN (...))` list, because a live
Postgres CHECK constraint can't read an env var.

---

## 1. Clone the repo
```bash
git clone <this-repo> mil-<instance>
cd mil-<instance>
cp .env.instance.example .env.production   # then edit every value
```

## 2. Set the per-instance env
Edit `.env.production` (full reference: `.env.instance.example`). The identity knobs:

| Var | Purpose | Example (new instance) |
|-----|---------|------------------------|
| `MIL_INSTANCE_NAME` | docker container/image/volume name in `docker-compose.prod.yml` | `mil-foodco` |
| `MIL_QUEUE_PREFIX` | BullMQ queue namespace — **must be unique if instances share one Redis** | `foodco` |
| `MIL_APP_LIST` | the tenant apps this instance serves (csv) | `foodco` |
| `MIL_DEFAULT_APP` | default app (must be in `MIL_APP_LIST`; defaults to first) | `foodco` |
| `MIL_ENABLED_APPS` | apps to run jobs for (defaults to `[first]`) | `foodco` |
| `MIL_CURRENCY` | asserted at ingest + shown in serving envelope | `USD` |
| `MIL_CRON_TIMEZONE` | scheduler timezone | `America/New_York` |
| `MIL_MARKET_DESCRIPTION` | interpolated into the insights LLM prompt | `US meal-kit marketplace` |

Boot fails fast if `MIL_DEFAULT_APP` / `MIL_ENABLED_APPS` aren't all in `MIL_APP_LIST`.

## 3. Edit the DB CHECK lists (the one SQL edit)
The app allow-list is enforced in Postgres by `CHECK (app IN ('services','society'))`
constraints. Change them to match `MIL_APP_LIST` in **both** migration files
(they run before any data exists, so this is a plain find-and-replace):

- `drizzle/0001_core.sql` — 6 occurrences
- `drizzle/0002_parked.sql` — 3 occurrences

```bash
# Example for MIL_APP_LIST=foodco:
sed -i "s/app IN ('services','society')/app IN ('foodco')/g" \
  drizzle/0001_core.sql drizzle/0002_parked.sql
```
> The Drizzle TS schema (`src/shared/schema/marketing/*`) uses the env-driven
> `appCheck()` helper, so it tracks `MIL_APP_LIST` automatically — no TS edit
> needed. See the NOTE on `appCheck` in `src/shared/schema/marketing/_shared.ts`.

## 4. Migrate
```bash
npm ci
npm run migrate        # applies drizzle/*.sql in order (idempotent)
```

## 5. Deploy
```bash
# .env.production is set; MIL_INSTANCE_NAME keeps container/volume names distinct.
docker compose -f docker-compose.prod.yml up -d --build
curl -fsS "http://$MIL_BIND_IP:5100/health"
```

## Shared-infra checklist (multiple instances on one host)
- [ ] Distinct `MIL_INSTANCE_NAME` (container/image/volume names).
- [ ] Distinct `MIL_QUEUE_PREFIX` if instances share one Redis.
- [ ] Distinct `DATABASE_URL` (separate DB/schema per marketplace).
- [ ] Distinct `MIL_BIND_IP`/port if co-located.
- [ ] Regenerate `INTERNAL_INGEST_TOKEN` + `MIL_SERVING_TOKEN`.
