import type { FastifyInstance } from 'fastify';
import { coreCapabilities } from '@cockpit/core';
import { Intents, type IntentName } from '@cockpit/protocol';
import { zodToJsonSchema } from 'zod-to-json-schema';

type JsonSchemaInput = Parameters<typeof zodToJsonSchema>[0];
const schemas: Record<IntentName, { body: JsonSchemaInput; result: JsonSchemaInput }> = Intents;

export function isIntentName(name: string): name is IntentName {
  return Object.hasOwn(Intents, name);
}

function description(name: IntentName): string {
  const intent = Intents[name];
  if ('description' in intent && typeof intent.description === 'string') return intent.description;
  return intent.body.description ?? intent.result.description
    ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[/-]/g, ' ');
}

// Detail schemas are standalone draft-07 documents; root refs preserve recursive
// protocol types (notably ChatMessage) without expanding them indefinitely.
export function registerCapabilities(app: FastifyInstance): void {
  const transports: { method: string; path: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD') continue; // implicit Fastify GET alias
      if (!transports.some((t) => t.method === method && t.path === route.url)) {
        transports.push({ method, path: route.url });
      }
    }
  });

  // GET /capabilities lists names only (default/max limit 100, offset 0).
  // ?prefix=session/&limit=10&offset=0 narrows that listing.
  // ?name=session/purge returns one input/result schema pair, never the catalog.
  app.get<{ Querystring: Record<string, unknown> }>('/capabilities', async (req, reply) => {
    const q = req.query;
    if (Object.keys(q).some((key) => !['name', 'prefix', 'limit', 'offset'].includes(key))) {
      return reply.code(400).send({ error: 'unknown capabilities query parameter' });
    }
    if (q.name !== undefined) {
      if (typeof q.name !== 'string' || !q.name.length || q.name.length > 200
          || q.prefix !== undefined || q.limit !== undefined || q.offset !== undefined) {
        return reply.code(400).send({ error: 'name must identify one intent; listing parameters cannot be combined with name' });
      }
      if (!isIntentName(q.name)) return reply.code(404).send({ error: `unknown intent: ${q.name}` });
      const intent = schemas[q.name];
      return {
        name: q.name,
        description: description(q.name),
        inputSchema: zodToJsonSchema(intent.body, { target: 'jsonSchema7' }),
        resultSchema: zodToJsonSchema(intent.result, { target: 'jsonSchema7' }),
      };
    }
    const prefix = q.prefix ?? '';
    const limit = pageNumber(q.limit, 100, 1, 100);
    const offset = pageNumber(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    if (typeof prefix !== 'string' || prefix.length > 200 || limit === null || offset === null) {
      return reply.code(400).send({ error: 'prefix must be a string; limit must be 1–100; offset must be a nonnegative safe integer' });
    }
    const intents = Object.keys(Intents).filter(isIntentName).sort()
      .filter((name) => name.startsWith(prefix)).slice(offset, offset + limit)
      .map((name) => ({ name, description: description(name) }));
    return { intents, transports, runtime: coreCapabilities };
  });
}

function pageNumber(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
