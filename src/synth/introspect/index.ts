/**
 * Introspected names (experiments/results/swebench-reach-oracle-9.md, missing capability 2):
 * the names a fix needs that are on the objects of the failing call and nowhere in the file, the
 * tests or the issue text. `introspectRepro` runs the oracle's reproduction ONCE more in the
 * workspace, through the same `run` the oracle runner uses (the engine's sandbox in production,
 * `.venv/bin/python` when the workspace has one) with the introspection pass of script.ts
 * appended, and turns the pass's JSON into size-capped `IntrospectedNames`. The names feed the
 * vocabulary pre-check (`EnumerateOptions.extraNames`, sieve/queue.ts `missingNames`) and the two
 * template productions of templates/introspect.ts; the composed alias names a file's own dispatch
 * convention allows (`<prefix><Class>`) are computed here so the vocabulary can accept them.
 *
 * Bounds: ≤ INTROSPECT_NAMES_MAX names in total over the four lists; one interpreter run of at
 * most INTROSPECT_TIMEOUT_MAX_MS. Everything is a fact read from the interpreter; the truth value
 * of a predicate at the failing call orders the guard drafts, it never decides anything.
 */
import type { ReproSpec } from '../oracle/goal.js';
import { REPRO_MAX_OUTPUT_BYTES, REPRO_TIMEOUT_MS } from '../oracle/runner.js';
import type { TracebackFrame } from '../oracle/types.js';
import type { SourceFile } from '../types.js';
import type { VerifyRunFn } from '../verify/types.js';
import { composedAliasNames } from './prefixes.js';
import { anchorsOf, buildIntrospectScript, introspectCommand, parseIntrospectOutput } from './script.js';
import type { RawIntrospection } from './script.js';
import type { IntrospectFrame, IntrospectOperand, IntrospectStatus, IntrospectedNames } from './types.js';

export type { IntrospectFrame, IntrospectOperand, IntrospectStatus, IntrospectedNames } from './types.js';
export { INTROSPECT_SENTINEL, anchorsOf, buildIntrospectScript, introspectCommand, introspectPass, parseIntrospectOutput } from './script.js';
export type { IntrospectAnchor, RawIntrospection } from './script.js';
export { PREFIX_MIN_METHODS, classMethodPrefixes, composedAliasNames } from './prefixes.js';
export type { MethodPrefix } from './prefixes.js';
export { RUN_FACTS_MAX, clearRunFacts, runFacts, setRunFacts } from './facts.js';
export type { RunFacts } from './facts.js';

/** Total names over classes ∪ predicates ∪ attributes ∪ moduleNames (the brief's cap). */
export const INTROSPECT_NAMES_MAX = 400;
export const CLASSES_MAX = 60;
export const PREDICATES_MAX = 120;
export const ATTRIBUTES_MAX = 160;
export const MODULE_NAMES_MAX = 60;
/** Attribute names kept per operand (the per-operand detail the templates read). */
export const OPERAND_ATTRS_MAX = 60;
/** The pass re-runs the raising statement once, so it may take twice the reproduction; never more than a minute. */
export const INTROSPECT_TIMEOUT_MAX_MS = 60_000;

const IDENT_RE = /^[A-Za-z_]\w*$/;

