import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { makeServiceTokenGuard } from '../../shared/middleware/service-token.js';
import {
  registryListQuery,
  registryCreateSchema,
  registryUpdateSchema,
} from './validators.js';
import {
  listRegistry,
  insertRegistryRow,
  updateRegistryRow,
  deleteRegistryRow,
} from './registry-queries.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Event definitions registry CRUD. Guarded by MIL_SERVING_TOKEN. */
export async function eventRegistryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', makeServiceTokenGuard('serving', env.MIL_SERVING_TOKEN));

  // ── List ──────────────────────────────────────────────────────────────────
  app.get('/marketing/events/registry', async (req: FastifyRequest) => {
    const q = registryListQuery.parse(req.query);
    return { data: await listRegistry(q.app) };
  });

  // ── Create ────────────────────────────────────────────────────────────────
  app.post('/marketing/events/registry', async (req: FastifyRequest, reply: FastifyReply) => {
    const b = registryCreateSchema.parse(req.body);
    try {
      const row = await insertRegistryRow(b);
      return reply.status(201).send({ data: row });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({
          error: 'Conflict',
          message: `(${b.source}, '${b.event_name}') is already registered for app '${b.app}'`,
        });
      }
      throw err;
    }
  });

  // ── Update (partial) ──────────────────────────────────────────────────────
  app.put('/marketing/events/registry/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = idParam.parse(req.params);
    const b = registryUpdateSchema.parse(req.body);
    try {
      const row = await updateRegistryRow(id, b);
      if (!row) return reply.status(404).send({ error: 'Not found' });
      return { data: row };
    } catch (err) {
      // Renaming event_name onto an existing (app, source, event_name) row.
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({
          error: 'Conflict',
          message: `event_name '${b.event_name}' is already registered for this (app, source)`,
        });
      }
      throw err;
    }
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  app.delete('/marketing/events/registry/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = idParam.parse(req.params);
    const deleted = await deleteRegistryRow(id);
    if (!deleted) return reply.status(404).send({ error: 'Not found' });
    return { data: { deleted: true } };
  });
}
