/**
 * Guard (finishing pass F16): `docs/HARNESS-NEXT-DESIGN.md` §9.3 is the canonical wave-status table, and it proves every
 * "not started" by NAMING THE SYMBOL the wave is defined by. A wave that lands without its row being rewritten leaves the
 * table asserting the absence of code that is on `main` — which is what happened to S2 and S4 when the LLM-loop wave
 * merged (`73a2ca6`, `d297b29`): `hedgeAfterMs`, `LLM_HEDGES_PER_ROUND`, the SSE TTFB callback, `--quick`,
 * `routeSpeculative` and `ROUTER_DEADLINE_MS` all exist while §9.3 said they did not.
 *
 * Two halves, both mechanical:
 *  - LANDED: a closed list of symbols this pass verified PRESENT in `src/`. The test asserts they are still present (so the
 *    list cannot rot into a vacuous pass) AND that §9.3 / §9.1 never again claim any of them absent.
 *  - The table's own remaining `no \`X\`` claims: each `X` must in fact be absent under `src/`. That is the property that
 *    keeps the NEXT wave's row honest without anybody editing this file.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLAGS } from '../../../src/cli/args.js';

const ROOT = join(import.meta.dirname, '../../..');
const DESIGN = join(ROOT, 'docs/HARNESS-NEXT-DESIGN.md');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const SRC_FILES = walk(join(ROOT, 'src'));

/** Every `src/**` file whose text contains `needle` as a whole word, repo-relative. */
function srcHits(needle: string): string[] {
  const re = new RegExp(`(^|[^A-Za-z0-9_$-])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_$-]|$)`);
  return SRC_FILES.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
}

/** The body of a `### N.M heading` section, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`design-status: heading not found: ${heading}`);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n#{1,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Symbols this pass verified present on `main` at `d297b29`. Each entry: the symbol, one file it is defined in, and the
 * wave whose §9.3 row used to deny it. `phrases` are the exact prose spellings §9.3/§9.1 must not carry again (the TTFB
 * callback and `--quick` were written as prose, not as a backticked symbol).
 */
const LANDED: readonly { symbol: string; definedIn: string; wave: string; phrases: readonly string[] }[] = [
  { symbol: 'hedgeAfterMs', definedIn: 'src/synth/llm/source.ts', wave: 'S2', phrases: ['no `hedgeAfterMs`'] },
  { symbol: 'LLM_HEDGES_PER_ROUND', definedIn: 'src/core/limits.ts', wave: 'S2', phrases: ['no `LLM_HEDGES_PER_ROUND`'] },
  { symbol: 'reportFirstByte', definedIn: 'src/provider/sse.ts', wave: 'S2', phrases: ['no TTFB callback'] },
  { symbol: 'quick', definedIn: 'src/bench/cli.ts', wave: 'S2', phrases: ['no `--quick`', '`--quick` in `src/bench/cli.ts`'] },
  { symbol: 'routeSpeculative', definedIn: 'src/jev/router.ts', wave: 'S4', phrases: ['no `routeSpeculative`'] },
  { symbol: 'ROUTER_DEADLINE_MS', definedIn: 'src/jev/router.ts', wave: 'S4', phrases: ['no `ROUTER_DEADLINE_MS`'] },
];

