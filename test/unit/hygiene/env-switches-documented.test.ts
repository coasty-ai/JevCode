/**
 * Guard (finishing pass F22): every environment variable that CHANGES WHAT A RUN DOES must appear in the
 * "Harness environment switches" table of `docs/LLM-JEV.md` §5a, with a default and an effect.
 *
 * Why this exists. Four switches returned nothing from `grep -rl <name> docs/ README.md` on `main` @ `d297b29` —
 * `JEVCODE_HEDGE` (the only way the §3.2 hedge can arm, since no `src/` site sets `LlmSourceDeps.hedge`),
 * `JEVCODE_CASE_TIMEOUT_MS`, `JEVCODE_MAX_CASE_TIMEOUTS` and `JEVCODE_BENCH_CONTEXT` (which flips every bench arm's
 * prompt from legacy to relaxed) — and four more existed only inside design prose with no default and no effect. An
 * audit that cannot read the switch table has to reconstruct it from `grep`, which is how a measurement ends up
 * taken under an inherited environment nobody recorded.
 *
 * "Changes run behaviour" is decided mechanically, not by taste. Discovery is the union of two rules over `src/**`
 * OUTSIDE the TUI-owned trees (`src/tui`, `src/cli`, `src/config`, `src/session`, `src/chat`, whose switches are
 * presentation or settings and are documented with the settings table instead):
 *  (A) every `export const … = 'JEVCODE_…'` that is also used somewhere as an `env[CONST]` subscript; plus
 *  (B) every LITERAL subscript `env['JEVCODE_…']` / `process.env['JEVCODE_…']`.
 *
 * (B) is the rule review F22-1 found missing. The first version of this file replaced it with a hand-written
 * three-name list, and a behaviour-changing switch added as `env['JEVCODE_NEW_THING']` — the pattern 13 of the ~16
 * non-TUI env reads in this tree already use — passed all six tests. A discovered name leaves the required set only
 * through `OUT_OF_SCOPE`, which carries a per-name written reason and is itself re-checked: an entry that is no
 * longer read anywhere fails, so the exemption list cannot rot into a silent path in.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const LLM_JEV = readFileSync(join(ROOT, 'docs/LLM-JEV.md'), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const SRC = walk(join(ROOT, 'src')).map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, 'utf8') }));

/** The trees whose env switches belong to the settings/TUI documentation, not to the harness table. */
const NOT_HARNESS = /^src\/(tui|cli|config|session|chat)\//;

/**
 * (A) `export const NAME = 'JEVCODE_…'` declared outside the TUI-owned trees AND used somewhere as an env subscript
 * `env[NAME]`. The second half is what separates a switch from a protocol string: `WARM_READY_PREFIX` is also
 * spelled `'JEVCODE_WARM_READY'`, but it is the line the warm Python server prints on stdout, never read from an
 * environment, so it is not a switch and must not be in the table.
 */
