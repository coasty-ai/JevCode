/**
 * Tool-schema adaptation for the non-Anthropic providers (provider/actions.ts owns the one schema the harness sends:
 * `PROPOSE_ACTION_TOOL`, an object whose `action` property is a `oneOf` of six variants with `const` discriminators,
 * `minItems` on `read.paths` and an optional `run.timeoutMs`).
 *
 * Two APIs constrain that schema, and both were checked against the live endpoints on 2026-09-21:
 *
 *  - OpenAI's strict mode (Chat Completions `tools[].function.strict`, Responses `tools[].strict`) accepts a small
 *    JSON-Schema subset: the root is an object, every object sets `additionalProperties: false` and lists EVERY property
 *    in `required` (an optional field is modelled as `type: ["string", "null"]`), and `pattern` / `minLength` /
 *    `maxLength` / `minimum` / `maximum` / `minItems` / `maxItems` / `format` / `default` / `oneOf` / `allOf` / `not` /
 *    `if` / `then` / `else` / `patternProperties` / `const` are not supported (`anyOf` is, over single-schema
 *    alternatives, and so are `$defs` / `$ref`). `PROPOSE_ACTION_TOOL` violates four of those rules, so the clients ask
 *    `checkOpenAiStrict` first and send `strict: true` only for a schema that passes — never a rewritten schema, and
 *    never a `strict: true` the API would answer 400 to. The reasons are kept so a test (and `--why`) can show why a
 *    given tool went out non-strict.
 *  - Gemini's `functionDeclarations[].parametersJsonSchema` takes standard JSON Schema but supports `anyOf` only:
 *    `oneOf` / `allOf` / `patternProperties` / `if`-`then` are "silently ignored", which would hand the model a shapeless
 *    `action` object. `geminiToolSchema` therefore performs exactly ONE rewrite — `oneOf` → `anyOf`, recursively — and
 *    leaves every other keyword as it is (Gemini ignores what it does not know, and ignoring `minItems` costs nothing).
 *
 * Pure functions over `JsonObject`; nothing here reads the network or mutates its input.
 */
import { isJsonObject } from '../core/json.js';
import type { Json, JsonObject } from '../core/types.js';

/** Keywords OpenAI's strict mode rejects outright (guides/structured-outputs "Some type-specific keywords are not yet supported"). */
export const OPENAI_STRICT_UNSUPPORTED: readonly string[] = [
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'const',
  'default',
  'format',
  'pattern',
  'patternProperties',
  'propertyNames',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'dependentSchemas',
  'dependentRequired',
];

export interface StrictCheck {
  ok: boolean;
  /** one line per violation, each naming the JSON-pointer-ish path it was found at; empty when `ok` */
  reasons: readonly string[];
}

/** The deepest nesting `checkOpenAiStrict` walks (OpenAI's own limit is 5 levels / 5000 properties; a deeper schema is reported, not crashed on). */
const MAX_DEPTH = 12;

/**
 * Whether `schema` may be sent with `strict: true`. Conservative by construction: anything the walk cannot verify
 * (a `$ref` target outside the document, a depth beyond MAX_DEPTH) counts as a violation, so a false "ok" cannot
 * turn into a 400 at request time.
 */
export function checkOpenAiStrict(schema: JsonObject): StrictCheck {
  const reasons: string[] = [];
  const seen = new Set<JsonObject>();

  const walk = (node: Json, path: string, depth: number): void => {
    if (!isJsonObject(node)) {
      if (Array.isArray(node)) reasons.push(`${path}: a schema must be an object, not an array`);
      return;
    }
    if (seen.has(node)) return; // a $ref cycle expressed by shared objects: walked once
    seen.add(node);
    if (depth > MAX_DEPTH) {
      reasons.push(`${path}: nested deeper than ${MAX_DEPTH} levels`);
      return;
    }
    for (const key of OPENAI_STRICT_UNSUPPORTED) {
      if (key in node) reasons.push(`${path}: unsupported keyword "${key}"`);
    }
    const ref = node['$ref'];
    if (typeof ref === 'string' && !ref.startsWith('#')) reasons.push(`${path}: external $ref "${ref}"`);

    const type = node['type'];
    const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type.filter((t): t is string => typeof t === 'string') : [];
    const props = node['properties'];
    const isObject = types.includes('object') || isJsonObject(props);
    if (isObject) {
      if (node['additionalProperties'] !== false) reasons.push(`${path}: object without "additionalProperties": false`);
      const keys = isJsonObject(props) ? Object.keys(props) : [];
      const required = Array.isArray(node['required']) ? node['required'].filter((r): r is string => typeof r === 'string') : [];
      for (const k of keys) if (!required.includes(k)) reasons.push(`${path}/properties/${k}: not listed in "required" (strict mode requires every property)`);
      for (const r of required) if (!keys.includes(r)) reasons.push(`${path}: "required" names "${r}", which is not a property`);
      if (isJsonObject(props)) for (const [k, v] of Object.entries(props)) walk(v, `${path}/properties/${k}`, depth + 1);
    }
    const items = node['items'];
    if (items !== undefined) {
      if (Array.isArray(items)) reasons.push(`${path}/items: tuple form is not supported`);
      else walk(items, `${path}/items`, depth + 1);
    }
    const anyOf = node['anyOf'];
    if (Array.isArray(anyOf)) anyOf.forEach((v, i) => walk(v, `${path}/anyOf/${i}`, depth + 1));
    const defs = node['$defs'];
    if (isJsonObject(defs)) for (const [k, v] of Object.entries(defs)) walk(v, `${path}/$defs/${k}`, depth + 1);
  };

  if (schema['type'] !== 'object') reasons.push('#: the root of a strict schema must be {"type": "object"}');
  walk(schema, '#', 0);
  return reasons.length === 0 ? { ok: true, reasons: [] } : { ok: false, reasons };
}

/**
 * Gemini's `parametersJsonSchema` form of a tool schema: `oneOf` renamed to `anyOf` everywhere (the only Gemini-unsupported
 * keyword in the harness's schema that carries meaning), everything else copied verbatim. Returns the input unchanged
 * (same reference) when there is no `oneOf` anywhere, so the common case allocates nothing.
 */
export function geminiToolSchema(schema: JsonObject): JsonObject {
  return hasOneOf(schema) ? (rewriteOneOf(schema) as JsonObject) : schema;
}

function hasOneOf(node: Json): boolean {
  if (Array.isArray(node)) return node.some(hasOneOf);
  if (!isJsonObject(node)) return false;
  if ('oneOf' in node) return true;
  return Object.values(node).some(hasOneOf);
}

function rewriteOneOf(node: Json): Json {
  if (Array.isArray(node)) return node.map(rewriteOneOf);
  if (!isJsonObject(node)) return node;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) out[k === 'oneOf' ? 'anyOf' : k] = rewriteOneOf(v);
  return out;
}
