/**
 * Guard (finishing pass F21): the design documents state "not landed" in the present tense and nothing re-reads them when the
 * thing lands. This extends `design-status.test.ts`'s symbol-absence pattern past §9.3 to every doc that carries such a claim.
 *
 * Two kinds of assertion, both mechanical:
 *  - CLOSED: a claim this pass verified FALSE on `main` @ `d297b29`. The cited symbol is asserted PRESENT in `src/` (so the row
 *    cannot rot into a vacuous pass) and the doc is asserted not to carry the stale sentence again.
 *  - OPEN: a claim this pass verified TRUE. The cited symbol is asserted ABSENT (or the constant asserted unchanged), so the day
 *    it lands this test goes red and the bullet has to move.
 *
 * Plus one drift pin: `docs/RELEASE.md` may not restate the pack-size constants, it must cite `scripts/check-pack.mjs`, and the
 * figures it does print are read back out of that script.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const doc = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/**
 * The doc with every `~~struck~~` span removed. A strike-through is the document's own signal that the sentence inside it is
 * no longer true and is kept only so the history of the claim survives — so "the doc still claims X" means "X survives OUTSIDE
 * a strike". `~~` markers must pair up, or the elision itself would be the bug.
 */
function unstruck(p: string): string {
  const text = doc(p);
  expect((text.match(/~~/g) ?? []).length % 2, `${p}: unbalanced ~~ strike markers`).toBe(0);
  return text.replace(/~~[\s\S]*?~~/g, ' ⟨struck⟩ ');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const SRC_FILES = walk(join(ROOT, 'src'));

/** Repo-relative `src/**` files containing `needle` (a literal, matched whole-word where it looks like an identifier). */
function srcHits(needle: string): string[] {
  const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(needle);
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = ident ? new RegExp(`(^|[^A-Za-z0-9_$])${esc}([^A-Za-z0-9_$]|$)`) : new RegExp(esc);
  return SRC_FILES.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
}

/**
 * Claims this pass verified CLOSED on `main` @ `d297b29`. `symbol` must be present in `definedIn`; `staleText` is the exact
 * spelling the doc must no longer carry.
 */
const CLOSED: readonly { id: string; file: string; symbol: string; definedIn: string; staleText: string }[] = [
  {
    id: 'DESIGN §22.10 — jev-only is no longer the default',
    file: 'docs/DESIGN.md',
    symbol: "DEFAULT_MODE: EngineMode = 'llm-jev'",
    definedIn: 'src/config/defaults.ts',
    staleText: '`jev-only` remains the default',
  },
  {
    id: 'DESIGN §22.10 — StepRecord.verify is filled',
    file: 'docs/DESIGN.md',
    symbol: 'record.verify = this.verifySummary',
    definedIn: 'src/loop/engine.ts',
    staleText: '`StepRecord.verify` is typed but never filled',
  },
  {
    id: 'DESIGN §22.10 — cancelled rows carry onCancelled',
    file: 'docs/DESIGN.md',
    symbol: 'onCancelled',
    definedIn: 'src/loop/engine.ts',
    staleText: 'does not pass\n  `GenerateOptions.onCancelled`',
  },
  {
    id: 'DESIGN §22.10 — the CONDITIONS arms exist',
    file: 'docs/DESIGN.md',
    symbol: "'llm-sieve', 'jev-off-tuned'",
    definedIn: 'src/cli/args.ts',
    staleText: '`src/cli/args.ts CONDITIONS` does not list `llm-sieve`',
  },
  {
    id: 'LLM-LOOP §1.8 / §6 row 15 — runFactsRef is gone',
    file: 'docs/LLM-LOOP-DESIGN.md',
    symbol: 'RUN_FACTS_MAX',
    definedIn: 'src/synth/introspect/facts.ts',
    staleText: '`runFactsRef` is process-global',
  },
  {
    id: 'LLM-LOOP §3.6 item 6 — --quick is typeable',
    file: 'docs/LLM-LOOP-DESIGN.md',
    symbol: "{ key: 'quick', name: 'quick'",
    definedIn: 'src/cli/args.ts',
    staleText: "remains unreachable from a command line until `src/cli/args.ts` carries the\n   `'quick'` row",
  },
  {
    id: 'LLM-JEV §0 — the warm plane no longer defaults on',
    file: 'docs/LLM-JEV.md',
    symbol: 'warmRequested',
    definedIn: 'src/synth/warm/plane.ts',
    staleText: '`warmModeFor` defaults the plane on for every\n`quixbugs` and `pytest` runner.',
  },
  {
    id: 'TUI-DESIGN-5 D-AG — llm-jev is inside contextEnabled',
    file: 'docs/TUI-DESIGN-5.md',
    symbol: "this.contextEnabled = this.contextPolicy.view === 'relaxed'",
    definedIn: 'src/loop/engine.ts',
    staleText: 'excludes it from `contextEnabled`',
  },
];

/** Claims this pass verified still OPEN. The symbol must stay absent (or the shape must stay as described). */
const OPEN: readonly { id: string; absent?: string; check?: () => void }[] = [
  { id: 'runFactsRef really is gone from src/**', absent: 'runFactsRef' },
  { id: 'src/loop/replay.ts (M15) still does not exist', absent: 'replay.ts does not exist' },
  {
    id: "ReasoningEffort still lacks 'high'",
    check: () => {
      const t = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8');
      expect(t).toContain("export type ReasoningEffort = 'low' | 'medium';");
    },
  },
  {
    id: 'llm-sieve is still not wired in createSynthesizer (DESIGN keeps the bullet, owner F06)',
    check: () => {
      expect(doc('docs/DESIGN.md')).toContain('**`llm-sieve` is not wired**');
    },
  },
  {
    id: 'the typed revert marker is still absent (DESIGN keeps the bullet)',
    check: () => {
      expect(doc('docs/DESIGN.md')).toContain('**Typed revert marker**');
      expect(srcHits('revertMarker')).toEqual([]);
    },
  },
];

describe('design-doc claims match main', () => {
  it.each(CLOSED)('$id', ({ file, symbol, definedIn, staleText }) => {
    expect(srcHits(symbol), `${symbol} should be in ${definedIn}`).toContain(definedIn);
    expect(unstruck(file), `${file} still carries, un-struck, a claim main falsifies: ${JSON.stringify(staleText)}`).not.toContain(staleText);
  });

  it.each(OPEN)('$id', ({ absent, check }) => {
    if (absent === 'replay.ts does not exist') {
      expect(SRC_FILES.map((f) => relative(ROOT, f))).not.toContain('src/loop/replay.ts');
      return;
    }
    if (absent !== undefined) expect(srcHits(absent)).toEqual([]);
    check?.();
  });

  it('LLM-LOOP §6 row 14 states scopeUsable as BUILT — it is written only on an armed step', () => {
    const engine = readFileSync(join(ROOT, 'src/loop/engine.ts'), 'utf8');
    // The record write sits inside the `draft.fastPath !== null` guard: I2's byte identity, not an oversight.
    const guard = engine.indexOf('if (draft.fastPath !== null) {');
    expect(guard).toBeGreaterThan(-1);
    const write = engine.indexOf('record.scopeUsable =');
    expect(write).toBeGreaterThan(guard);
    expect(engine.slice(guard, write)).not.toContain('\n    }');

    const d = doc('docs/LLM-LOOP-DESIGN.md');
    expect(d, 'row 14 may not claim the member is recorded on every step').not.toContain('is recorded on every step even with the fast path off');
    expect(d, "row 14 must carry types.ts's as-built sentence").toContain('the member is written only on an ARMED step');
    expect(d, 'the judge hole belongs in §9.1 with an owner').toMatch(/§9\.1[\s\S]*The `scopeUsable` hole in the \*\*judge\*\*[\s\S]*owner/);
  });

  it('RELEASE.md cites scripts/check-pack.mjs instead of restating its constants, and the figures it prints match', () => {
    const rel = doc('docs/RELEASE.md');
    const pack = readFileSync(join(ROOT, 'scripts/check-pack.mjs'), 'utf8');
    const num = (name: string): number => {
      const m = new RegExp(`const ${name} = ([0-9_]+)`).exec(pack);
      expect(m, `scripts/check-pack.mjs must declare ${name}`).not.toBeNull();
      return Number((m as RegExpExecArray)[1]?.replace(/_/g, ''));
    };
    const unpacked = num('UNPACKED_MAX');
    const tarball = num('TARBALL_MAX');
    expect(unpacked).toBeGreaterThan(0);

    expect(rel, 'the gate is the script, so RELEASE.md must name it as the source of truth').toContain('`scripts/check-pack.mjs`');
    expect(rel, 'the stale "< 2 MB" figure predates the raise to 3,500,000').not.toMatch(/unpacked < 2 MB/);
    // Any byte figure RELEASE.md does print for these two gates must be the script's own.
    for (const [label, value] of [['UNPACKED_MAX', unpacked], ['TARBALL_MAX', tarball]] as const) {
      const printed = [...rel.matchAll(new RegExp(`${label}[^\\n]*?([0-9][0-9,_]{5,})`, 'g'))].map((m) => Number((m[1] as string).replace(/[,_]/g, '')));
      for (const p of printed) expect(p, `RELEASE.md prints ${p} beside ${label}, which is ${value}`).toBe(value);
    }
  });

  it('the two behaviour deferrals of this pass are filed with an owner', () => {
    const d = doc('docs/LLM-LOOP-DESIGN.md');
    const deferred = d.indexOf('### 9.1 Deferred, with reasons');
    expect(deferred, 'the deferral list must exist').toBeGreaterThan(-1);
    for (const [what, anchor] of [
      ["the fast path's blanket warm_plane refusal", "blanket `warm_plane` refusal"],
      ['S2 on jev-on (the hedge is unreachable)', '`LlmSourceDeps.hedge`'],
    ] as const) {
      const at = d.indexOf(anchor, deferred);
      expect(at, `${what} must be filed in §9.1`).toBeGreaterThan(-1);
      expect(d.slice(at, at + 1200), `${what} must be filed WITH an owner`).toMatch(/\*\*Owner: [^*]+\*\*/);
    }
    expect(d, 'the S2 deferral names finishing-pass F05 as its owner').toMatch(/F05/);
    // Both refusals are real code, not prose: T1's warm gate is unconditional.
    expect(readFileSync(join(ROOT, 'src/loop/stages/fastpath.ts'), 'utf8')).toContain("if (i.warmEnabled) return 'warm_plane';");
  });
});
