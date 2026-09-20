/**
 * A class's dispatch-name convention, read from its own method names: when several methods
 * share a prefix ending in `_` followed by a CapWord (`_print_Function` / `_print_Integral`,
 * `visit_Call` / `visit_Name`, `_eval_Eq`), the class dispatches on a type name and a new type
 * is handled by one more `<prefix><TypeName>` method or alias. Pure token arithmetic over the
 * analysed module; no name here comes from a benchmark.
 */
import type { Block, PyModule } from '../py/structure.js';

export interface MethodPrefix {
  classIndex: number;
  className: string;
  /** the shared prefix, `_` included (`_print_`, `visit_`) */
  prefix: string;
  /** the methods carrying it, in source order */
  methods: { name: string; suffix: string; block: Block }[];
}

/** A prefix counts as a convention when at least this many methods of the class carry it. */
export const PREFIX_MIN_METHODS = 2;
const SUFFIX_RE = /^[A-Za-z]\w*$/;
const CAPWORD_RE = /^[A-Z]/;

/** Every prefix of `name` that ends in a single `_` and leaves a non-empty remainder (`_print_Function` -> `_print_`). */
function underscorePrefixes(name: string): string[] {
  const out: string[] = [];
  for (let i = 1; i < name.length - 1; i++) {
    if (name[i] === '_' && name[i + 1] !== '_' && name[i - 1] !== '_') out.push(name.slice(0, i + 1));
  }
  return out;
}

/**
 * The dispatch prefix of every class in `mod` that has one: the prefix shared by the most methods
 * (longest on a tie), carried by ≥ PREFIX_MIN_METHODS methods of which at least one has a CapWord
 * suffix (a type name), so `get_a` / `get_b` accessor pairs do not count.
 */
export function classMethodPrefixes(mod: PyModule): MethodPrefix[] {
  const out: MethodPrefix[] = [];
  for (const cls of mod.blocks) {
    if (cls.kind !== 'class') continue;
    const methods = mod.blocks.filter((b) => b.kind === 'def' && b.parent === cls.index);
    const byPrefix = new Map<string, Block[]>();
    for (const m of methods) {
      for (const p of underscorePrefixes(m.name)) {
        if (!SUFFIX_RE.test(m.name.slice(p.length))) continue;
        const list = byPrefix.get(p) ?? [];
        list.push(m);
        byPrefix.set(p, list);
      }
    }
    let best: { prefix: string; blocks: Block[] } | null = null;
    for (const [prefix, blocks] of byPrefix) {
      if (blocks.length < PREFIX_MIN_METHODS) continue;
      if (!blocks.some((b) => CAPWORD_RE.test(b.name.slice(prefix.length)))) continue;
      if (best === null || blocks.length > best.blocks.length || (blocks.length === best.blocks.length && prefix.length > best.prefix.length)) best = { prefix, blocks };
    }
    if (best === null) continue;
    const prefix = best.prefix;
    out.push({ classIndex: cls.index, className: cls.name, prefix, methods: best.blocks.map((b) => ({ name: b.name, suffix: b.name.slice(prefix.length), block: b })) });
  }
  return out;
}

/** `<prefix><Class>` for every dispatch prefix of `mod` and every class name: the names the alias production may write into this file. */
export function composedAliasNames(mod: PyModule, classes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of classMethodPrefixes(mod)) for (const c of classes) if (SUFFIX_RE.test(c)) out.add(`${p.prefix}${c}`);
  return [...out];
}
