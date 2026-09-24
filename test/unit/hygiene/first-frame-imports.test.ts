/**
 * N9, the first-frame import rule (docs/TUI-DESIGN-5.md §1.3 N9, restated as an ordering contract at
 * src/cli/main.tsx:1-14): no module reachable from `src/cli/main.tsx` by a VALUE static import may pull in
 * `src/coordination/**`, `src/orchestrate/**`, `src/import/**`, `src/models/**`, `src/jev-modes/synth/**`, `src/bench/**`,
 * `src/perf/**` or Ink. Values enter behind `await import()`; types enter as `import type`, which erases.
 *
 * Both sessions maintained the rule by hand and it was enforced by nothing: the discipline holds at d297b29 (the
 * walk below reaches 129 modules and `src/tui/App.tsx` is not among them), but the next static import lands
 * silently, and the absence of a check is also what makes the bundle audit's conclusion re-litigable every wave.
 *
 * The walk is deliberately syntactic: a clause that ERASES is skipped, a bare specifier is recorded but not
 * followed, and `await import('…')` is not an import clause at all, so the dynamic boundary the rule is about is
 * exactly what the walk stops at.
 *
 * EXACTLY ONE form erases here, and which one is a property of tsconfig.json, not of TypeScript in general. This
 * tree sets `verbatimModuleSyntax: true`, under which an import statement is emitted unless the whole statement
 * is `import type`. Measured with this repo's own esbuild and tsc (2026-09-22, tsconfig copied verbatim):
 *   `import type { Foo } from './x.js'`   → emitted: nothing                      — erases, not a value edge
 *   `import { type Foo } from './x.js'`   → emitted: `import {} from "./x.js";`   — the module IS loaded
 *   `import { type Foo, val } from …`     → emitted: `import { val } from …`      — a value edge
 * and `node -e` on the middle one prints the imported module's side effect: an empty named import still runs it.
 * So an all-inline-`type` clause is a real first-frame cost and the walk MUST follow it; treating it as erased —
 * as the review that prompted this note proposed, reasoning from the default `verbatimModuleSyntax: false` —
 * would hide a genuine N9 violation rather than prevent a false one. `clauseErases` below therefore recognises
 * only the leading-`type` form, and the last case in this file pins `verbatimModuleSyntax` so that turning it off
 * (which would make the inline form erase) cannot silently make this walk over-strict.
 *
 * Failing-first, four ways: (1) add `import '../coordination/index.js';` to src/cli/main.tsx and this file goes
 * red naming the chain; remove it and it is green again (verified 2026-09-22); (2) `import {Box} from 'ink'` +
 * `import React from 'react'` reds the Ink and the builtin cases; (3) the end-to-end case below builds a
 * temporary entry that imports `{ type FoldState }` from src/coordination/fold.ts and asserts the walk REACHES
 * it — red under a predicate that treats the inline form as erased; (4) flipping `clauseErases` to accept the
 * inline form reds that case and the clause-shape case together.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const ENTRY = join(ROOT, 'src/cli/main.tsx');

/** `import …/export … from '…'` with the clause captured, plus the side-effect form `import '…'`. */
const CLAUSE = /(?:^|\n)[ \t]*(?:import|export)(?![\w$])([^;'"]*?)from[\s]*['"]([^'"]+)['"]|(?:^|\n)[ \t]*import[\s]*['"]([^'"]+)['"]/g;

/**
 * Does this import/export clause erase, i.e. emit no module load at all?
 *
 * Under this tree's `verbatimModuleSyntax: true` (see the header, with the measured emits) that is true of the
 * leading-`type` form and of nothing else:
 *
 *   `type Foo`, `type { Foo }`        → yes  (`import type …`, `export type … from …`: no statement is emitted)
 *   `{ type Foo }`                    → NO   (emits `import {} from "…"`, which runs the module)
 *   `{ type Foo, bar }`, `Default`, `* as ns`, `{}`, `` (side-effect import) → NO
 *
 * The clause is the text between `import`/`export` and `from`, as captured by CLAUSE above.
 */
export function clauseErases(clause: string): boolean {
  // `type[\s{]` and not `type\w`: `typeGuards` and `{ typeName }` are ordinary value bindings
  return /^\s*type[\s{]/.test(clause);
}

/** NodeNext specifiers are written `./x.js`; on disk they are `.ts`/`.tsx`, or a directory's index. */
function resolveSpec(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const c of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c)) return c;
  }
  return null;
}

