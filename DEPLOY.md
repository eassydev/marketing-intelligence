# MIL Deploy Runbook — E2E VM (Docker Compose, internal-only)

Target: a small Ubuntu 22.04+ VM on E2E Networks, same VPC as the backend
(`216.48.187.182`) and managed MySQL. MIL runs as Docker Compose (app + Redis);
Postgres is **Supabase** (external). No public hostname yet — the app port binds
to the VM's private VPC IP and is reached only by the backend box.

## 0. Provision (one-time)
1. Create the VM: **2 vCPU / 4 GB / ~40 GB SSD**, Ubuntu 22.04+.
2. Firewall / security group:
   - SSH (22) from your admin IP only.
   - TCP **5100** allowed **only from the backend box's private IP** (not public).
   - Outbound 443 (Meta/Google/Anthropic) and **5432** (Supabase) allowed.
3. Install Docker Engine + compose plugin:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker "$USER" && newgrp docker
   ```

## 1. Supabase (one-time)
1. Create the Supabase project (region closest to E2E).
2. Enable pgvector: Dashboard → Database → Extensions → enable **vector**
   (or it is created by `drizzle/0000_init.sql` if the role permits).
3. Copy the **direct/session** connection string (port 5432) — not the 6543 pooler.

## 2. Configure
```bash
git clone <repo> marketing-intelligence && cd marketing-intelligence
cp .env.production.example .env.production
# Fill: DATABASE_URL (Supabase 5432), MIL_BIND_IP (this VM's private IP),
#       INTERNAL_INGEST_TOKEN + MIL_SERVING_TOKEN (openssl rand -hex 24)
```

## 3. Build + migrate + run
```bash
docker compose -f docker-compose.prod.yml build
# Explicit, one-off migration (never auto-runs on container start):
docker compose -f docker-compose.prod.yml run --rm mil node dist/scripts/migrate.js
docker compose -f docker-compose.prod.yml up -d
```

## 4. Verify
```bash
# On the VM:
curl -s localhost:5100/health        # if MIL_BIND_IP=127.0.0.1, else use the private IP
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f mil
# From the BACKEND box (proves the internal hop):
curl -s http://<MIL_PRIVATE_IP>:5100/health
```
Expect `{"status":"ok","service":"mil",...}`.

## 5. Update / redeploy
```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
# Only if new drizzle/*.sql were added:
docker compose -f docker-compose.prod.yml run --rm mil node dist/scripts/migrate.js
```

## 6. Wire the backend (Phase 2, later)
On the backend box, set:
```
MIL_INGEST_URL=http://<MIL_PRIVATE_IP>:5100
MIL_INGEST_TOKEN=<the INTERNAL_INGEST_TOKEN value>
```

## Notes
- Redis state is ephemeral job data (idempotent + reconstructable); the
  `mil_redis` volume is convenience, not a source of truth.
- Going public later (Looker / Phase-3 browser touch): add nginx + certbot on a
  subdomain (e.g. `mil.eassylife.in`) in front of `:5100`. Not needed now.
- Swap Supabase → E2E managed Postgres later by changing `DATABASE_URL` and
  re-running the migration; nothing else changes.
