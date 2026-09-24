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
 * figures it does print are read back out of that script. And one channel pin: RELEASE.md and the install page name the same
 * install commands, and neither carries the pre-pipeline claims.
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
 * Claims this pass verified CLOSED on `main` @ `d297b29`. `symbol` must be present in `definedIn`; `staleTexts` are the
 * exact spellings the doc must no longer carry OUTSIDE a strike — a set, not one needle, because review F21-1 showed one
 * spelling of a retired claim leaves the other three un-guarded.
 */
const CLOSED: readonly { id: string; file: string; symbol: string; definedIn: string; staleTexts: readonly string[] }[] = [
  {
    id: 'DESIGN §22.10 — jev-only is no longer the default',
    file: 'docs/DESIGN.md',
    symbol: "DEFAULT_MODE: EngineMode = 'llm-jev'",
    definedIn: 'src/config/defaults.ts',
    staleTexts: ['`jev-only` remains the default'],
  },
  {
    id: 'DESIGN §22.10 — StepRecord.verify is filled',
    file: 'docs/DESIGN.md',
    symbol: 'record.verify = this.verifySummary',
    definedIn: 'src/loop/engine.ts',
    staleTexts: ['`StepRecord.verify` is typed but never filled'],
  },
  {
    id: 'DESIGN §22.10 — cancelled rows carry onCancelled',
    file: 'docs/DESIGN.md',
    symbol: 'onCancelled',
    definedIn: 'src/loop/engine.ts',
    staleTexts: ['does not pass\n  `GenerateOptions.onCancelled`'],
  },
  {
    id: 'DESIGN §22.10 — the CONDITIONS arms exist',
    file: 'docs/DESIGN.md',
    symbol: "'llm-sieve', 'jev-off-tuned'",
    definedIn: 'src/cli/args.ts',
    staleTexts: ['`src/cli/args.ts CONDITIONS` does not list `llm-sieve`'],
  },
  {
    id: 'LLM-LOOP §1.8 / §6 row 15 — runFactsRef is gone',
    file: 'docs/LLM-LOOP-DESIGN.md',
    symbol: 'RUN_FACTS_MAX',
    definedIn: 'src/synth/introspect/facts.ts',
    staleTexts: ['`runFactsRef` is process-global'],
  },
  {
    id: 'LLM-LOOP §3.6 item 6 — --quick is typeable',
    file: 'docs/LLM-LOOP-DESIGN.md',
    symbol: "{ key: 'quick', name: 'quick'",
    definedIn: 'src/cli/args.ts',
    staleTexts: ["remains unreachable from a command line until `src/cli/args.ts` carries the\n   `'quick'` row"],
  },
  {
    id: 'LLM-JEV §0 — the warm plane no longer defaults on',
    file: 'docs/LLM-JEV.md',
    symbol: 'warmRequested',
    definedIn: 'src/synth/warm/plane.ts',
    staleTexts: ['`warmModeFor` defaults the plane on for every\n`quixbugs` and `pytest` runner.'],
  },
  {
    id: 'TUI-DESIGN-5 D-AG — llm-jev is inside contextEnabled',
    file: 'docs/TUI-DESIGN-5.md',
    symbol: "this.contextEnabled = this.contextPolicy.view === 'relaxed'",
    definedIn: 'src/loop/engine.ts',
    // Review F21-1: one spelling was not enough. Three further sites still carried the pre-R13 guard un-struck —
    // §1.1 item 3's tail, §7 row 35 cells 3 and 4, §14.2 row #4 — and none of them matched the original needle.
    staleTexts: [
      'excludes it from `contextEnabled`',
      'engine.ts:922',
      'Until R13 lands',
      'until §8.2 R13 lands',
      '(`jev-on`/`jev-off` only)',
      'are empty in the product\'s default mode',
    ],
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
  it.each(CLOSED)('$id', ({ file, symbol, definedIn, staleTexts }) => {
    expect(srcHits(symbol), `${symbol} should be in ${definedIn}`).toContain(definedIn);
    const live = unstruck(file);
    for (const staleText of staleTexts) {
      expect(live, `${file} still carries, un-struck, a claim main falsifies: ${JSON.stringify(staleText)}`).not.toContain(staleText);
    }
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

  it('no doc restates the pack-size constants: every figure printed beside one is the script\'s own', () => {
    // Review F22-2: the pin read only docs/RELEASE.md, so docs/MERGE-QUEUE.md re-created the hand-copied-constant
    // drift RELEASE.md had just shed (`headroom to UNPACKED_MAX | 496,373 | 3_500_000 − 3,003,627`). The scan is
    // now over every doc that names either gate, so a third file cannot reintroduce it either.
    const pack = readFileSync(join(ROOT, 'scripts/check-pack.mjs'), 'utf8');
    const num = (name: string): number => {
      const m = new RegExp(`const ${name} = ([0-9_]+)`).exec(pack);
      expect(m, `scripts/check-pack.mjs must declare ${name}`).not.toBeNull();
      return Number((m as RegExpExecArray)[1]?.replace(/_/g, ''));
    };
    const gates = [['UNPACKED_MAX', num('UNPACKED_MAX')], ['TARBALL_MAX', num('TARBALL_MAX')]] as const;
    expect(gates[0][1]).toBeGreaterThan(0);

    const docs = readdirSync(join(ROOT, 'docs'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => ({ path: `docs/${n}`, text: doc(`docs/${n}`) }))
      .filter((d) => gates.some(([label]) => d.text.includes(label)));
    const naming = docs.map((d) => d.path);
    expect(naming, 'RELEASE.md must still name the gate').toContain('docs/RELEASE.md');
    expect(naming, 'MERGE-QUEUE.md spends the headroom, so it must cite the gate too').toContain('docs/MERGE-QUEUE.md');

    const wrong: string[] = [];
    for (const d of docs) {
      if (!d.text.includes('`scripts/check-pack.mjs`')) wrong.push(`${d.path} names a size gate without citing scripts/check-pack.mjs`);
      for (const [label, value] of gates) {
        for (const m of d.text.matchAll(new RegExp(`${label}[^\\n]*?([0-9][0-9,_]{5,})`, 'g'))) {
          const printed = Number((m[1] as string).replace(/[,_]/g, ''));
          if (printed !== value) wrong.push(`${d.path} prints ${m[1] as string} beside ${label}, which is ${value}`);
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(doc('docs/RELEASE.md'), 'the stale "< 2 MB" figure predates the raise to 3,500,000').not.toMatch(/unpacked < 2 MB/);
  });

  it('the release runbook and the install page agree on the channels and drop the pre-pipeline claims', () => {
    const release = doc('docs/RELEASE.md');
    const install = doc('docs/getting-started/install.md');
    // npm trusted publishing cannot create a package, and the owner strings were fixed before this pass.
    expect(release).not.toContain('first publish can be done from CI directly');
    expect(release).not.toContain('still name an older owner');
    expect(install).not.toContain('## Not available yet');
    expect(install, 'the proof line must not pin a stale version').not.toMatch(/# jevcode \d+\.\d+\.\d+/);
    // Job summaries point at one-time steps by number: npm 5, Homebrew 6, AUR 7, Nix 8.
    for (const step of ['### 5. npm', '### 6. Homebrew tap', '### 7. AUR', '### 8. Nix lock']) expect(release).toContain(step);
    for (const cmd of [
      'npm i -g @coasty/jevcode', 'npx @coasty/jevcode', 'bunx @coasty/jevcode', 'pnpm dlx @coasty/jevcode', 'yarn dlx @coasty/jevcode',
      'mise use -g npm:@coasty/jevcode', 'brew install coasty-ai/jevcode/jevcode', 'yay -S jevcode', 'nix run github:coasty-ai/JevCode',
    ]) {
      expect(release, `RELEASE.md channel table: ${cmd}`).toContain(cmd);
      expect(install, `install.md channel table: ${cmd}`).toContain(cmd);
    }
    // the npm package is scoped: npm refused the unscoped name, so an unscoped npm install command installs nothing
    const unscoped = /(?:npm i(?:nstall)?(?: -g)?|npx(?: -y)?|bunx|pnpm dlx|pnpm add -g|yarn dlx|bun i -g|npm:|npm view|npm dist-tag add|npm deprecate) jevcode\b|npm:jevcode\b|registry\.npmjs\.org\/jevcode\b|npmjs\.com\/package\/jevcode\b/;
    for (const [name, text] of [['docs/RELEASE.md', release], ['docs/getting-started/install.md', install], ['docs/contributing/releasing.md', doc('docs/contributing/releasing.md')]] as const) {
      expect(text, `${name}: an unscoped npm name`).not.toMatch(unscoped);
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