interface Walk {
  /** repo-relative path → the repo-relative importer that first reached it (the entry maps to itself) */
  reached: Map<string, string>;
  /** bare specifier → the repo-relative modules that import it for its value */
  bare: Map<string, string[]>;
}

function walkValueImports(entry: string): Walk {
  const reached = new Map<string, string>([[relative(ROOT, entry), relative(ROOT, entry)]]);
  const bare = new Map<string, string[]>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const from = relative(ROOT, file);
    for (const m of readFileSync(file, 'utf8').matchAll(CLAUSE)) {
      const clause = m[1];
      const spec = m[2] ?? m[3];
      if (spec === undefined) continue;
      if (clause !== undefined && clauseErases(clause)) continue; // `import type` / all-inline-`type` erases
      if (!spec.startsWith('.')) {
        bare.set(spec, [...(bare.get(spec) ?? []), from]);
        continue;
      }
      const target = resolveSpec(file, spec);
      if (target === null) continue; // a .json/.node asset, or a specifier this walk cannot resolve
      const rel = relative(ROOT, target);
      if (reached.has(rel)) continue;
      reached.set(rel, from);
      stack.push(target);
    }
  }
  return { reached, bare };
}

/** The forbidden trees, each with the one module inside it the design exempts (a pure, leaf, import-free module). */
const FORBIDDEN: readonly { tree: RegExp; except: RegExp | null; why: string }[] = [
  { tree: /^src\/coordination\//, except: null, why: 'the fold opens after the first frame (§1.4 promise 1)' },
  { tree: /^src\/orchestrate\//, except: /^src\/orchestrate\/split\/globs\.ts$/, why: 'the agents tab is a dynamic import' },
  { tree: /^src\/import\//, except: /^src\/import\/rules\.ts$/, why: 'the importer is a command, not a launch path' },
  // `ids.ts` is named by the design as the intended pure-id module; it is not on the tree yet, `static.ts` is
  { tree: /^src\/models\//, except: /^src\/models\/(ids|static)\.ts$/, why: 'instantCatalogue pulls http/cache/parse (§14.2 #35)' },
  { tree: /^src\/jev-modes\/synth\//, except: null, why: 'the synthesizer is built inside the engine, after the frame' },
  { tree: /^src\/bench\//, except: null, why: 'the bench command is a dynamic import' },
  { tree: /^src\/perf\//, except: /^src\/perf\/timeline\.ts$/, why: 'the perf command is a dynamic import' },
];

/** Packages that must not be on the value path: Ink and its renderer decide the cost of the first frame. */
const FORBIDDEN_PACKAGES = /^(ink|react|react-dom|ink-testing-library)(\/|$)/;

describe('N9: the argv / first-frame path imports no heavy tree for its value', () => {
  const { reached, bare } = walkValueImports(ENTRY);

  /** `a.ts <- b.ts <- … <- src/cli/main.tsx` for a reached module */
  const chainOf = (file: string): string => {
    const out = [file];
    for (let at = file; out.length < 20; ) {
      const parent = reached.get(at);
      if (parent === undefined || parent === at) break;
      out.push(parent);
      at = parent;
    }
    return out.join(' <- ');
  };

  it('the walk actually reaches the launch path (it cannot go green by finding nothing)', () => {
    expect(reached.size).toBeGreaterThan(50);
    // the modules main.tsx names in its own ordering contract
    for (const anchor of ['src/cli/args.ts', 'src/cli/session.ts', 'src/tui/terminal.ts', 'src/config/launch.ts', 'src/loop/stop.ts']) {
      expect([...reached.keys()], `${anchor} must be on the value path`).toContain(anchor);
    }
  });

  it('no forbidden tree is reachable by a value static import', () => {
    const hits: string[] = [];
    for (const file of reached.keys()) {
      for (const { tree, except, why } of FORBIDDEN) {
        if (!tree.test(file)) continue;
        if (except !== null && except.test(file)) continue;
        hits.push(`${chainOf(file)}  — ${why}; use \`await import()\` or \`import type\``);
      }
    }
    expect(hits.sort()).toEqual([]);
  });

  it('Ink and React are not on the value path, and src/tui/App.tsx is not reached', () => {
    const inkSites = [...bare].filter(([spec]) => FORBIDDEN_PACKAGES.test(spec)).map(([spec, importers]) => `${spec} <- ${importers.sort().join(', ')}`);
    expect(inkSites.sort()).toEqual([]);
    expect([...reached.keys()]).not.toContain('src/tui/App.tsx');
  });

  it('every package on the value path is a node: builtin', () => {
    const nonBuiltin = [...bare.keys()].filter((spec) => !spec.startsWith('node:')).sort();
    expect(nonBuiltin, 'a third-party package on the argv path is a startup cost with no dynamic boundary').toEqual([]);
  });
});

describe('what the walk treats as erased, and the tsconfig setting that decides it', () => {
  it('decides each clause shape the way this tree emits it', () => {
    // erases under `verbatimModuleSyntax`: the whole statement is dropped, so the edge is not a value edge
    for (const clause of [' type Foo ', ' type { Foo } ', ' type {Foo, Bar} ', ' type * as ns ']) {
      expect(clauseErases(clause), `${clause} erases`).toBe(true);
    }
    // does NOT erase: the module is loaded at run time, so the walk must follow it
    for (const clause of [' { type Foo } ', ' {type Foo,type Bar} ', ' { type Foo, bar } ', ' Default, { type Foo } ', ' * as ns ', ' Default ', ' { bar } ', ' {} ', '']) {
      expect(clauseErases(clause), `${clause} is a value edge`).toBe(false);
    }
    // the shape that exists on the real path today (src/cli/fatal.ts) must be followed
    expect(clauseErases(' { type EpilogueContext, epilogueLines, terminalSafeLine } ')).toBe(false);
    // identifiers that merely start with the letters are not the modifier
    expect(clauseErases(' { typeName } ')).toBe(false);
    expect(clauseErases(' typeGuards ')).toBe(false);
  });

  it('end to end: an all-inline-type import is followed, because it still loads the module', () => {
    // built here rather than by editing src/cli/main.tsx. `import { type FoldState } from '…/fold.js'` emits
    // `import {} from "…/fold.js"` under this tsconfig — a real first-frame cost — so the walk MUST reach it.
    const dir = mkdtempSync(join(tmpdir(), 'jev-n9-'));
    try {
      const target = relative(dir, join(ROOT, 'src/coordination/fold.ts')).replace(/\.ts$/, '.js');
      const inline = join(dir, 'inline.ts');
      writeFileSync(inline, `import { type FoldState } from '${target}';\nexport const x: FoldState | null = null;\n`);
      expect([...walkValueImports(inline).reached.keys()], '`import {} from` still runs the module').toContain('src/coordination/fold.ts');

      // and the fully erased form is not followed: that is the boundary the rule is written around
      const erased = join(dir, 'erased.ts');
      writeFileSync(erased, `import type { FoldState } from '${target}';\nexport const x: FoldState | null = null;\n`);
      expect([...walkValueImports(erased).reached.keys()], '`import type` emits no statement at all').not.toContain('src/coordination/fold.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the emit rule this walk depends on is pinned: verbatimModuleSyntax is on', () => {
    // with `verbatimModuleSyntax: false` the inline form WOULD erase and the walk above would be over-strict.
    // Turning it off is a legitimate change; silently invalidating this gate's rule is not, so it reds here.
    const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions['verbatimModuleSyntax'], 'clauseErases() above is written for this setting — re-derive it if this changes').toBe(true);
  });
});