export interface IntrospectOptions {
  /** absolute path of the checkout the reproduction runs against */
  workspace: string;
  /** interpreter; default: the workspace's `.venv/bin/python` when present, else `python3` (reproCommand) */
  python?: string;
  /** the traceback frames Jev judged inside the fix (oracle/search.ts `anchors`); matched by file suffix + function name */
  anchors?: readonly TracebackFrame[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

export function emptyIntrospection(status: IntrospectStatus, note: string, durationMs = 0): IntrospectedNames {
  return { classes: [], attributes: [], predicates: [], moduleNames: [], operands: [], frames: [], moduleName: null, target: null, status, durationMs, note };
}

function uniq(items: Iterable<string>): string[] {
  return [...new Set(items)];
}

function identifiers(list: readonly unknown[] | undefined): string[] {
  return (list ?? []).filter((x): x is string => typeof x === 'string' && IDENT_RE.test(x));
}

function frameOf(raw: { path?: string | null; line?: number; fn?: string | null; code?: string | null } | null | undefined): IntrospectFrame | null {
  if (raw === null || raw === undefined || typeof raw.path !== 'string' || raw.path === '') return null;
  return { path: raw.path, line: typeof raw.line === 'number' ? raw.line : 0, fn: typeof raw.fn === 'string' ? raw.fn : null, code: typeof raw.code === 'string' ? raw.code : null };
}

/**
 * The pass's JSON as `IntrospectedNames`: operands with the raising receiver first, the flat lists
 * deduplicated in that order, each capped, then trimmed (attributes, module names, predicates,
 * classes, in that order) until the total is ≤ INTROSPECT_NAMES_MAX.
 */
export function namesFromRaw(raw: RawIntrospection, durationMs: number): IntrospectedNames {
  const operandsRaw = (raw.operands ?? []).filter((o) => typeof o.expr === 'string');
  const ordered = [...operandsRaw.filter((o) => o.receiver === true), ...operandsRaw.filter((o) => o.receiver !== true)];
  const operands: IntrospectOperand[] = ordered.map((o) => {
    const predicates = identifiers(o.preds);
    const falsy = new Set(identifiers(o.falsy));
    return {
      expr: o.expr ?? '',
      typeName: typeof o.type === 'string' ? o.type : '',
      classes: identifiers(o.mro),
      // falsy predicates first: `if not x.<p>:` fires on the failing input for exactly these
      predicates: [...predicates.filter((p) => falsy.has(p)), ...predicates.filter((p) => !falsy.has(p))],
      falsyPredicates: predicates.filter((p) => falsy.has(p)),
      attributes: identifiers(o.attrs).slice(0, OPERAND_ATTRS_MAX),
      frame: frameOf(o.frame),
      raisingReceiver: o.receiver === true,
    };
  });
  let classes = uniq(operands.flatMap((o) => o.classes)).slice(0, CLASSES_MAX);
  let predicates = uniq(operands.flatMap((o) => o.predicates)).slice(0, PREDICATES_MAX);
  let attributes = uniq(operands.flatMap((o) => o.attributes)).slice(0, ATTRIBUTES_MAX);
  let moduleNames = identifiers(raw.module_names).slice(0, MODULE_NAMES_MAX);
  const total = (): number => classes.length + predicates.length + attributes.length + moduleNames.length;
  if (total() > INTROSPECT_NAMES_MAX) attributes = attributes.slice(0, Math.max(0, attributes.length - (total() - INTROSPECT_NAMES_MAX)));
  if (total() > INTROSPECT_NAMES_MAX) moduleNames = moduleNames.slice(0, Math.max(0, moduleNames.length - (total() - INTROSPECT_NAMES_MAX)));
  if (total() > INTROSPECT_NAMES_MAX) predicates = predicates.slice(0, Math.max(0, predicates.length - (total() - INTROSPECT_NAMES_MAX)));
  if (total() > INTROSPECT_NAMES_MAX) classes = classes.slice(0, Math.max(0, classes.length - (total() - INTROSPECT_NAMES_MAX)));
  const frames = (raw.frames ?? []).map(frameOf).filter((f): f is IntrospectFrame => f !== null);
  const status: IntrospectStatus = raw.ok === false ? (operands.length === 0 ? 'no_target' : 'ran') : 'ran';
  return {
    classes,
    attributes,
    predicates,
    moduleNames,
    operands,
    frames,
    moduleName: typeof raw.module === 'string' ? raw.module : null,
    target: typeof raw.target === 'string' ? raw.target : null,
    status,
    durationMs,
    note: typeof raw.note === 'string' && raw.note !== '' ? raw.note : `${operands.length} operand${operands.length === 1 ? '' : 's'}, ${classes.length} classes, ${predicates.length} predicates, ${attributes.length} attributes, ${moduleNames.length} module names`,
  };
}

/** Run the introspection pass over the reproduction in `opts.workspace`; never throws on a failing script (status carries it). */
export async function introspectRepro(run: VerifyRunFn, spec: Pick<ReproSpec, 'chunks' | 'options'>, opts: IntrospectOptions): Promise<IntrospectedNames> {
  const script = buildIntrospectScript(spec.chunks, { workspace: opts.workspace, packageName: spec.options.packageName, framework: spec.options.framework ?? null }, anchorsOf(opts.anchors ?? []));
  const cmdOpts: { workspace: string; python?: string; env?: Record<string, string> } = { workspace: opts.workspace };
  if (opts.python !== undefined) cmdOpts.python = opts.python;
  const env = opts.env ?? spec.options.env;
  if (env !== undefined) cmdOpts.env = env;
  const command = introspectCommand(script, cmdOpts);
  const timeoutMs = opts.timeoutMs ?? Math.min(INTROSPECT_TIMEOUT_MAX_MS, 2 * (spec.options.timeoutMs ?? REPRO_TIMEOUT_MS));
  const started = Date.now();
  const res = await run(command, { cwd: opts.workspace, timeoutMs, maxOutputBytes: REPRO_MAX_OUTPUT_BYTES });
  const durationMs = res.durationMs ?? Date.now() - started;
  const timedOut = res.timedOut === true || res.killedBy === 'timeout';
  if (timedOut) return emptyIntrospection('timeout', `the introspection run did not finish in ${timeoutMs} ms`, durationMs);
  const raw = parseIntrospectOutput(res.stdout);
  if (raw === null) return emptyIntrospection(res.exitCode === 0 ? 'no_output' : 'error', `no introspection output (exit ${res.exitCode ?? 'null'}): ${`${res.stdout}\n${res.stderr ?? ''}`.trim().slice(-200)}`, durationMs);
  return namesFromRaw(raw, durationMs);
}

/** Every harvested name as one flat list (classes, predicates, attributes, module names), deduplicated. */
export function introspectedNamesFlat(names: IntrospectedNames): string[] {
  return uniq([...names.classes, ...names.predicates, ...names.attributes, ...names.moduleNames]);
}

/**
 * The names the vocabulary of `file` must accept for the introspection-fed productions to pass the
 * queue's pre-check: the flat names plus `<prefix><Class>` for the file's own dispatch prefixes.
 */
export function vocabularyAdditions(names: IntrospectedNames, file: SourceFile): string[] {
  return uniq([...introspectedNamesFlat(names), ...composedAliasNames(file.mod, names.classes)]);
}
