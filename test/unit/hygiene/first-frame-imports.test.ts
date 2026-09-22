/**
 * N9, the first-frame import rule (docs/TUI-DESIGN-5.md §1.3 N9, restated as an ordering contract at
 * src/cli/main.tsx:1-14): no module reachable from `src/cli/main.tsx` by a VALUE static import may pull in
 * `src/coordination/**`, `src/orchestrate/**`, `src/import/**`, `src/models/**`, `src/synth/**`, `src/bench/**`,
 * `src/perf/**` or Ink. Values enter behind `await import()`; types enter as `import type`, which erases.
 *
 * Both sessions maintained the rule by hand and it was enforced by nothing: the discipline holds at d297b29 (the
 * walk below reaches 129 modules and `src/tui/App.tsx` is not among them), but the next static import lands
 * silently, and the absence of a check is also what makes the bundle audit's conclusion re-litigable every wave.
 *
 * The walk is deliberately syntactic: a clause that begins with `type` (`import type …`, `export type …`) is
 * skipped because it erases, a bare specifier is recorded but not followed, and `await import('…')` is not an
 * import clause at all, so the dynamic boundary the rule is about is exactly what the walk stops at.
 *
 * Failing-first: add `import '../coordination/index.js';` to src/cli/main.tsx and this file goes red naming the
 * chain; remove it and it is green again (verified 2026-09-22).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const ENTRY = join(ROOT, 'src/cli/main.tsx');

/** `import …/export … from '…'` with the clause captured, plus the side-effect form `import '…'`. */
const CLAUSE = /(?:^|\n)[ \t]*(?:import|export)(?![\w$])([^;'"]*?)from[\s]*['"]([^'"]+)['"]|(?:^|\n)[ \t]*import[\s]*['"]([^'"]+)['"]/g;

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
      if (clause !== undefined && /^\s*type[\s{]/.test(clause)) continue; // `import type` / `export type` erases
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
  { tree: /^src\/synth\//, except: null, why: 'the synthesizer is built inside the engine, after the frame' },
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