function constantSwitches(): Map<string, string> {
  const declared = new Map<string, { env: string; file: string }>();
  for (const f of SRC) {
    if (NOT_HARNESS.test(f.path)) continue;
    for (const m of f.text.matchAll(/export const ([A-Za-z0-9_]+)(?::\s*[A-Za-z<>[\]'| ]+)?\s*=\s*'(JEVCODE_[A-Z0-9_]+)'/g)) {
      declared.set(m[1] as string, { env: m[2] as string, file: f.path });
    }
  }
  const found = new Map<string, string>();
  for (const [constName, { env, file }] of declared) {
    const usedIn = SRC.find((f) => f.text.includes(`[${constName}]`));
    if (usedIn !== undefined) found.set(env, file);
  }
  return found;
}

/**
 * (B) every switch read as a LITERAL env subscript, discovered rather than listed. The value is the first file the
 * read occurs in, in `walk` order, which is what the "Read in" column is checked against.
 */
function literalSwitches(): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of SRC) {
    if (NOT_HARNESS.test(f.path)) continue;
    for (const m of f.text.matchAll(/(?:process\.)?env\[['"](JEVCODE_[A-Z0-9_]+)['"]\]/g)) {
      const name = m[1] as string;
      if (!found.has(name)) found.set(name, f.path);
    }
  }
  return found;
}

/**
 * Names discovery finds that are deliberately NOT in the §5a table, each with the reason it is out of scope. A
 * genuinely new behaviour switch has no silent path in: it is either in the table or it is named here, on purpose.
 */
const OUT_OF_SCOPE: readonly { name: string; why: string }[] = [
  { name: 'JEVCODE_TRACE', why: 'diagnostics: where the wire trace is written; it adds a file, it does not change a decision' },
  { name: 'JEVCODE_LOG', why: 'diagnostics: the log file path' },
  { name: 'JEVCODE_LOG_LEVEL', why: 'diagnostics: log verbosity' },
  { name: 'JEVCODE_HOME', why: 'settings: relocates the state/cache home; documented with the settings table' },
  { name: 'JEVCODE_MOCK_INTAKE', why: 'test hook (JEVCODE_MOCK_*): only the in-repo mock decider reads it' },
  { name: 'JEVCODE_MOCK_JEV_MS', why: 'test hook (JEVCODE_MOCK_*): injects a latency into the mock decider' },
  { name: 'JEVCODE_PERF_ONLY', why: 'perf harness plumbing: selects which probes `jevcode perf` runs' },
  { name: 'JEVCODE_PERF_CHILD', why: 'perf harness plumbing: marks the re-exec child process' },
  { name: 'JEVCODE_PERF_KEEP', why: 'perf harness plumbing: keeps the pty scratch directory' },
];
const OUT_OF_SCOPE_NAMES = new Set(OUT_OF_SCOPE.map((o) => o.name));

/** The rows of the §5a table: `| \`JEVCODE_X\` | values | default | effect | reading file |`. */
function tableRows(): Map<string, string[]> {
  const start = LLM_JEV.indexOf('<!-- env-switches:begin -->');
  const end = LLM_JEV.indexOf('<!-- env-switches:end -->');
  if (start < 0 || end < 0) return new Map();
  const rows = new Map<string, string[]>();
  for (const line of LLM_JEV.slice(start, end).split('\n')) {
    const m = /^\|\s*`(JEVCODE_[A-Z0-9_]+)`\s*\|(.*)\|\s*$/.exec(line.trim());
    if (m === null) continue;
    rows.set(m[1] as string, (m[2] as string).split('|').map((c) => c.trim()));
  }
  return rows;
}

describe('docs/LLM-JEV.md §5a — every behaviour-changing env switch is in the table', () => {
  const discovered = new Map<string, string>(constantSwitches());
  for (const [name, readIn] of literalSwitches()) if (!discovered.has(name)) discovered.set(name, readIn);
  const required = new Map([...discovered].filter(([n]) => !OUT_OF_SCOPE_NAMES.has(n)));

  it('discovery enumerates every JEVCODE_* read under src/ outside the TUI trees', () => {
    // The whole set, so a new name shows up here first whichever way it is written.
    expect([...discovered.keys()].sort()).toEqual([
      'JEVCODE_BENCH_CONTEXT',
      'JEVCODE_CASE_TIMEOUT_MS',
      'JEVCODE_DEADLINE_GROWTH',
      'JEVCODE_FASTPATH',
      'JEVCODE_HEDGE',
      'JEVCODE_HOME',
      'JEVCODE_JEV',
      'JEVCODE_LOG',
      'JEVCODE_LOG_LEVEL',
      'JEVCODE_MAX_CASE_TIMEOUTS',
      'JEVCODE_MOCK_INTAKE',
      'JEVCODE_MOCK_JEV_MS',
      'JEVCODE_PERF_CHILD',
      'JEVCODE_PERF_KEEP',
      'JEVCODE_PERF_ONLY',
      // integration: slot C's sentinel override and slot A's third mechanism switch
      'JEVCODE_PERF_WINDOW',
      'JEVCODE_ROUTERS',
      'JEVCODE_S2',
      'JEVCODE_TIMELINE',
      'JEVCODE_TRACE',
      'JEVCODE_WARM',
    ]);
  });

  it('the literal-subscript rule alone finds the switches the hand list used to miss', () => {
    // Review F22-1: `env['JEVCODE_TIMELINE']` and the nine out-of-scope names were invisible to the old rules.
    const literal = [...literalSwitches().keys()];
    for (const n of ['JEVCODE_TIMELINE', 'JEVCODE_TRACE', 'JEVCODE_ROUTERS', 'JEVCODE_FASTPATH', 'JEVCODE_BENCH_CONTEXT']) {
      expect(literal, `${n} is read as a literal env subscript and must be discovered`).toContain(n);
    }
  });

  it('every out-of-scope exemption is still read somewhere, and carries a reason', () => {
    for (const { name, why } of OUT_OF_SCOPE) {
      expect(discovered.has(name), `${name} is exempted but nothing under src/ reads it — delete the row`).toBe(true);
      expect(why.length, `${name} needs a written reason`).toBeGreaterThan(20);
    }
  });

  it('the required set is exactly the discovered set minus the written exemptions', () => {
    expect([...required.keys()].sort()).toEqual([
      'JEVCODE_BENCH_CONTEXT',
      'JEVCODE_CASE_TIMEOUT_MS',
      'JEVCODE_DEADLINE_GROWTH',
      'JEVCODE_FASTPATH',
      'JEVCODE_HEDGE',
      'JEVCODE_JEV',
      'JEVCODE_MAX_CASE_TIMEOUTS',
      // integration: both are in the §5a table rather than OUT_OF_SCOPE. `JEVCODE_PERF_WINDOW` sits beside the
      // three exempt `JEVCODE_PERF_*` plumbing names but is not plumbing: an exported value sends `jevcode perf`
      // to poll the wrong sentinel and measure straight through somebody's live window.
      'JEVCODE_PERF_WINDOW',
      'JEVCODE_ROUTERS',
      'JEVCODE_S2',
      'JEVCODE_TIMELINE',
      'JEVCODE_WARM',
    ]);
  });

  it('every behaviour-changing switch has a row with all five columns filled', () => {
    const rows = tableRows();
    const missing: string[] = [];
    for (const [name, readIn] of [...required].sort()) {
      const cells = rows.get(name);
      if (cells === undefined) {
        missing.push(`${name} (read in ${readIn}) has no row in the docs/LLM-JEV.md §5a table`);
        continue;
      }
      if (cells.length !== 4) missing.push(`${name}: ${cells.length + 1} columns, want 5 (name / values / default / effect / reading file)`);
      cells.forEach((c, i) => {
        if (c.length === 0) missing.push(`${name}: column ${i + 2} is empty`);
      });
    }
    expect(missing).toEqual([]);
  });

  it('every row names a switch that is actually read under src/ (no phantom rows)', () => {
    const phantom = [...tableRows().keys()].filter((n) => !SRC.some((f) => f.text.includes(`'${n}'`)));
    expect(phantom).toEqual([]);
  });

  it('each row cites a reading file that exists and contains the switch name', () => {
    const wrong: string[] = [];
    for (const [name, cells] of tableRows()) {
      const cited = [...(cells[3] ?? '').matchAll(/`(src\/[^`]+?\.ts)[^`]*`/g)].map((m) => m[1] as string);
      if (cited.length === 0) {
        wrong.push(`${name}: the last column must cite the file the switch is read in`);
        continue;
      }
      cited.forEach((c, i) => {
        const f = SRC.find((x) => x.path === c);
        if (f === undefined) {
          wrong.push(`${name}: cited ${c}, which does not exist`);
          return;
        }
        // The FIRST file cited is the one that owns the switch: it must spell the name. The rest are the files that
        // consume or set it, and they legitimately go through the exported constant instead of the literal.
        if (i === 0 && !f.text.includes(`'${name}'`)) wrong.push(`${name}: the first file cited (${c}) does not spell it`);
      });
    }
    expect(wrong).toEqual([]);
  });

  it('every reader function the last column names really exists under src/', () => {
    // Review F22-3: the row for JEVCODE_DEADLINE_GROWTH cited `deadlineGrowthMode`, which is not a symbol in this
    // tree (the type is `DeadlineGrowthMode`, the reader is `deadlineGrowthFrom`). Checking the FILE was not enough.
    const wrong: string[] = [];
    for (const [name, cells] of tableRows()) {
      const idents = [...(cells[3] ?? '').matchAll(/`([A-Za-z0-9_]+)`/g)]
        .map((m) => m[1] as string)
        .filter((id) => /^[a-z][A-Za-z0-9]*$/.test(id));
      for (const id of idents) {
        const re = new RegExp(`(^|[^A-Za-z0-9_$])${id}([^A-Za-z0-9_$]|$)`);
        if (!SRC.some((f) => re.test(f.text))) wrong.push(`${name}: the last column names \`${id}\`, which is not a symbol under src/`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the JEVCODE_CASE_TIMEOUT_MS row states the effect the sieve and the quixbugs runner actually give it', () => {
    // Review F22-4: the row said an exported value "changes every lane of every QuixBugs run". It does not — the
    // sieve overwrites it on a pytest lane with a measured per-test timeout, and a sieve QuixBugs lane takes its
    // limit on the command line. Both halves are pinned against the source here, not just against the prose.
    const sieve = SRC.find((f) => f.path === 'src/synth/sieve/runner.ts');
    expect(sieve, 'src/synth/sieve/runner.ts should exist').toBeDefined();
    const text = (sieve as { text: string }).text;
    expect(text, 'laneRunEnv sets the switch only for a pytest lane with a measured timeout').toContain(
      "if (oracle.runner === 'pytest' && oracle.perTestTimeoutMs !== null) {",
    );
    expect(text, 'a sieve quixbugs lane takes its limit on the command line instead').toContain(
      "if (oracle.runner === 'quixbugs') return quixbugsLaneCommand(",
    );

    const effect = (tableRows().get('JEVCODE_CASE_TIMEOUT_MS') ?? [])[2] ?? '';
    expect(effect.length, 'the row must exist and carry an effect').toBeGreaterThan(0);
    expect(effect, 'the row may not claim an exported value binds every QuixBugs lane').not.toContain('changes every lane of every QuixBugs run');
    expect(effect, 'the row must name the module the switch actually reaches').toContain('src/bench/quixbugs/pytest.ts');
    expect(effect, 'the row must name the sieve override').toMatch(/sieve/i);
    expect(effect, 'the row must name the command-line limit that bypasses it').toMatch(/command line/i);
  });

  it('docs/DESIGN.md §22 links the table, so the switch list is reachable from the main design doc', () => {
    expect(readFileSync(join(ROOT, 'docs/DESIGN.md'), 'utf8')).toContain('docs/LLM-JEV.md` §5a');
  });
});
