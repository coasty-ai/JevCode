/**
 * The manifest (docs/ORCHESTRATION-DESIGN.md §3.7): build, canonical checksum, bounded atomic write, and a
 * defensive read of `<runDir>/orchestrate/manifest-<step>.json`.
 *
 * The non-obvious invariant: **`readManifest` treats the file as untrusted input, never as its own output.**
 * The same run dir is reachable by a resumed session, a second device, a crashed predecessor and anything
 * with the user's file permissions, and what comes back out of it decides how many processes are spawned and
 * how much money they hold. So the parser validates every field before the checksum is even consulted, the
 * checksum is re-computed from the parsed object rather than trusted, and no path returns a partially
 * validated `Manifest`. It never throws: an unreadable manifest is a `{ ok: false, reason }`, which the
 * caller turns into `no_split`.
 *
 * `manifestId` is NOT taken from the file either: `readManifest` recomputes it through `canonical.ts`, the
 * one implementation `normalize.ts` also calls, so corner row 12's adoption key cannot drift after §3.5's
 * drop rule rebuilds an agent list — and cannot be FORGED. The checksum is an unkeyed sha256, i.e.
 * corruption detection: anyone who can edit `manifest-<n>.json` can recompute it. Only the recomputed
 * `manifestId` ties the id the checkpoint adopts on to the `agents[]` (their `own`, their caps) actually in
 * the file, so a hand-edited manifest that keeps the original id is refused instead of adopted. Two of
 * §2.2's five id inputs — `task` and `remaining` — are not stored in the manifest, so the caller passes
 * them in; a manifest that is not this run's delegation therefore does not read back at all.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../core/atomic.js';
import { isJsonObject, isStringArray, parseJson } from '../core/json.js';
import { AGENT_TASK_CHARS, DIRTY_ENTRIES_MAX, MANIFEST_BYTES, OWN_GLOBS_MAX, OWN_GLOB_CHARS, VERIFY_COMMANDS_MAX } from '../core/limits.js';
import { clip } from '../core/text.js';
import { checksumOf, manifestIdOf } from './canonical.js';
import { parseOwnGlob } from './split/globs.js';
import type { ChoiceVerdict, EngineMode, Json } from '../core/types.js';
import type { AgentRole, AgentSpec, Clock, DemandReason, Manifest, NormalizedSplit, RejectedOption, SplitKind, SyncedDirtyEntry } from './types.js';

/** §2.2's slug shape, `^[a-z0-9][a-z0-9-]{0,39}$`. Local to this parser; `normalize.ts` owns the writer's copy. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE_SHA_RE = /^[0-9a-f]{7,64}$/;
const DOCK_RE = /^jevcode\/dock-[A-Za-z0-9_-]{1,16}$/;
/**
 * A `runId` this module will put in a ref name. Narrower than "a non-empty string" on purpose: §2.2
 * reserves `dock`/`dock-*` so that `jevcode/dock-<runId8>` is well-formed, and a `runId` holding `/`, a
 * space, a `..` or nothing at all makes it neither well-formed nor the branch the writer meant.
 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/** A defensive ceiling on the agent list: §3.4 rule 7 clamps to `maxChildren`, far below this. */
const AGENTS_MAX = 16;
const REJECTED_MAX = 64;
const ID_CHARS = 200;
const REASON_CHARS = 500;

