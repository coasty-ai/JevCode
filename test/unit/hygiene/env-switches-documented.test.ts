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
 * "Changes run behaviour" is decided mechanically, not by taste:
 *  (A) every `export const … = 'JEVCODE_…'` declared under `src/`, EXCEPT under the TUI-owned trees (`src/tui`,
 *      `src/cli`, `src/config`, `src/session`, `src/chat`) whose switches are presentation or settings and are
 *      documented with the settings table instead; plus
 *  (B) a short explicit list of switches read by a literal subscript rather than through a named constant. Each
 *      entry carries the file it is read in, and the test re-checks that it really is read there — so the list
 *      cannot silently go stale.
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

/** (B) switches read as a literal subscript; the file is re-checked so the list cannot rot. */
const LITERAL_SWITCHES: readonly { name: string; readIn: string }[] = [
  { name: 'JEVCODE_ROUTERS', readIn: 'src/jev/router.ts' },
  { name: 'JEVCODE_FASTPATH', readIn: 'src/loop/engine.ts' },
  { name: 'JEVCODE_BENCH_CONTEXT', readIn: 'src/bench/conditions.ts' },
];

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
  const required = new Map<string, string>(constantSwitches());
  for (const { name, readIn } of LITERAL_SWITCHES) required.set(name, readIn);

  it('the two discovery rules find the switches this pass verified (nine, including the four that were documented nowhere)', () => {
    const names = [...required.keys()].sort();
    expect(names).toEqual([
      'JEVCODE_BENCH_CONTEXT',
      'JEVCODE_CASE_TIMEOUT_MS',
      'JEVCODE_DEADLINE_GROWTH',
      'JEVCODE_FASTPATH',
      'JEVCODE_HEDGE',
      'JEVCODE_JEV',
      'JEVCODE_MAX_CASE_TIMEOUTS',
      'JEVCODE_ROUTERS',
      'JEVCODE_WARM',
    ]);
  });

  it('every literal-subscript entry is really read where the list says it is', () => {
    for (const { name, readIn } of LITERAL_SWITCHES) {
      const f = SRC.find((x) => x.path === readIn);
      expect(f, `${readIn} should exist`).toBeDefined();
      expect((f as { text: string }).text, `${name} should be read in ${readIn}`).toContain(`'${name}'`);
    }
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

  it('docs/DESIGN.md §22 links the table, so the switch list is reachable from the main design doc', () => {
    expect(readFileSync(join(ROOT, 'docs/DESIGN.md'), 'utf8')).toContain('docs/LLM-JEV.md` §5a');
  });
});
