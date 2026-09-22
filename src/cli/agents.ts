/**
 * `jevcode agents list [--json]` (TUI-DESIGN-5 §4.2, §4.9, §13.3; gate G-R5-10) — the shell twin of the `'a'` pane
 * tab. It renders **the same rows** as the Ink tab and `--plain`, through the one producer
 * (`src/tui/agents/lines.ts`), and `--json` serialises `AgentRow` / `Manifest`, never the row string (§13.1).
 *
 * Nothing here starts an engine (§10: "`jevcode agents list --json` over fixtures, engine never started"), opens a
 * ledger or reaches the network: the verb reads `<runsDir>/<runId>/orchestrate/manifest-<step>.json` through an
 * injected I/O seam and folds it into rows. `AgentSupervisor` does not exist in this build (§4.0, N1), so there is
 * no live row source — the manifest's agents are reported in their `planned` state and the honest answer to a run
 * with no manifest is S85's `agents is not available in this build — no agent is running`.
 *
 * §4.2's `import type` rule holds here too: `src/orchestrate/index.ts` reaches `node:fs/promises`, so the shapes
 * come from `src/core/types.js` (contract 1.5) and the manifest is parsed locally rather than through the facade —
 * this file is behind `main.tsx`'s `await import()`, but keeping the rule uniform is what makes gate G-R5-1's
 * assertion list checkable by construction.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRow, AgentSpec, Manifest } from '../core/types.js';
import { EXIT_CODES } from '../errors.js';
import { AGENTS_WIDE_COLUMNS, notAvailableText } from '../tui/agents/lines.js';
import { glyphSet } from '../tui/glyphs.js';
import { agentBlockHead, agentBlockLines } from '../tui/plain.js';

/** the verbs `jevcode agents` answers. `list` is the only one round 5 builds (§4.2); the rest are the tab's. */
export type AgentsVerb = 'list';
export const AGENTS_VERBS: readonly AgentsVerb[] = ['list'];

export interface AgentsIo {
  stdout: { write(s: string): unknown; columns?: number | undefined };
  stderr: { write(s: string): unknown };
  runsDir: string;
  /** the run whose manifest is read; `null` = the newest run directory under `runsDir` */
  runId?: string | null;
  ascii?: boolean;
  /** the manifest reader (default: `<runsDir>/<runId>/orchestrate/manifest-*.json`); injected by the tests */
  readManifest?: (runsDir: string, runId: string) => Promise<Manifest | null>;
  /** the live row source. Absent in this build — §4.0: there is no supervisor, so there are no live rows */
  rows?: (runId: string) => Promise<readonly AgentRow[]>;
  /** the run-directory lister (default `fs/promises.readdir`); injected by the tests */
  listRuns?: (runsDir: string) => Promise<readonly string[]>;
}

/**
 * §4.2 / §4.7: one manifest row → one `AgentRow` in its `planned` state. This is the fold the eventual supervisor
 * replaces with live rows; until then it is what makes `jevcode agents list` truthful rather than empty — the
 * manifest IS the agent set, and `planned` → `queued` is exactly the word for "confirmed, not started".
 */
export function plannedRow(a: AgentSpec): AgentRow {
  return {
    slug: a.slug,
    state: 'planned',
    step: 0,
    maxSteps: a.maxSteps,
    stage: 'idle',
    spendUsd: 0,
    capUsd: a.capUsd,
    wallMs: 0,
    maxWallMs: a.maxWallMs,
    own: a.own,
    branch: a.branch,
    verify: a.verify,
    last: '',
    why: '',
  };
}

/** §4.2: every agent of a manifest as a row, in the manifest's own order (the order the planner ranked them in). */
export function manifestRows(m: Manifest): AgentRow[] {
  return m.agents.map(plannedRow);
}

const MANIFEST_RE = /^manifest-(\d+)\.json$/;

/** the newest `manifest-<step>.json` of a run dir, or null. Pure I/O, no facade, no engine. */
async function readNewestManifest(runsDir: string, runId: string): Promise<Manifest | null> {
  const dir = join(runsDir, runId, 'orchestrate');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const steps = names
    .map((n) => MANIFEST_RE.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  const step = steps[0];
  if (step === undefined) return null;
  try {
    const text = await readFile(join(dir, `manifest-${step}.json`), 'utf8');
    const o: unknown = JSON.parse(text);
    return isManifest(o) ? o : null;
  } catch {
    return null;
  }
}

/** a structural check, not a schema: the fields `manifestRows` and `--json` read must be there and be the right shape. */
function isManifest(o: unknown): o is Manifest {
  if (o === null || typeof o !== 'object') return false;
  const m = o as Record<string, unknown>;
  return typeof m['manifestId'] === 'string' && typeof m['runId'] === 'string' && Array.isArray(m['agents']) && m['agents'].every((a) => a !== null && typeof a === 'object' && typeof (a as Record<string, unknown>)['slug'] === 'string');
}

/** the newest run directory under `runsDir` (run ids sort lexicographically by their timestamp prefix). */
async function newestRun(io: AgentsIo): Promise<string | null> {
  try {
    const names = io.listRuns ? await io.listRuns(io.runsDir) : await readdir(io.runsDir);
    return [...names].sort().reverse()[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * §13.3: `jevcode agents list --json` → `{ agents: AgentRow[], manifest: Manifest | null }`, one shape, nothing
 * else. The human form is `agentBlockLines` — the same rows the tab draws, so `r5-identity.test.ts` can compare
 * them under the §5.3 normaliser without a second producer to keep in step.
 */
export async function agentsList(io: AgentsIo, opts: { json?: boolean } = {}): Promise<number> {
  const runId = io.runId ?? (await newestRun(io));
  const manifest = runId === null ? null : await (io.readManifest ?? readNewestManifest)(io.runsDir, runId);
  const live = runId !== null && io.rows ? await io.rows(runId) : null;
  const agents: readonly AgentRow[] = live ?? (manifest === null ? [] : manifestRows(manifest));
  if (opts.json === true) {
    io.stdout.write(`${JSON.stringify({ agents, manifest }, null, 2)}\n`);
    return EXIT_CODES.ok;
  }
  if (agents.length === 0) {
    // D-AN: the honest answer, never an empty frame (§12.3 S85)
    io.stdout.write(`${notAvailableText('agents')}\n`);
    return EXIT_CODES.ok;
  }
  // §13.2 clause 1: `--plain` without a TTY renders the **120**-column form. Under a pipe `stdout.columns` is
  // undefined, and defaulting to 80 would silently drop the branch / verify column the tab shows at 120.
  const columns = typeof io.stdout.columns === 'number' && io.stdout.columns > 0 ? io.stdout.columns : AGENTS_WIDE_COLUMNS;
  const g = glyphSet({ ascii: io.ascii === true });
  io.stdout.write(`${agentBlockHead(agents)}\n`);
  for (const line of agentBlockLines(agents, columns, g)) io.stdout.write(`${line}\n`);
  return EXIT_CODES.ok;
}

/** §4.2 / §14.2 #7: the `case 'agents':` arm of `src/cli/main.tsx`'s `switch (command)` calls this. */
export async function runAgents(args: readonly string[], io: AgentsIo, opts: { json?: boolean } = {}): Promise<number> {
  const verb = (args[0] ?? 'list').toLowerCase();
  if (!(AGENTS_VERBS as readonly string[]).includes(verb)) {
    io.stderr.write(`jevcode agents: unknown verb '${verb}' — the verbs are ${AGENTS_VERBS.join(', ')}\n`);
    return EXIT_CODES.config;
  }
  return agentsList(io, opts);
}