const SPLIT_KINDS: readonly SplitKind[] = ['by_plan_item', 'by_directory', 'by_failing_test', 'by_layer', 'as_written', 'no_split'];
const ROLES: readonly AgentRole[] = ['code', 'research', 'critic'];
const MODES: readonly EngineMode[] = ['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'agent'];
const VERDICTS: readonly ChoiceVerdict[] = ['chosen', 'overridden', 'fallback', 'code'];
const DEMANDS: readonly DemandReason[] = ['disjoint_directories', 'failing_tests', 'human'];

// ---------------------------------------------------------------------------------------
// I/O seam (§8.1 rule 1: the file system arrives as an argument)
// ---------------------------------------------------------------------------------------

export interface ManifestIo {
  write(rel: string, text: string): Promise<void>;
  read(rel: string): Promise<string | null>;
}

/** The production seam: atomic write (temp + rename) under `<runDir>/`, `mkdir -p` on the way. */
export function nodeManifestIo(runDir: string): ManifestIo {
  return {
    async write(rel, text) {
      await writeFileAtomic(join(runDir, rel), text, { mkdir: true });
    },
    async read(rel) {
      try {
        return await readFile(join(runDir, rel), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** §3.7: `orchestrate/manifest-<step>.json`, relative to the run dir. */
export function manifestPath(step: number): string {
  const n = Number.isSafeInteger(step) && step >= 0 ? step : 0;
  return `orchestrate/manifest-${n}.json`;
}

// ---------------------------------------------------------------------------------------
// §3.7 — build
// ---------------------------------------------------------------------------------------

export interface BuildManifestInput {
  split: NormalizedSplit;
  verdict: ChoiceVerdict;
  probability: number;
  confidence: number;
  runId: string;
  sessionId: string;
  step: number;
  /** §2.2 `manifestId` inputs that do not live on the split */
  task: string;
  remaining: readonly string[];
  baseSha: string;
  repoKey: string | null;
  syncedDirty: readonly SyncedDirtyEntry[];
  dirtyOverlap: readonly string[];
  reserveUsd: number;
  reserveFrom: 'session' | 'run';
  rejected: readonly RejectedOption[];
  demand: DemandReason;
  /** injected: `src/orchestrate/**` never builds a redactor (§8.1 rule 1) */
  redact: (s: string) => string;
  now: Clock;
}

/**
 * §2.2 / §3.7: `jevcode/dock-<runId8>`; §2.2 reserves `dock` and `dock-*` as slugs for exactly this.
 *
 * `null` for a `runId` that is not branch-safe, reported the way the rest of this module reports a bad
 * input — a value, never a throw. `''` would have produced the bare `jevcode/dock-`, and a `runId` with a
 * `/` or a space a ref name that is either invalid or names something else entirely.
 */
export function dockBranchOf(runId: string): string | null {
  if (!RUN_ID_RE.test(runId)) return null;
  return `jevcode/dock-${runId.slice(0, 8)}`;
}

/**
 * The agent as it is written: the task redacted and clipped, `own` and `verify` clipped only.
 *
 * `own` and `verify` are CLIPPED, never redacted. Both are re-read as behaviour — `own` decides what a
 * child may write and what §5.3 measures the diff against, `verify` is an executed command — so a
 * `[REDACTED:…]` marker inside either would change what it means: a redacted glob owns a different file or
 * none, and a redacted command is a different command (or one that no longer runs). §3.4 rule 9 scans
 * `task`, `own` AND `verify` with `detectSecrets` and surfaces a hit through `secretHits` on the §4.6
 * confirm card (`⚠ secret?`, a count, never the value), which is the human's decision to make.
 */
function writtenAgent(a: AgentSpec, redact: (s: string) => string): AgentSpec {
  return {
    slug: a.slug,
    task: clip(redact(a.task), AGENT_TASK_CHARS),
    own: a.own.slice(0, OWN_GLOBS_MAX).map((o) => clip(o, OWN_GLOB_CHARS)),
    role: a.role,
    verify: a.verify.slice(0, VERIFY_COMMANDS_MAX).map((v) => clip(v, OWN_GLOB_CHARS)),
    dependsOn: [...a.dependsOn],
    capUsd: a.capUsd,
    maxSteps: a.maxSteps,
    maxWallMs: a.maxWallMs,
    mode: a.mode,
    branch: a.branch,
  };
}

export type BuildResult = { ok: true; manifest: Manifest } | { ok: false; reason: string };

/**
 * §3.7's manifest, or a reason. The one refusal is a `runId` that cannot name the dock branch: building the
 * manifest anyway would write a `dockBranch` `readManifest` refuses (an unreadable manifest is re-spawned
 * forever) or, worse, a ref name that is not the one the run meant.
 */
export function buildManifest(input: BuildManifestInput): BuildResult {
  const dockBranch = dockBranchOf(input.runId);
  if (dockBranch === null) return { ok: false, reason: `runId ${JSON.stringify(input.runId)} cannot name a dock branch: it must match ${String(RUN_ID_RE)}` };
  const agents = input.split.agents.map((a) => writtenAgent(a, input.redact));
  const body: Omit<Manifest, 'checksum'> = {
    v: 1,
    manifestId: manifestIdOf({ task: input.task, remaining: input.remaining, splitKind: input.split.kind, agents, baseSha: input.baseSha }),
    runId: input.runId,
    sessionId: input.sessionId,
    step: input.step,
    splitKind: input.split.kind,
    verdict: input.verdict,
    probability: input.probability,
    confidence: input.confidence,
    baseSha: input.baseSha,
    repoKey: input.repoKey,
    dockBranch,
    syncedDirty: input.syncedDirty.slice(0, DIRTY_ENTRIES_MAX).map((e) => ({ path: e.path, sha256: e.sha256, mode: e.mode })),
    dirtyOverlap: input.dirtyOverlap.slice(0, DIRTY_ENTRIES_MAX),
    agents,
    reserveUsd: input.reserveUsd,
    reserveFrom: input.reserveFrom,
    rejected: input.rejected.slice(0, REJECTED_MAX).map((r) => ({ kind: r.kind, reason: clip(input.redact(r.reason), REASON_CHARS), probability: r.probability })),
    demand: input.demand,
    createdAt: new Date(input.now()).toISOString(),
  };
  return { ok: true, manifest: { ...body, checksum: checksumOf(body) } };
}

// ---------------------------------------------------------------------------------------
// §3.7 — write
// ---------------------------------------------------------------------------------------

export type WriteResult = { ok: true; bytes: number } | { ok: false; reason: string };

/**
 * §3.7: "≤ 32 KiB, redacted, checksummed". Over the limit it is REFUSED, not truncated — a truncated
 * manifest is an invalid one that would be read back as a delegation with fewer agents than were spawned.
 */
export async function writeManifest(io: ManifestIo, m: Manifest): Promise<WriteResult> {
  const expected = checksumOf(m);
  if (m.checksum !== expected) return { ok: false, reason: 'checksum does not match the manifest: it was mutated after buildManifest' };
  const text = JSON.stringify(m);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MANIFEST_BYTES) return { ok: false, reason: `manifest is ${bytes} bytes; the limit is ${MANIFEST_BYTES}` };
  try {
    await io.write(manifestPath(m.step), text);
  } catch (e) {
    return { ok: false, reason: `manifest write failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, bytes };
}

// ---------------------------------------------------------------------------------------
// §3.7 — the defensive read
// ---------------------------------------------------------------------------------------

export type ReadResult = { ok: true; manifest: Manifest } | { ok: false; reason: string };

function bad(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function str(o: Record<string, Json>, key: string, max: number): string | null {
  const v = o[key];
  return typeof v === 'string' && v.length <= max ? v : null;
}

function num(o: Record<string, Json>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function unit(o: Record<string, Json>, key: string): number | null {
  const v = num(o, key);
  return v !== null && v >= 0 && v <= 1 ? v : null;
}

function oneOf<T extends string>(o: Record<string, Json>, key: string, allowed: readonly T[]): T | null {
  const v = o[key];
  return typeof v === 'string' ? (allowed.find((a) => a === v) ?? null) : null;
}

type AgentResult = { ok: true; agent: AgentSpec } | { ok: false; reason: string };

function parseAgent(v: Json, at: number): AgentResult {
  if (!isJsonObject(v)) return bad(`agents[${at}] is not an object`);
  const slug = str(v, 'slug', 40);
  if (slug === null || !SLUG_RE.test(slug)) return bad(`agents[${at}].slug is not a slug`);
  if (slug === 'dock' || slug.startsWith('dock-')) return bad(`agents[${at}].slug "${slug}" is reserved for the dock`);
  const task = str(v, 'task', AGENT_TASK_CHARS);
  if (task === null) return bad(`agents[${at}].task is missing or over ${AGENT_TASK_CHARS} characters`);
  const own = v['own'];
  if (!isStringArray(own) || own.length === 0 || own.length > OWN_GLOBS_MAX) return bad(`agents[${at}].own is not 1..${OWN_GLOBS_MAX} strings`);
  if (own.some((g) => g.length === 0 || g.length > OWN_GLOB_CHARS)) return bad(`agents[${at}].own holds a glob over ${OWN_GLOB_CHARS} characters`);
  // A count and a length are not the sub-language: these globs drive §2.4's ownership enforcement the
  // moment the delegation is adopted, so every one of them is parsed by the ONE parser that decides what
  // `own` means (§3.4 rule 2), and the first failure is reported verbatim. The string is kept exactly as
  // the file spells it — `parseOwnGlob` trims and NFC-normalises, and a manifest whose globs only become
  // legal after that is not the one the normaliser wrote, so its `manifestId` must not match either.
  for (const [j, g] of own.entries()) {
    const parsed = parseOwnGlob(g);
    if (!parsed.ok) return bad(`agents[${at}].own[${j}] is not a legal own glob: ${parsed.reason}`);
  }
  const role = oneOf(v, 'role', ROLES);
  if (role === null) return bad(`agents[${at}].role is not one of ${ROLES.join(', ')}`);
  const verify = v['verify'];
  if (!isStringArray(verify) || verify.length > VERIFY_COMMANDS_MAX) return bad(`agents[${at}].verify is not <= ${VERIFY_COMMANDS_MAX} strings`);
  if (verify.some((c) => c.length > OWN_GLOB_CHARS)) return bad(`agents[${at}].verify holds a command over ${OWN_GLOB_CHARS} characters`);
  if (role === 'code' && verify.length === 0) return bad(`agents[${at}] has role code and no verify command (§3.4 rule 5)`);
  const dependsOn = v['dependsOn'];
  if (!isStringArray(dependsOn) || dependsOn.length > AGENTS_MAX) return bad(`agents[${at}].dependsOn is not <= ${AGENTS_MAX} slugs`);
  if (dependsOn.some((d) => !SLUG_RE.test(d)) || dependsOn.includes(slug)) return bad(`agents[${at}].dependsOn is not a list of other slugs`);
  const capUsd = num(v, 'capUsd');
  const maxSteps = num(v, 'maxSteps');
  const maxWallMs = num(v, 'maxWallMs');
  if (capUsd === null || capUsd < 0) return bad(`agents[${at}].capUsd is not a non-negative number`);
  if (maxSteps === null || !Number.isSafeInteger(maxSteps) || maxSteps < 0) return bad(`agents[${at}].maxSteps is not a non-negative integer`);
  if (maxWallMs === null || maxWallMs < 0) return bad(`agents[${at}].maxWallMs is not a non-negative number`);
  const mode = oneOf(v, 'mode', MODES);
  if (mode === null) return bad(`agents[${at}].mode is not an engine mode`);
  const branchRaw = v['branch'];
  if (branchRaw !== null && typeof branchRaw !== 'string') return bad(`agents[${at}].branch is not a string or null`);
  if (typeof branchRaw === 'string' && branchRaw !== `jevcode/${slug}`) return bad(`agents[${at}].branch is not "jevcode/${slug}"`);
  if (role === 'research' && branchRaw !== null) return bad(`agents[${at}] is research and must have no branch`);
  return { ok: true, agent: { slug, task, own, role, verify, dependsOn, capUsd, maxSteps, maxWallMs, mode, branch: branchRaw } };
}

function parseSyncedDirty(v: Json): { ok: true; entries: SyncedDirtyEntry[] } | { ok: false; reason: string } {
  if (!Array.isArray(v) || v.length > DIRTY_ENTRIES_MAX) return bad(`syncedDirty is not an array of <= ${DIRTY_ENTRIES_MAX} entries`);
  const entries: SyncedDirtyEntry[] = [];
  for (const [i, e] of v.entries()) {
    if (!isJsonObject(e)) return bad(`syncedDirty[${i}] is not an object`);
    const path = str(e, 'path', OWN_GLOB_CHARS * 2);
    const sha256 = str(e, 'sha256', 64);
    const mode = num(e, 'mode');
    if (path === null || path.length === 0) return bad(`syncedDirty[${i}].path is missing`);
    if (sha256 === null || (sha256 !== '' && !SHA256_RE.test(sha256))) return bad(`syncedDirty[${i}].sha256 is not a sha256 or ''`);
    if (mode === null || !Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) return bad(`syncedDirty[${i}].mode is not a file mode`);
    entries.push({ path, sha256, mode });
  }
  return { ok: true, entries };
}

function parseRejected(v: Json): { ok: true; rejected: RejectedOption[] } | { ok: false; reason: string } {
  if (!Array.isArray(v) || v.length > REJECTED_MAX) return bad(`rejected is not an array of <= ${REJECTED_MAX} entries`);
  const out: RejectedOption[] = [];
  for (const [i, r] of v.entries()) {
    if (!isJsonObject(r)) return bad(`rejected[${i}] is not an object`);
    const kind = oneOf(r, 'kind', SPLIT_KINDS);
    const reason = str(r, 'reason', REASON_CHARS);
    const p = r['probability'];
    if (kind === null) return bad(`rejected[${i}].kind is not a split kind`);
    if (reason === null) return bad(`rejected[${i}].reason is missing or over ${REASON_CHARS} characters`);
    if (p !== null && (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)) return bad(`rejected[${i}].probability is not a probability or null`);
    out.push({ kind, reason, probability: p });
  }
  return { ok: true, rejected: out };
}

/**
 * The two §2.2 `manifestId` inputs the manifest does not store. The caller holds them (they are the run's
 * own task and its remaining plan items), and without them the id cannot be recomputed — which is the
 * only check that ties the adoption key to the contents.
 */
export interface ManifestIdContext {
  task: string;
  remaining: readonly string[];
}

/**
 * §3.7: read, validate field by field, re-check the checksum, then RECOMPUTE `manifestId` from the parsed
 * contents and `context`. Returns a reason; never throws.
 */
export async function readManifest(io: ManifestIo, step: number, context: ManifestIdContext): Promise<ReadResult> {
  const rel = manifestPath(step);
  let text: string | null;
  try {
    text = await io.read(rel);
  } catch (e) {
    return bad(`${rel} could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (text === null) return bad(`no manifest at ${rel}`);
  if (Buffer.byteLength(text, 'utf8') > MANIFEST_BYTES) return bad(`${rel} is larger than ${MANIFEST_BYTES} bytes`);
  const parsed = parseJson(text);
  if (!parsed.ok) return bad(`${rel} is not json: ${parsed.error}`);
  const o = parsed.value;
  if (!isJsonObject(o)) return bad(`${rel} is not a json object`);

  if (o['v'] !== 1) return bad('v is not 1');
  const manifestId = str(o, 'manifestId', 64);
  if (manifestId === null || !SHA256_RE.test(manifestId)) return bad('manifestId is not a sha256');
  const runId = str(o, 'runId', ID_CHARS);
  const sessionId = str(o, 'sessionId', ID_CHARS);
  if (runId === null || runId.length === 0) return bad('runId is missing');
  if (!RUN_ID_RE.test(runId)) return bad(`runId ${JSON.stringify(runId)} is not branch-safe: it must match ${String(RUN_ID_RE)}`);
  if (sessionId === null || sessionId.length === 0) return bad('sessionId is missing');
  const stepOut = num(o, 'step');
  if (stepOut === null || !Number.isSafeInteger(stepOut) || stepOut < 0) return bad('step is not a non-negative integer');
  if (stepOut !== step) return bad(`step ${stepOut} does not match the file name ${rel}`);
  const splitKind = oneOf(o, 'splitKind', SPLIT_KINDS);
  if (splitKind === null) return bad('splitKind is not a split kind');
  const verdict = oneOf(o, 'verdict', VERDICTS);
  if (verdict === null) return bad('verdict is not a choice verdict');
  const probability = unit(o, 'probability');
  const confidence = unit(o, 'confidence');
  if (probability === null) return bad('probability is not a number in 0..1');
  if (confidence === null) return bad('confidence is not a number in 0..1');
  const baseSha = str(o, 'baseSha', 64);
  if (baseSha === null || !BASE_SHA_RE.test(baseSha)) return bad('baseSha is not a commit sha');
  const repoKeyRaw = o['repoKey'];
  if (repoKeyRaw !== null && (typeof repoKeyRaw !== 'string' || repoKeyRaw.length > ID_CHARS)) return bad('repoKey is not a bounded string or null');
  const dockBranch = str(o, 'dockBranch', 64);
  if (dockBranch === null || !DOCK_RE.test(dockBranch)) return bad('dockBranch is not `jevcode/dock-<runId8>`');
  if (dockBranch !== dockBranchOf(runId)) return bad(`dockBranch ${dockBranch} is not the one runId ${runId} derives`);

  const dirty = parseSyncedDirty(o['syncedDirty'] ?? null);
  if (!dirty.ok) return dirty;
  const dirtyOverlap = o['dirtyOverlap'];
  if (!isStringArray(dirtyOverlap) || dirtyOverlap.length > DIRTY_ENTRIES_MAX) return bad(`dirtyOverlap is not <= ${DIRTY_ENTRIES_MAX} strings`);

  const agentsRaw = o['agents'];
  if (!Array.isArray(agentsRaw) || agentsRaw.length > AGENTS_MAX) return bad(`agents is not an array of <= ${AGENTS_MAX} entries`);
  const agents: AgentSpec[] = [];
  for (const [i, a] of agentsRaw.entries()) {
    const parsedAgent = parseAgent(a, i);
    if (!parsedAgent.ok) return parsedAgent;
    agents.push(parsedAgent.agent);
  }
  if (new Set(agents.map((a) => a.slug)).size !== agents.length) return bad('two agents share a slug');

  const reserveUsd = num(o, 'reserveUsd');
  if (reserveUsd === null || reserveUsd < 0) return bad('reserveUsd is not a non-negative number');
  const reserveFrom = oneOf(o, 'reserveFrom', ['session', 'run'] as const);
  if (reserveFrom === null) return bad('reserveFrom is not session or run');
  const rejected = parseRejected(o['rejected'] ?? null);
  if (!rejected.ok) return rejected;
  const demand = oneOf(o, 'demand', DEMANDS);
  if (demand === null) return bad('demand is not a demand reason');
  const createdAt = str(o, 'createdAt', 40);
  if (createdAt === null || Number.isNaN(Date.parse(createdAt))) return bad('createdAt is not a timestamp');
  const checksum = str(o, 'checksum', 64);
  if (checksum === null || !SHA256_RE.test(checksum)) return bad('checksum is not a sha256');

  const manifest: Manifest = {
    v: 1,
    manifestId,
    runId,
    sessionId,
    step: stepOut,
    splitKind,
    verdict,
    probability,
    confidence,
    baseSha,
    repoKey: repoKeyRaw,
    dockBranch,
    syncedDirty: dirty.entries,
    dirtyOverlap,
    agents,
    reserveUsd,
    reserveFrom,
    rejected: rejected.rejected,
    demand,
    createdAt,
    checksum,
  };
  if (checksumOf(manifest) !== checksum) return bad(`${rel} fails its checksum: it was edited or truncated`);
  // The checksum above is an UNKEYED sha256: it catches a truncated or corrupted file, and nothing else,
  // because whoever edited the file could recompute it. The id is what the checkpoint adopts on (row 12),
  // so it is recomputed from what the file actually says and compared — otherwise a manifest with the
  // original `manifestId` and a rewritten `agents[]` (other `own`, other caps) would be adopted as if it
  // were the delegation the human confirmed.
  const recomputed = manifestIdOf({ task: context.task, remaining: context.remaining, splitKind, agents, baseSha });
  if (recomputed !== manifestId) {
    return bad(`${rel}: manifestId does not match the contents it names — the manifest's task, agents or baseSha are not the ones ${manifestId.slice(0, 12)} was computed from (recomputed ${recomputed.slice(0, 12)})`);
  }
  return { ok: true, manifest };
}

/**
 * Corner row 12's adoption key: `manifestId` AND `baseSha`. A resumed delegation matching both is adopted,
 * never re-spawned. `baseSha` is part of the key even though it is already a `manifestId` input, because
 * that is the pair every other surface compares and one implementation of it is enough.
 */
export function sameDelegation(a: Pick<Manifest, 'manifestId' | 'baseSha'>, b: Pick<Manifest, 'manifestId' | 'baseSha'>): boolean {
  return a.manifestId === b.manifestId && a.baseSha === b.baseSha;
}
