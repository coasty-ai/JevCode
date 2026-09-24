/**
 * The Anthropic tool schema translation: the action tool's `oneOf` union (six kinds) becomes one object with `kind` as an
 * enum and the variants' fields merged and labelled; `const` becomes a one-member enum; nothing the API rejects survives;
 * a union-free schema is unchanged. Found by the 0.6.0 release smoke: every Anthropic propose call was HTTP 400 before this.
 */
import { describe, expect, it } from 'vitest';
import { PROPOSE_ACTION_TOOL } from '../../../src/provider/actions.js';
import { anthropicInputSchema } from '../../../src/provider/anthropic-schema.js';
import type { Json, JsonObject } from '../../../src/core/types.js';
import { isJsonObject } from '../../../src/core/json.js';

function keysDeep(node: Json, acc = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => keysDeep(n, acc));
  else if (isJsonObject(node)) for (const [k, v] of Object.entries(node)) { acc.add(k); keysDeep(v, acc); }
  return acc;
}

describe('anthropicInputSchema', () => {
  const out = anthropicInputSchema(PROPOSE_ACTION_TOOL.inputSchema);
  const action = (out['properties'] as JsonObject)['action'] as JsonObject;
  const props = action['properties'] as JsonObject;

  it('leaves no oneOf, anyOf, const or numeric/length constraint anywhere in the translated schema — those become words', () => {
    const keys = keysDeep(out);
    for (const k of ['oneOf', 'anyOf', 'const', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format']) expect(keys.has(k), k).toBe(false);
    expect(String((props['timeoutMs'] as JsonObject)['description'])).toContain('minimum 1000');
    expect(String((props['paths'] as JsonObject)['description'])).toContain('minItems 1');
  });

  it('flattens the action union into one object: kind is an enum of the six kinds and the only required field', () => {
    expect(action['type']).toBe('object');
    expect((props['kind'] as JsonObject)['enum']).toEqual(['read', 'edit', 'write', 'patch', 'run', 'done']);
    expect(action['required']).toEqual(['kind']);
    expect(action['additionalProperties']).toBe(false);
  });

  it('merges every variant field and says which kinds use it', () => {
    for (const k of ['paths', 'path', 'old', 'new', 'content', 'diff', 'command', 'timeoutMs', 'summary']) expect(props, k).toHaveProperty(k);
    expect(String((props['command'] as JsonObject)['description'])).toContain('used by kind: run');
    expect(String((props['path'] as JsonObject)['description'])).toContain('used by kind: edit, write');
  });

  it('keeps goal and plan as they were and is the identity on a union-free schema', () => {
    const top = out['properties'] as JsonObject;
    expect(top['goal']).toEqual((PROPOSE_ACTION_TOOL.inputSchema['properties'] as JsonObject)['goal']);
    expect(top['plan']).toEqual((PROPOSE_ACTION_TOOL.inputSchema['properties'] as JsonObject)['plan']);
    const plain: JsonObject = { type: 'object', properties: { a: { type: 'string', description: 'A' }, b: { type: 'array', items: { type: 'integer' } } }, required: ['a'], additionalProperties: false };
    expect(anthropicInputSchema(plain)).toEqual(plain);
  });

  it('turns const into a one-member enum outside unions too', () => {
    expect(anthropicInputSchema({ type: 'object', properties: { v: { const: 'x' } } })).toEqual({ type: 'object', properties: { v: { enum: ['x'] } } });
  });
});
