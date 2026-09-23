/**
 * Anthropic's tool `input_schema` accepts a subset of JSON Schema: no `oneOf`/`anyOf` unions and no `const`
 * (`tools.0.custom: Schema type 'oneOf' is not supported`, HTTP 400 on every propose call — found by the 0.6.0 release
 * smoke, which is how long the Anthropic path had been broken). The action tool describes the Action union as a
 * `oneOf` of object variants discriminated by `kind`; this module flattens it into one object schema — `kind` as an
 * enum, every variant's properties merged and marked with the kinds that use them, only `kind` required — and turns
 * `const` into a one-member `enum`. The engine validates the returned action against the real union anyway
 * (`validateAction`), so nothing is lost but the schema-level per-kind requireds, which the descriptions carry instead.
 * A schema without unions comes back structurally identical.
 */
import type { Json, JsonObject } from '../core/types.js';
import { isJsonObject } from '../core/json.js';

export function anthropicInputSchema(schema: JsonObject): JsonObject {
  return translate(schema) as JsonObject;
}

function translate(node: Json): Json {
  if (Array.isArray(node)) return node.map(translate);
  if (!isJsonObject(node)) return node;
  const variants = node['oneOf'] ?? node['anyOf'];
  if (Array.isArray(variants) && variants.length > 0 && variants.every((v) => isJsonObject(v) && v['type'] === 'object')) return flattenUnion(variants.filter(isJsonObject), node);
  const out: JsonObject = {};
  const constraints: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === 'const') { out['enum'] = [v]; continue; }
    // the strict tool schema takes no numeric or length constraints either: keep the rule as words the model reads
    if (UNSUPPORTED_CONSTRAINTS.has(k)) { constraints.push(`${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`); continue; }
    if (k === 'properties' && isJsonObject(v)) {
      const props: JsonObject = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = translate(pv);
      out[k] = props;
      continue;
    }
    out[k] = k === 'items' || k === 'additionalProperties' ? translate(v) : v;
  }
  if (constraints.length > 0) {
    const base = typeof out['description'] === 'string' ? out['description'] : '';
    out['description'] = `${base} (${constraints.join(', ')})`.trim();
  }
  return out;
}

const UNSUPPORTED_CONSTRAINTS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'format', 'default']);

function flattenUnion(variants: JsonObject[], node: JsonObject): JsonObject {
  const kinds: string[] = [];
  const merged: Record<string, { schema: JsonObject; kinds: string[] }> = {};
  for (const v of variants) {
    const props = isJsonObject(v['properties']) ? v['properties'] : {};
    const kindSchema = isJsonObject(props['kind']) ? props['kind'] : null;
    const kind = kindSchema === null ? null : typeof kindSchema['const'] === 'string' ? kindSchema['const'] : Array.isArray(kindSchema['enum']) && typeof kindSchema['enum'][0] === 'string' ? kindSchema['enum'][0] : null;
    if (kind !== null) kinds.push(kind);
    for (const [pk, pv] of Object.entries(props)) {
      if (pk === 'kind' || !isJsonObject(pv)) continue;
      const slot = merged[pk] ?? (merged[pk] = { schema: translate(pv) as JsonObject, kinds: [] });
      if (kind !== null) slot.kinds.push(kind);
    }
  }
  const properties: JsonObject = {};
  if (kinds.length > 0) properties['kind'] = { type: 'string', enum: kinds, description: 'Which action this is; the other fields depend on it.' };
  for (const [pk, slot] of Object.entries(merged)) {
    const base = typeof slot.schema['description'] === 'string' ? slot.schema['description'] : '';
    const used = slot.kinds.length > 0 && slot.kinds.length < kinds.length ? ` (used by kind: ${slot.kinds.join(', ')})` : '';
    properties[pk] = used === '' && base === '' ? slot.schema : { ...slot.schema, description: `${base}${used}`.trim() };
  }
  const out: JsonObject = { type: 'object', properties, required: kinds.length > 0 ? ['kind'] : [], additionalProperties: false };
  if (typeof node['description'] === 'string') out['description'] = node['description'];
  return out;
}
