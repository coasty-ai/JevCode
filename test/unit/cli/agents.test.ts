/**
 * TUI-DESIGN-5 §4.2 / §4.9 / §13.3 / gate G-R5-10 (R5-4's §10 `cli/agents.test.ts`).
 *
 * `jevcode agents list --json` over **fixtures**, with the engine never started: the verb reads a run directory's
 * `orchestrate/manifest-<step>.json` through `node:fs` and folds it into `AgentRow`s. Nothing here opens a ledger,
 * starts a run or touches the network.
 *
 * It also carries the §14.2 #7 reachability check — the defect where `jevcode agents list` was named as a
 * deliverable in five sections while `Command` never gained the member, so the verb was unreachable **and**
 * G-R5-10 would have passed with it absent.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, type Command } from '../../../src/cli/args.js';
import { AGENTS_VERBS, agentsList, manifestRows, plannedRow, runAgents, type AgentsIo } from '../../../src/cli/agents.js';
import { EXIT_CODES } from '../../../src/errors.js';
import { mkAgentRow, mkAgentSpec, mkManifest } from '../tui/agents/fixtures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Sink {
  out: string[];
  err: string[];
  io: AgentsIo;
}

function fixture(opts: { manifest?: ReturnType<typeof mkManifest> | null; runId?: string } = {}): Sink & { runsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'jevcode-agents-'));
  dirs.push(root);
  const runsDir = join(root, 'runs');
  const runId = opts.runId ?? '20260922-101010-abcdefgh';
  mkdirSync(join(runsDir, runId, 'orchestrate'), { recursive: true });
  const m = opts.manifest === undefined ? mkManifest({ runId }) : opts.manifest;
  if (m !== null) writeFileSync(join(runsDir, runId, 'orchestrate', `manifest-${m.step}.json`), JSON.stringify(m));
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, runsDir, io: { stdout: { write: (s: string) => out.push(s), columns: 120 }, stderr: { write: (s: string) => err.push(s) }, runsDir } };
}

describe('jevcode agents list (§4.2, §13.3)', () => {
  it('--json is exactly `{ agents, manifest }` and serialises AgentRow, never the row string', async () => {
    const f = fixture();
    expect(await agentsList(f.io, { json: true })).toBe(EXIT_CODES.ok);
    const parsed: unknown = JSON.parse(f.out.join(''));
    expect(Object.keys(parsed as object).sort()).toEqual(['agents', 'manifest']);
    const o = parsed as { agents: { slug: string; state: string; capUsd: number }[]; manifest: { manifestId: string } | null };
    expect(o.agents.map((a) => a.slug)).toEqual(['tui-rows', 'fix-store', 'test-fixture']);
    expect(o.agents.every((a) => a.state === 'planned')).toBe(true);
    expect(o.manifest?.manifestId).toBe('m-1');
    // the row STRING is nowhere in the json (§13.1)
    expect(f.out.join('')).not.toContain('queued');
  });

  it('the human form prints the same rows the tab draws, one per agent (§13.2 clause 6)', async () => {
    const f = fixture();
    expect(await agentsList(f.io)).toBe(EXIT_CODES.ok);
    const lines = f.out.join('').trimEnd().split('\n');
    expect(lines[0]).toBe('agents (3)');
    expect(lines).toHaveLength(4);
    for (const slug of ['tui-rows', 'fix-store', 'test-fixture']) expect(f.out.join('')).toContain(slug);
    expect(f.out.join('')).toContain('queued');
  });

  it('a run with no manifest answers honestly (D-AN / §12.3 S85), never an empty frame', async () => {
    const f = fixture({ manifest: null });
    expect(await agentsList(f.io)).toBe(EXIT_CODES.ok);
    expect(f.out.join('')).toBe('agents is not available in this build — no agent is running\n');
  });

  it('a missing runs directory is the same honest answer, never a throw', async () => {
    const out: string[] = [];
    const io: AgentsIo = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => undefined }, runsDir: join(tmpdir(), 'jevcode-does-not-exist-9d21ee0') };
    expect(await agentsList(io)).toBe(EXIT_CODES.ok);
    expect(out.join('')).toContain('not available in this build');
  });

  it('a corrupt manifest is ignored rather than thrown (the verb never crashes a shell script)', async () => {
    const f = fixture({ manifest: null });
    writeFileSync(join(f.runsDir, '20260922-101010-abcdefgh', 'orchestrate', 'manifest-3.json'), '{ not json');
    expect(await agentsList(f.io, { json: true })).toBe(EXIT_CODES.ok);
    expect(JSON.parse(f.out.join(''))).toEqual({ agents: [], manifest: null });
  });

  it('the NEWEST manifest wins when a run re-decomposed', async () => {
    const f = fixture();
    const later = mkManifest({ step: 19, manifestId: 'm-2', agents: [mkAgentSpec({ slug: 'only-one' })] });
    writeFileSync(join(f.runsDir, '20260922-101010-abcdefgh', 'orchestrate', 'manifest-19.json'), JSON.stringify(later));
    await agentsList(f.io, { json: true });
    const o = JSON.parse(f.out.join('')) as { agents: { slug: string }[]; manifest: { manifestId: string } };
    expect(o.manifest.manifestId).toBe('m-2');
    expect(o.agents.map((a) => a.slug)).toEqual(['only-one']);
  });

  it('live rows, when a supervisor ever supplies them, replace the planned fold', async () => {
    const f = fixture();
    const io: AgentsIo = { ...f.io, rows: async () => [mkAgentRow({ slug: 'live-one', state: 'running' })] };
    await agentsList(io, { json: true });
    const o = JSON.parse(f.out.join('')) as { agents: { slug: string; state: string }[] };
    expect(o.agents).toEqual([expect.objectContaining({ slug: 'live-one', state: 'running' })]);
  });

  it('an unknown verb is exit 2 with a named list, never a silent 0', async () => {
    const f = fixture();
    expect(await runAgents(['frobnicate'], f.io)).toBe(EXIT_CODES.config);
    expect(f.err.join('')).toContain("unknown verb 'frobnicate'");
    expect(AGENTS_VERBS).toEqual(['list']);
    expect(await runAgents([], f.io)).toBe(EXIT_CODES.ok);
  });

  it('§13.2 clause 1: under a PIPE (no `stdout.columns`) the human form is the 120-column one, not 80', async () => {
    const f = fixture();
    const piped: AgentsIo = { ...f.io, stdout: { write: (s: string) => f.out.push(s) } };
    expect(piped.stdout.columns).toBeUndefined();
    expect(await agentsList(piped)).toBe(EXIT_CODES.ok);
    const rows = f.out.join('').split('\n').filter((l) => l.trim() !== '');
    expect(rows[0]).toBe('agents (3)');
    // the spend / wall columns the 80-cell default dropped survive the pipe
    expect(rows.join('\n')).toContain('$0.00/0.30');
    // and it is byte-identical to the explicit 120 form (one producer, one width rule)
    const wide: string[] = [];
    await agentsList({ ...f.io, stdout: { write: (s: string) => wide.push(s), columns: 120 } });
    expect(f.out.join('')).toBe(wide.join(''));
  });

  it('plannedRow / manifestRows carry the spec through without inventing a number', () => {
    const m = mkManifest();
    const rows = manifestRows(m);
    expect(rows).toHaveLength(3);
    const spec = m.agents[0];
    const row = plannedRow(spec!);
    expect(row).toMatchObject({ slug: spec!.slug, state: 'planned', step: 0, spendUsd: 0, wallMs: 0, capUsd: spec!.capUsd, maxSteps: spec!.maxSteps, own: spec!.own, branch: spec!.branch, verify: spec!.verify });
  });
});

describe('§14.2 #7: the verb is REACHABLE (gate G-R5-10)', () => {
  // comments are stripped first: `src/cli/main.tsx` DOCUMENTS the unlanded arms in a docblock, and a check that
  // a comment satisfies is exactly the vacuous gate §14.2 #7 is about
  const main = readFileSync(join(ROOT, 'src/cli/main.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const armFor = (c: string): boolean => new RegExp(`case '${c}':`).test(main);

  it('every member of COMMANDS that main.tsx dispatches has a `case` arm — so a member can never be added without one', () => {
    const missing = COMMANDS.filter((c) => !armFor(c));
    expect(missing, `no switch arm in src/cli/main.tsx for: ${missing.join(', ')}`).toEqual([]);
  });

  it("`'agents'` and its arm move TOGETHER (the defect: the member was named in five sections and never added)", () => {
    // NOTE: this iff is satisfied while BOTH are false, which is why it cannot be the reachability check on its
    // own — §14.2 #7's vacuity is exactly a green gate over an unreachable verb. The literal assertion below is.
    const inUnion = (COMMANDS as readonly string[]).includes('agents');
    expect(inUnion, "src/cli/args.ts Command += 'agents' and src/cli/main.tsx `case 'agents':` are one PR (R5-4's §9.2 request to R5-6, W4)").toBe(armFor('agents'));
  });

  /**
   * §10's own words: "`cli/agents.test.ts` also asserts `COMMANDS` contains `'agents'` and that `src/cli/main.tsx`'s
   * switch has the arm — the check that makes the verb reachable". Both are R5-4's §9.2 REQUESTS on files R5-6
   * owns (`src/cli/args.ts`, `src/cli/main.tsx`, W4), so the assertion was written **failing-first**. The
   * integration pass landed both in one PR, so this is the flip the comment asked for: `it.fails` → `it`.
   * Either way the gate can never be green over an unreachable `jevcode agents list`.
   */
  it("COMMANDS contains 'agents' and main.tsx has the arm (R5-4's §9.2 request, landed in R5-6's W4 PR)", () => {
    expect(COMMANDS).toContain('agents');
    expect(armFor('agents'), "src/cli/main.tsx needs `case 'agents':` calling `await import('./agents.js')`").toBe(true);
  });

  it('`src/cli/agents.ts` exists and exports the entry point the arm calls', () => {
    expect(typeof runAgents).toBe('function');
    expect(typeof agentsList).toBe('function');
  });

  it('the COMMANDS array has no duplicate member', () => {
    expect(new Set<Command>(COMMANDS).size).toBe(COMMANDS.length);
  });
});
