import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { createChildLogger } from '../logger/index.js';

const log = createChildLogger({ module: 'service-token' });

export type ServicePrincipal = 'ingest' | 'serving';

/**
 * Build a Fastify preHandler that validates a static bearer token for
 * service-to-service calls. Returns 401 when the header is missing/malformed and
 * 403 on mismatch (there is no login flow to retry). Compared in constant time.
 *
 * Two principals exist: `ingest` (BackendNew → MIL writes) and `serving`
 * (Looker → MIL reads), each with its own token, so a leaked read token cannot
 * write conversions.
 */
export function makeServiceTokenGuard(principal: ServicePrincipal, expected: string) {
  if (!expected) {
    log.warn(
      { principal },
      'Service token is empty — these routes will refuse all requests',
    );
  }

  return async function serviceTokenGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      await reply.status(401).send({ error: 'Missing bearer token' });
      return;
    }

    const presented = header.slice(7);
    if (!expected || !constantTimeEqual(presented, expected)) {
      log.warn({ principal, ip: request.ip, url: request.url }, 'Service token mismatch');
      await reply.status(403).send({ error: 'Forbidden' });
      return;
    }

    (request as FastifyRequest & { service?: { principal: ServicePrincipal } }).service = {
      principal,
    };
  };
}

/**
 * Constant-time string compare. Length check first because timingSafeEqual
 * throws on length mismatch; doing it before the buffer alloc bounds the cost
 * of a bogus oversized token.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