describe('docs/HARNESS-NEXT-DESIGN.md §9.3 — the wave-status table names only symbols that are really absent', () => {
  const text = readFileSync(DESIGN, 'utf8');
  const s93 = section(text, '### 9.3 S2–S6 — status');
  const s91 = section(text, '### 9.1 S0 — measure, make iteration free, fix the perf gate');

  it.each(LANDED)('$wave: `$symbol` is present in src, so the table may not claim it absent', ({ symbol, definedIn, phrases }) => {
    // half 1: the list itself is true today — if the symbol ever really goes away, THIS fails and the entry must move
    expect(srcHits(symbol), `${symbol} should be defined in ${definedIn}`).toContain(definedIn);
    // half 2: §9.3 and §9.1 must not deny it
    for (const p of phrases) {
      expect(s93, `§9.3 claims "${p}" but ${symbol} is in ${definedIn}`).not.toContain(p);
      expect(s91, `§9.1 claims "${p}" but ${symbol} is in ${definedIn}`).not.toContain(p);
    }
  });

  it('every remaining "no `X`" claim in §9.3 names a symbol that is genuinely absent from src/**', () => {
    const claimed = [...s93.matchAll(/\bno `([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1] as string);
    expect(claimed.length, '§9.3 should still prove its "not started" rows by naming symbols').toBeGreaterThan(0);
    const wrong = claimed.filter((sym) => srcHits(sym).length > 0).map((sym) => `${sym} → ${srcHits(sym).slice(0, 3).join(', ')}`);
    expect(wrong, '§9.3 claims these symbols are absent, but src/** defines them').toEqual([]);
  });

  it('§9.3 does not say "None has started" — S2 and S4 landed with the LLM-loop wave', () => {
    expect(s93).not.toContain('None has started');
    expect(s93).toMatch(/S3, S5 and S6 have not started/);
  });

  it('§9.1 states `--jev off` as the bench/perf-only mechanism it is (`withJevOff` has one call site)', () => {
    const callers = srcHits('withJevOff').filter((f) => f !== 'src/jev/off.ts');
    expect(callers, 'withJevOff is reached only from the bench runner today').toEqual(['src/bench/runner.ts']);
    expect(s91, '§9.1 must say the switch is bench/perf-only until the CLI wiring lands').toContain('bench/perf-only');
  });

  it('the `--jev` claim is narrowed to `run`/`bench`: a `--jev` flag DOES exist, for `jevcode logout`', () => {
    // Review F16-1: "there is no `--jev` row in `src/cli/args.ts`" is false by spelling — args.ts:288 declares one
    // for `logout`, printed in the usage line. The checkable property is the narrow one: no run-like command takes
    // a `jev` flag, so neither an interactive session nor `jevcode run`/`bench` can reach the off-decider.
    const jevRows = FLAGS.filter((f) => f.name === 'jev');
    expect(jevRows.map((f) => [...f.commands]), 'args.ts carries exactly one `--jev` row, and it belongs to `logout`').toEqual([['logout']]);
    const onRunLike = FLAGS.filter((f) => f.name === 'jev' && f.commands.some((c) => c === 'run' || c === 'bench'));
    expect(onRunLike, 'no `--jev` flag on `run` or `bench`: the off-decider is reachable only through JEVCODE_JEV').toEqual([]);

    for (const [file, forbidden] of [
      ['docs/HARNESS-NEXT-DESIGN.md', 'there is no `--jev` row in `src/cli/args.ts`'],
      ['docs/LLM-JEV.md', 'there is no `--jev` CLI flag'],
    ] as const) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, `${file} states a blanket absence that args.ts:288 falsifies`).not.toContain(forbidden);
    }
    expect(s91, '§9.1 must narrow the claim to `run`/`bench`').toContain('no `--jev off` row on `run` or `bench`');
  });

  it('the three unstarted waves are still unstarted (S3 index, S5 replacer ladder / `poll`, M15 replay)', () => {
    expect(srcHits('JEVCODE_INDEX')).toEqual([]);
    expect(SRC_FILES.map((f) => relative(ROOT, f))).not.toContain('src/loop/replay.ts');
    // `poll` as a command name: the CLI command table would carry it
    const args = readFileSync(join(ROOT, 'src/cli/args.ts'), 'utf8');
    expect(args).not.toMatch(/'poll'/);
  });

  it('the table is measured against this worktree, not a remembered tip', () => {
    // A cheap provenance line: the test only means anything if it ran against a real checkout of src/**.
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(SRC_FILES.length).toBeGreaterThan(100);
  });
});
