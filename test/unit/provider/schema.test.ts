/** provider/schema.ts — the strict-mode gate and the one Gemini rewrite. */
import { describe, expect, it } from 'vitest';
import { PROPOSE_ACTION_TOOL } from '../../../src/provider/actions.js';
import { MAX_DEPTH, MAX_PROPERTIES, checkOpenAiStrict, geminiToolSchema } from '../../../src/provider/schema.js';
import type { JsonObject } from '../../../src/core/types.js';
import { PROPOSE_TOOL } from './helpers.js';

describe('checkOpenAiStrict', () => {
  it("rejects the harness's own propose_action schema, naming every rule it breaks", () => {
    const check = checkOpenAiStrict(PROPOSE_ACTION_TOOL.inputSchema);
    expect(check.ok).toBe(false);
    const joined = check.reasons.join('\n');
    expect(joined).toContain('#/properties/action: unsupported keyword "oneOf"');
    // the variants' `const` discriminator and `minItems` are the other two blockers
    expect(check.reasons.some((r) => r.includes('"const"'))).toBe(false); // `const` sits inside the oneOf branches, which are not walked
    expect(check.ok).toBe(false);
  });

  it('accepts a schema that follows every strict rule', () => {
    expect(checkOpenAiStrict(PROPOSE_TOOL.inputSchema)).toEqual({ ok: true, reasons: [] });
  });

  it('names the individual rules', () => {
    const notObject: JsonObject = { type: 'string' };
    expect(checkOpenAiStrict(notObject).reasons[0]).toContain('root of a strict schema must be');

    const missingAdditional: JsonObject = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(checkOpenAiStrict(missingAdditional).reasons).toEqual(['#: object without "additionalProperties": false']);

    const optional: JsonObject = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] };
    expect(checkOpenAiStrict(optional).reasons).toEqual(['#/properties/b: not listed in "required" (strict mode requires every property)']);

    const bounded: JsonObject = { type: 'object', additionalProperties: false, properties: { a: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['a'] };
    expect(checkOpenAiStrict(bounded).reasons).toEqual(['#/properties/a: unsupported keyword "minItems"']);

    const external: JsonObject = { type: 'object', additionalProperties: false, properties: { a: { $ref: 'https://example.com/s.json' } }, required: ['a'] };
    expect(checkOpenAiStrict(external).reasons).toEqual(['#/properties/a: external $ref "https://example.com/s.json"']);

    const nested: JsonObject = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'object', additionalProperties: false, required: ['b'], properties: { b: { type: 'string', pattern: '^x' } } } },
    };
    expect(checkOpenAiStrict(nested).reasons).toEqual(['#/properties/a/properties/b: unsupported keyword "pattern"']);

    // anyOf and $defs are supported and are walked
    const anyOf: JsonObject = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] }] } },
    };
    expect(checkOpenAiStrict(anyOf).reasons).toEqual(['#/properties/a/anyOf/1: object without "additionalProperties": false']);
  });

  it("rejects what the API's own bounds reject: >5 levels of nesting, the tuple/contains forms and a boolean subschema", () => {
    // OpenAI strict mode allows 5 levels counting the root; the sixth is a 400, so the walk reports it rather than
    // passing it (the doc's promise: a false "ok" cannot turn into a 400 at request time).
    const nest = (depth: number): JsonObject => {
      let node: JsonObject = { type: 'string' };
      for (let i = 0; i < depth - 1; i += 1) node = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: node } };
      return node;
    };
    expect(checkOpenAiStrict(nest(MAX_DEPTH)).ok).toBe(true);
    const tooDeep = checkOpenAiStrict(nest(MAX_DEPTH + 1));
    expect(tooDeep.ok).toBe(false);
    expect(tooDeep.reasons.some((r) => r.includes(`nested deeper than ${MAX_DEPTH} levels`))).toBe(true);

    const tuple: JsonObject = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'array', prefixItems: [{ type: 'string' }] } } };
    expect(checkOpenAiStrict(tuple).reasons).toEqual(['#/properties/a: unsupported keyword "prefixItems"']);

    const contains: JsonObject = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'array', contains: { type: 'string' } } } };
    expect(checkOpenAiStrict(contains).reasons).toEqual(['#/properties/a: unsupported keyword "contains"']);

    const boolSub: JsonObject = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'array', items: true } } };
    expect(checkOpenAiStrict(boolSub).reasons).toEqual(['#/properties/a/items: a schema must be an object, not boolean']);
  });

  it('rejects a schema past the 5000-property total, once', () => {
    const properties: JsonObject = {};
    for (let i = 0; i < MAX_PROPERTIES + 1; i += 1) properties[`p${i}`] = { type: 'string' };
    const wide: JsonObject = { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
    expect(checkOpenAiStrict(wide).reasons).toEqual([`#: more than ${MAX_PROPERTIES} object properties in total (strict mode's limit)`]);
  });

  it('terminates on a self-referential schema', () => {
    const node: JsonObject = { type: 'object', additionalProperties: false, required: ['child'], properties: {} };
    (node['properties'] as JsonObject)['child'] = node;
    expect(checkOpenAiStrict(node).ok).toBe(true);
  });
});

describe('geminiToolSchema', () => {
  it('renames oneOf to anyOf at every depth and leaves everything else untouched', () => {
    const out = geminiToolSchema(PROPOSE_ACTION_TOOL.inputSchema);
    expect(JSON.stringify(out)).not.toContain('oneOf');
    expect(JSON.stringify(out).replace(/anyOf/g, 'oneOf')).toBe(JSON.stringify(PROPOSE_ACTION_TOOL.inputSchema));
  });

  it('returns the same object when there is no oneOf (no allocation in the common case)', () => {
    expect(geminiToolSchema(PROPOSE_TOOL.inputSchema)).toBe(PROPOSE_TOOL.inputSchema);
  });

  it('rewrites a oneOf nested inside an array of schemas', () => {
    const schema: JsonObject = { type: 'object', properties: { a: { anyOf: [{ oneOf: [{ type: 'string' }] }] } } };
    expect(geminiToolSchema(schema)).toEqual({ type: 'object', properties: { a: { anyOf: [{ anyOf: [{ type: 'string' }] }] } } });
  });
});
