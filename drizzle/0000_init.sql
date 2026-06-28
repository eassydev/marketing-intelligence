-- 0000_init: extension + schema. Re-run verbatim on the E2E swap.
-- pgvector is enabled now (no vector columns yet) so GEO/SEO embeddings need no
-- extension migration later. On Supabase `CREATE EXTENSION vector` is permitted;
-- on restricted E2E roles, pre-provision the extension out-of-band.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS marketing;
