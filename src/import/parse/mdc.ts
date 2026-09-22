/**
 * docs/IMPORT-DESIGN.md §4.3 `mdc.ts` — Cursor's `.mdc` (frontmatter + markdown), and the §2.5
 * trigger table every rule dialect maps through.
 *
 * Tolerant by construction (§6 row 19): no frontmatter, or a broken one, still yields the body,
 * `trigger: manual` and a `frontmatter unparsable: <reason>` warning — never a throw.
 */
import type { Frontmatter, MarkdownDoc, ParseResult, RuleTrigger } from '../types.js';
import { fmBool, fmList, fmString, parseFrontmatter } from './frontmatter.js';
import { parseMarkdown, type MarkdownOptions } from './markdown.js';

/** §4.3: a parsed `.mdc` — the frontmatter (null when absent or broken) and the normalised body. */
export function parseMdc(text: string, opts: MarkdownOptions = {}): ParseResult<{ frontmatter: Frontmatter | null; doc: MarkdownDoc }> {
  const warnings: string[] = [];
  let doc: MarkdownDoc;
  try {
    doc = parseMarkdown(text, opts);
  } catch (e) {
    return { ok: false, error: `markdown unparsable: ${e instanceof Error ? e.message : String(e)}`, warnings };
  }
  const fm = parseFrontmatter(doc.text);
  if (!fm.ok) warnings.push(`frontmatter unparsable: ${fm.error}`);
  else if (fm.value.broken) warnings.push(`frontmatter unparsable: ${fm.warnings.join('; ') || 'malformed'}`);
  else warnings.push(...fm.warnings);
  return { ok: true, value: { frontmatter: doc.frontmatter, doc }, warnings };
}

/**
 * §2.5: the one trigger table — Cursor (`alwaysApply`, `globs`, `description`), Windsurf
 * (`trigger: always_on | glob | model_decision`), Claude rules (`paths:`) and Copilot
 * (`applyTo:`, comma-separated). No frontmatter ⇒ `manual` (the caller decides whether a
 * bare `.cursorrules`/`.windsurfrules` is `always`; those have no frontmatter at all).
 */
export function mdcTrigger(fm: Frontmatter | null): { trigger: RuleTrigger; paths: readonly string[] } {
  const globs = fmList(fm, 'globs') ?? fmList(fm, 'applyTo') ?? fmList(fm, 'paths') ?? [];
  const declared = (fmString(fm, 'trigger') ?? '').trim().toLowerCase();
  if (declared === 'always_on' || declared === 'always') return { trigger: 'always', paths: [] };
  if (declared === 'model_decision' || declared === 'manual') return { trigger: 'manual', paths: [] };
  if (declared === 'glob' || declared === 'paths') return globs.length > 0 ? { trigger: 'paths', paths: globs } : { trigger: 'manual', paths: [] };
  if (fmBool(fm, 'alwaysApply') === true) return { trigger: 'always', paths: [] };
  if (globs.length > 0) return { trigger: 'paths', paths: globs };
  return { trigger: 'manual', paths: [] };
}
