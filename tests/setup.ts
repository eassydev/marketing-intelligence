// Vitest global setup: provide the env vars src/config/env.ts requires at import
// time so unit tests can import modules without a real .env. Integration tests
// that need a live DB override DATABASE_URL with their Testcontainers URL.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://mil:mil@localhost:5432/mil';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.INTERNAL_INGEST_TOKEN ??= 'test-ingest-token-0123456789';
process.env.MIL_SERVING_TOKEN ??= 'test-serving-token-0123456789';
