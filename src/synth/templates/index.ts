/**
 * Fix-template candidate source for the Jev-only synthesizer (docs/JEV-ONLY.md; TBar's
 * catalogue in experiments/results/lit-search-based-repair.md §1 and §8). Eight families
 * propose concrete lines or insertions at a Site from scope, the file's own attribute and call
 * tables, sibling functions and the failing tests' literals: guards, missing statements,
 * expression wraps, condition extension, call signatures, attribute/callee substitution,
 * imports and branch clones. Everything is deterministic and pure; priors order enumeration
 * by family yield in the literature and by locality (names on or near the site first) so the
 * cap truncates the long tail, never the idiomatic fix. Jev ranks, tests decide.
 */
import type { Candidate, CandidateSource, EnumerateOptions, Site } from '../types.js';
import type { PyModule } from '../py/structure.js';
import type { Draft } from './common.js';
import { TEMPLATE_FAMILIES, balancedAs, buildContext, continuesStatement, isBalanced, toCandidate } from './common.js';
import type { TemplateContext, TemplateFamily } from './common.js';
import { guardDrafts } from './guards.js';
import { statementInsertDrafts } from './statements.js';
import { wrapDrafts } from './wrap.js';
import { conditionDrafts } from './condition.js';
import { signatureDrafts } from './signature.js';
import { attributeDrafts } from './attribute.js';
import { importDrafts } from './imports.js';
import { branchDrafts } from './branch.js';

export { FAMILY_PRIOR, TEMPLATE_FAMILIES, balancedAs, buildContext, continuesStatement, isBalanced } from './common.js';
export type { TemplateFamily, TemplateContext, NamePools } from './common.js';
export { unboundNames, importInsertLine, importLinesFor, atImportGap, STDLIB_NAMES, STDLIB_NAMES_ALT, STDLIB_MODULES } from './imports.js';
export { substituteIdentifier } from './branch.js';
export { raiseStatements } from './guards.js';

const FAMILY_FN: Readonly<Record<TemplateFamily, (ctx: TemplateContext) => Draft[]>> = {
  guard: guardDrafts,
  statement: statementInsertDrafts,
  wrap: wrapDrafts,
  condition: conditionDrafts,
  signature: signatureDrafts,
  attribute: attributeDrafts,
  import: importDrafts,
  branch: branchDrafts,
};

/** Family of an op name (`guard_none_return_before` -> `guard`), for tests and the trace. */
export function familyOf(op: string): TemplateFamily {
  if (op.startsWith('guard_')) return 'guard';
  if (op.startsWith('insert_')) return 'statement';
  if (op.startsWith('wrap_')) return 'wrap';
  if (op.startsWith('cond_') || op === 'return_condition') return 'condition';
  if (op.startsWith('add_param') || op.startsWith('call_')) return 'signature';
  if (op.endsWith('_subst')) return 'attribute';
  if (op.startsWith('import_')) return 'import';
  return 'branch';
}

function editKey(d: Draft): string {
  return JSON.stringify([d.text, (d.extraEdits ?? []).map((e) => [e.line, e.kind, e.text ?? ''])]);
}

/** Enumerate template candidates at a site: all families, syntactic filter, dedupe, prior order, cap. */
/**
 * Syntactic filter for one edit: an inserted block must balance on every line; a replaced line
 * must close brackets exactly as the line it replaces did (so a line of a multi-line call stays
 * editable and an edit that opens a bracket it never closes is dropped).
 */
function wellFormed(mod: PyModule, e: { kind: 'replace' | 'insert' | 'delete'; line: number; text: string }): boolean {
  if (e.kind === 'delete') return true;
  if (e.kind === 'insert') return isBalanced(e.text);
  return balancedAs(mod.lines[e.line - 1] ?? '', e.text);
}

/** Enumerate template candidates at a site: all families, syntactic filter, dedupe, prior order, cap. */
export function enumerateTemplates(site: Site, opts: EnumerateOptions, families: readonly TemplateFamily[] = TEMPLATE_FAMILIES): Candidate[] {
  const mod = site.file.mod;
  // A gap inside a multi-line statement (between `f(` and `)`) takes no statement: nothing to propose.
  if (site.kind === 'insert' && continuesStatement(mod, site.line)) return [];
  const ctx = buildContext(site, opts);
  const familyIndex = new Map(TEMPLATE_FAMILIES.map((f, k) => [f, k] as const));
  const best = new Map<string, { draft: Draft; family: number }>();
  for (const family of families) {
    for (const draft of FAMILY_FN[family](ctx)) {
      if (draft.text.trim() === '' && (draft.extraEdits === undefined || draft.extraEdits.length === 0)) continue;
      // a candidate that changes nothing is not a candidate (the ranker excludes the unchanged line anyway)
      if (site.kind === 'replace' && draft.text === site.currentLine && (draft.extraEdits === undefined || draft.extraEdits.length === 0)) continue;
      if (!wellFormed(mod, { kind: site.kind, line: site.line, text: draft.text })) continue;
      if ((draft.extraEdits ?? []).some((e) => !wellFormed(mod, { kind: e.kind, line: e.line, text: e.text ?? '' }))) continue;
      const key = editKey(draft);
      const cur = best.get(key);
      if (cur === undefined || cur.draft.prior < draft.prior) best.set(key, { draft, family: familyIndex.get(family) ?? 99 });
    }
  }
  // code-point order rather than localeCompare: the same input must enumerate identically on every machine
  const ordered = [...best.values()].sort((a, b) => b.draft.prior - a.draft.prior || a.family - b.family || (a.draft.text < b.draft.text ? -1 : a.draft.text > b.draft.text ? 1 : 0));
  return ordered.slice(0, Math.max(0, opts.cap)).map(({ draft }) => toCandidate(site, draft));
}

export function createTemplateSource(): CandidateSource {
  return {
    name: 'template',
    enumerate(site: Site, opts: EnumerateOptions): Candidate[] {
      return enumerateTemplates(site, opts);
    },
  };
}
