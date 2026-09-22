/**
 * `scripts/jev-contract.mjs` — the four-clause Jev-safety contract of HARNESS-NEXT-DESIGN §1.2 as a lint (wave S0).
 *
 * The rule has to hold on this tree (it runs from `npm run check`), and it has to actually catch the four ways a
 * router can break the principle, so each case is driven against a fixture tree: a router call site with no
 * contract block, a block missing a clause, a fallback whose named test does not exist, a Question spelled out by
 * hand instead of built by `src/jev/questions.ts`, and an answer that feeds a correctness gate.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'jev-contract.mjs');
const REPO = join(import.meta.dirname, '..', '..', '..');

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'jev-contract-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function lint(root: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const GOOD_BLOCK = `  // jev-contract: R1 run_first (§3.x)
  //   escape: choice() over the code-built scopes — ESCAPE_KEY, argmax only beyond the 0.05 margin
  //   guard: the scope-usability check runs after the answer and can only narrow it
  //   fallback: scopeBuilderFor() narrowest code scope, then the full suite; test: test/unit/scope.test.ts
  //   no-gating: ordering only — completion stays isCompleteByFact() on the harness's own run`;

function router(block: string, body = 'const order = rank(res);\n  return order;'): string {
  return `import { choice } from '../jev/questions.js';\nexport async function routeRunFirst(ctx) {\n${block}\n  const res = await ctx.ask('propose', state, { run_first: choice('which first?', scopes) });\n  ${body}\n}\n`;
}

describe('the jev-contract lint', () => {
  it('passes on this repository (it runs from npm run check)', () => {
    const r = lint(REPO);
    expect(r.out).toContain('jev-contract: ok');
    expect(r.code).toBe(0);
  });

  it('accepts a router whose site proves the four clauses and names an existing fallback test', () => {
    const root = tree({ 'src/synth/oracle/scope.ts': router(GOOD_BLOCK), 'test/unit/scope.test.ts': '// the fallback test\n' });
    const r = lint(root);
    expect(r.out).toContain('1 with a four-clause block');
    expect(r.code).toBe(0);
  });

  it('refuses a Jev call site with no contract block and no allow-list row', () => {
    const root = tree({ 'src/synth/oracle/scope.ts': router('  // pick a scope') });
    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no jev-contract block and no allow-list row');
  });

  it('refuses a block that is missing a clause', () => {
    const block = GOOD_BLOCK.split('\n').filter((l) => !l.includes('no-gating:')).join('\n');
    const root = tree({ 'src/synth/oracle/scope.ts': router(block), 'test/unit/scope.test.ts': '\n' });
    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('missing the "no-gating:" clause');
  });

  it('refuses a fallback whose named unit test does not exist (clause 3: every fallback is driven by a throwing Decider)', () => {
    const root = tree({ 'src/synth/oracle/scope.ts': router(GOOD_BLOCK) });
    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the named fallback test test/unit/scope.test.ts does not exist');
  });

  it('refuses an answer that feeds a correctness gate (clause 4)', () => {
    const root = tree({ 'src/synth/oracle/scope.ts': router(GOOD_BLOCK, 'const complete = res.answers.run_first.choice !== "none_of_these";\n  return complete;'), 'test/unit/scope.test.ts': '\n' });
    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('clause 4');
  });

  it('refuses a hand-built Question in a file that asks (clause 1: the builders own the escape rule)', () => {
    const body = `import { x } from './y.js';\nexport async function ask(ctx) {\n  const q = { type: 'choice', instructions: 'pick', criteria: { a: null } };\n  return ctx.ask('propose', {}, { q });\n}\n`;
    const root = tree({ 'src/synth/oracle/scope.ts': body });
    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('clause 1: build the Question with src/jev/questions.ts');
  });

  it('ignores a forwarder that only passes an ask through, and a Question literal in a file that never asks', () => {
    const forwarder = `export const adapter = (ctx) => ({\n  ask: (stage, state, questions) => ctx.ask(stage, state, questions),\n});\n`;
    const fixture = `export const sample = { type: 'score', instructions: 'how much?', criteria: ['none', 'some'] };\n`;
    const root = tree({ 'src/tui/adapter.ts': forwarder, 'src/perf/fixture.ts': fixture });
    const r = lint(root);
    expect(r.out).toContain('jev-contract: ok');
    expect(r.code).toBe(0);
  });

  it('exits 2 when the root has no src directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-contract-empty-'));
    roots.push(root);
    rmSync(join(root, 'src'), { recursive: true, force: true });
    expect(lint(root).code).toBe(2);
  });
});
