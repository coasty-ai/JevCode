/**
 * The sketch pool for one site (docs/JEV-ONLY-DESIGN.md §3 source 5, §6 `sketch/pool.ts`):
 * every production of ./productions.ts applied, de-duplicated by token sequence (the
 * highest-priority production keeps a shape), ordered, the unchanged line's hole-free shape
 * removed (probe-question-design §6: the current line is never an option) and cut to 254 so the
 * Q12 Choice stays under the 255-option limit with its escape.
 *
 * Measured (grammar-synthesis.md Appendix A): median 64, max 138 sketches per QuixBugs site, so
 * the cap never fired there; SWE lines of 20–40 tokens will hit it, which is why the order is the
 * pilot's priority order (P1, P7, end-of-line `<op> _`, P5, P2, P6, P10, remaining P3/P4, P8, P9)
 * followed by the unmeasured P12/P13.
 */
import type { SketchHypothesis } from '../search/types.js';
import { detokenize, toks } from '../beam/tokens.js';
import type { Tok } from '../beam/tokens.js';
import { indentOf } from '../py/edits.js';
import type { EnumerateOptions, LineEdit, Site } from '../types.js';
import { PRODUCTION_IDS, holeIndices, hypothesisToks, productionsFor } from './productions.js';
import type { Sketch } from './productions.js';

/** One Choice holds ≤ 255 options including `none_of_these` (REPORT §5); the pilot's CAP. */
export const MAX_SKETCHES = 254;

/** A pool entry: the frozen hypothesis shape plus the option description's `change` text. */
export interface SketchEntry extends SketchHypothesis {
  change: string;
}

/** Type guard for hypotheses that still carry their `change` description. */
export function hasChange(h: SketchHypothesis): h is SketchEntry {
  return typeof (h as { change?: unknown }).change === 'string';
}

function keyOf(ts: readonly Tok[], extras: readonly LineEdit[] = []): string {
  return `${ts.map((t) => t.text).join('\u0000')}\u0002${extras.map((e) => `${e.kind}:${e.line}:${e.text ?? ''}`).join('\u0001')}`;
}

interface Ranked {
  sketch: Sketch;
  index: number;
}

/** Stable pool order: priority, then production order, then first appearance. */
function compare(a: Ranked, b: Ranked): number {
  return a.sketch.prio - b.sketch.prio || PRODUCTION_IDS.indexOf(a.sketch.production) - PRODUCTION_IDS.indexOf(b.sketch.production) || a.index - b.index;
}

/**
 * Build the pool of holed hypotheses for `site`. Pure and deterministic. A hole-free sketch that
 * equals the current line is excluded (it would be the unchanged line); a hole-free sketch that
 * differs is kept (P6/P7/P9 produce complete lines the fill stage passes straight through).
 */
export function sketchPool(site: Site, opts: EnumerateOptions): SketchEntry[] {
  const current = site.kind === 'replace' ? keyOf(toks(site.currentLine)) : null;
  const best = new Map<string, Ranked>();
  productionsFor(site, opts).forEach((sketch, index) => {
    if (sketch.toks.length === 0) return;
    const key = keyOf(sketch.toks, sketch.extraEdits);
    if (current !== null && key === current && holeIndices(sketch.toks).length === 0) return;
    const prev = best.get(key);
    if (prev === undefined || compare({ sketch, index }, prev) < 0) best.set(key, { sketch, index });
  });
  return [...best.values()]
    .sort(compare)
    .slice(0, MAX_SKETCHES)
    .map(({ sketch }) => toEntry(site, sketch));
}

export function toEntry(site: Site, sketch: Sketch): SketchEntry {
  const h: SketchEntry = {
    site,
    toks: sketch.toks.map((t) => t.text),
    holes: holeIndices(sketch.toks),
    production: sketch.production,
    pSketch: 0,
    logP: 0,
    change: sketch.change,
  };
  if (sketch.extraEdits !== undefined) h.extraEdits = sketch.extraEdits.map((e) => ({ ...e }));
  return h;
}

/**
 * Rendered shape of a hypothesis (`return gcd(b, a % b)`, `while _:`), the Q12 option's `shape`.
 * A multi-line sketch (P12) shows its body lines below the header at their relative indentation,
 * so a guard and the one-line header shape are distinct options.
 */
export function sketchText(h: SketchHypothesis): string {
  const head = detokenize(hypothesisToks(h.toks));
  const extras = h.extraEdits ?? [];
  if (extras.length === 0) return head;
  const body = extras.map((e) => {
    const text = e.text ?? '';
    const relative = indentOf(text).slice(h.site.indent.length);
    return `${relative}${detokenize(toks(text))}`;
  });
  return [head, ...body].join('\n');
}

/** Dedupe key of a hypothesis: token texts plus the extra edits (a P12 header with two bodies is two sketches). */
export function sketchKey(h: SketchHypothesis): string {
  return keyOf(hypothesisToks(h.toks), h.extraEdits ?? []);
}
