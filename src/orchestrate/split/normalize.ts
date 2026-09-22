/**
 * The rejection filter (docs/ORCHESTRATION-DESIGN.md §3.4): nine rules, applied in order, the first
 * failure deleting the option and naming why.
 *
 * The fixed order of §2.2 and corner row 15 is the thing to preserve: **rule 1 runs to completion for
 * every agent** (slug sanitised, de-duplicated, kept off `dock*`, renamed `<slug>-<n>` past an
 * existing `jevcode/<slug>` branch — the SLUG takes the suffix, never the branch [D11]), THEN rules
 * 2–9 run, THEN `manifestId` is computed over the final slugs, and only then is `branch` derived as
 * `jevcode/<slug>`. A slug renamed after the id would make row 12's adoption compare the wrong
 * delegation, and a branch renamed instead of the slug would break the `branch === 'jevcode/' + slug`
 * that §5.2's `rev-parse` assumes.
 *
 * Pure: no fs, no spawn, no clock. The existing branches, the deny list, the volume's case-folding
 * and `detectSecrets` all arrive as arguments (§8.1 rule 1); rule 9 takes a HIT COUNT, never a value.
 */
import { AGENT_TASK_CHARS, DEPENDS_DEPTH_MAX, OWN_GLOBS_MAX, VERIFY_COMMANDS_MAX } from '../../core/limits.js';
import type { EngineMode } from '../../core/types.js';
import { manifestIdOf } from '../canonical.js';
import { VERIFY_COMMAND_CHARS } from '../verify.js';
import type { AgentRole, AgentSpec, DraftSplit, NormalizeResult, RejectedOption, SplitPolicy } from '../types.js';
import { collapseOwn, disjoint, ownStrings, ownsPath, validateOwnList, type OwnGlob } from './globs.js';

/** §2.2: the slug grammar. Forty characters, because it is a branch component and a TUI column. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** §6.4 `orchestrate.agentMaxWall`: the per-agent share of the parent's remaining wall never goes below this. */
export const AGENT_WALL_FLOOR_MS = 10 * 60_000;

export interface NormalizeInput {
  option: DraftSplit;
  policy: SplitPolicy;
  /** existing `refs/heads/*` short names, for rule 1's collision check (corner row 15) */
  existingBranches: readonly string[];
  /** repo-relative prefixes no agent may own: `.git`, every submodule path, every secretPaths entry */
  deny: readonly string[];
  /** the volume folds case (APFS/NTFS): overlap is computed case-insensitively */
  fold: boolean;
  /** every real repo path, for rule 8's [G11] token resolution */
  repoPaths: readonly string[];
  plan: { remaining: readonly string[] };
  itemFiles: readonly (readonly string[])[];
  /** the parent's task text — a `manifestId` input */
  task: string;
  baseSha: string;
  mode: EngineMode;
  reserveUsd: number;
  /** §6.1: `min(agentMaxWallMs, parentRemainingWallMs / agents)`, floor 10 min; omit for `agentMaxWallMs` */
  parentRemainingWallMs?: number;
  /** rule 9: the HIT COUNT of `core/redact.ts detectSecrets`, never a value. Injected so this stays pure */
  detectSecrets: (s: string) => number;
}

interface Working {
  slug: string;
  task: string;
  own: string[];
  globs: OwnGlob[];
  role: AgentRole;
  verify: string[];
  dependsOn: string[];
  items: number[];
  capUsd: number;
}

function reject(kind: DraftSplit['kind'], reason: string): NormalizeResult {
  const rejected: RejectedOption = { kind, reason, probability: null };
  return { ok: false, rejected };
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** §3.7: the task is one line, so it is one row on every surface and one field in the manifest. */
function oneLine(text: string): string {
  return clip(text.replace(/\s+/gu, ' ').trim(), AGENT_TASK_CHARS);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function sharedPrefixSegments(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n += 1;
  return n;
}

// ---------------------------------------------------------------------------------------
// Rule 1 — slugs (§2.2, corner row 15, [D11])
// ---------------------------------------------------------------------------------------

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** `dock` and `dock-*` are the landing branch's namespace: an agent may never answer to one. */
function reservedSlug(slug: string): boolean {
  return slug === 'dock' || slug.startsWith('dock-');
}

function slugTaken(slug: string, used: ReadonlySet<string>, existingBranches: readonly string[]): boolean {
  return used.has(slug) || existingBranches.includes(`jevcode/${slug}`);
}

// ---------------------------------------------------------------------------------------
// Rule 8 — [G11] path tokens in the task text
// ---------------------------------------------------------------------------------------

const FILE_TOKEN_RE = /[\w./-]+\.\w{1,6}/gu;
const DIR_TOKEN_RE = /[\w-]+(?:\/[\w.-]+)+\/?/gu;

function tokensOf(task: string): string[] {
  const out: string[] = [];
  for (const re of [FILE_TOKEN_RE, DIR_TOKEN_RE]) {
    re.lastIndex = 0;
    for (const match of task.matchAll(re)) {
      const token = (match[0] ?? '')
        .replace(/^\.\//, '')
        .replace(/[.,;:)\]}'"`]+$/, '')
        .replace(/\/+$/, '');
      if (token.length > 0) out.push(token);
    }
  }
  return unique(out);
}

/** A directory token is "owned" when the agent owns anything inside it, or it sits inside what it owns. */
function dirOwned(globs: readonly OwnGlob[], token: string, fold: boolean): boolean {
  const key = fold ? token.toLowerCase() : token;
  for (const glob of globs) {
    const dir = fold ? glob.dir.toLowerCase() : glob.dir;
    if (dir === key || dir.startsWith(`${key}/`) || key.startsWith(`${dir}/`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------

function mergeInto(survivors: readonly Working[], dropped: Working, fold: boolean): void {
  let best: Working | null = null;
  let bestScore = -1;
  for (const survivor of survivors) {
    let score = 0;
    for (const a of dropped.globs) for (const b of survivor.globs) score = Math.max(score, sharedPrefixSegments(a.dir, b.dir));
    if (score > bestScore) {
      best = survivor;
      bestScore = score;
    }
  }
  if (best === null) return;
  best.items = [...new Set([...best.items, ...dropped.items])].sort((x, y) => x - y);
  // the own set moves with the items: rule 4's coverage was true before the clamp and must stay true
  best.globs = collapseOwn([...best.globs, ...dropped.globs], OWN_GLOBS_MAX, fold);
  best.own = ownStrings(best.globs);
  best.task = oneLine(`${best.task}; ${dropped.task}`);
}

export function normalizeSplit(input: NormalizeInput): NormalizeResult {
  const { option, policy } = input;
  const kind = option.kind;

  // `no_split` is the zero-agent escape (§3.2): the nine rules are all about agents, and rule 4 would
  // reject it for covering no plan item. It is always valid and always available.
  if (kind === 'no_split' || option.agents.length === 0) {
    const manifestId = manifestIdOf({ task: input.task, remaining: input.plan.remaining, splitKind: kind, agents: [], baseSha: input.baseSha });
    return { ok: true, split: { kind, agents: [], manifestId, secretHits: 0, clampReason: null } };
  }

  // Prepass: what ships is what the rules see. The task is one line and clipped, the verify set is
  // bounded, so rule 8's scan and rule 9's count run over the final strings and not over a draft.
  const agents: Working[] = option.agents.map((draft) => ({
    slug: draft.slug,
    task: oneLine(draft.task),
    own: [...draft.own],
    globs: [],
    role: draft.role ?? 'code',
    verify: draft.verify.slice(0, VERIFY_COMMANDS_MAX).map((c) => clip(c, VERIFY_COMMAND_CHARS)),
    dependsOn: [...(draft.dependsOn ?? [])],
    items: [...(draft.items ?? [])].sort((a, b) => a - b),
    capUsd: 0,
  }));

  // --- rule 1: slugs, to completion, before anything else -------------------------------
  const used = new Set<string>();
  const renamed = new Map<string, string>();
  for (const agent of agents) {
    const base = sanitizeSlug(agent.slug);
    if (base.length === 0) return reject(kind, `agent slug "${clip(agent.slug, 40)}" cannot be made into a slug`);
    // the `-<n>` repair cannot escape the dock namespace (`dock-2` is still `dock-*`), so this one
    // collision is a refusal rather than a rename
    if (reservedSlug(base)) return reject(kind, `agent slug "${base}" is reserved for the dock branch`);
    let slug = base;
    for (let n = 2; slugTaken(slug, used, input.existingBranches); n++) {
      if (n > 99) return reject(kind, `agent slug "${base}" collides and cannot be renamed`);
      const suffix = `-${n}`;
      slug = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    }
    if (!SLUG_RE.test(slug)) return reject(kind, `agent slug "${clip(slug, 40)}" does not match ${String(SLUG_RE)}`);
    used.add(slug);
    if (slug !== agent.slug) renamed.set(agent.slug, slug);
    agent.slug = slug;
  }

  // --- rule 2: the `own` sub-language ---------------------------------------------------
  for (const agent of agents) {
    const checked = validateOwnList(agent.own, { max: OWN_GLOBS_MAX, deny: input.deny, fold: input.fold });
    if (!checked.ok) return reject(kind, `agent ${agent.slug}: ${checked.reason}`);
    agent.globs = checked.globs;
    agent.own = ownStrings(checked.globs);
  }

  // --- rule 3: disjointness -------------------------------------------------------------
  // This is the whole safety argument: two agents that cannot both own a file cannot both write it.
  // [D2]'s scoped commit set is what makes the same statement true of the branch DIFFS rather than
  // only of the specs (an unscoped `git add -A` would carry the parent's dirt onto every branch);
  // `commit.test.ts` asserts the diff-level twin of what `normalize.test.ts` asserts here.
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i];
      const b = agents[j];
      if (a === undefined || b === undefined) continue;
      const result = disjoint(a.globs, b.globs, input.fold);
      if (!result.ok) return reject(kind, `agents ${a.slug} and ${b.slug} both own ${result.left} / ${result.right}`);
    }
  }

  // --- rule 4: coverage -----------------------------------------------------------------
  const owner = new Map<number, string>();
  for (const agent of agents) {
    for (const index of agent.items) {
      const already = owner.get(index);
      if (already !== undefined) {
        return reject(kind, `plan item "${clip(input.plan.remaining[index] ?? String(index), 60)}" is in agents ${already} and ${agent.slug}`);
      }
      owner.set(index, agent.slug);
    }
  }
  for (let i = 0; i < input.plan.remaining.length; i++) {
    if (!owner.has(i)) return reject(kind, `plan item "${clip(input.plan.remaining[i] ?? String(i), 60)}" is in no agent`);
  }
  for (let i = 0; i < input.plan.remaining.length; i++) {
    for (const file of input.itemFiles[i] ?? []) {
      if (!agents.some((agent) => ownsPath(agent.globs, file, input.fold))) {
        return reject(kind, `no agent owns ${file}, which plan item "${clip(input.plan.remaining[i] ?? String(i), 60)}" needs`);
      }
    }
  }

  // --- rule 5: verification, or a downgrade to research ---------------------------------
  // A missing command is never fatal to the option: a read-only agent that writes a facts handoff is
  // still worth spawning, and an all-research option is valid (§5.1 step 6's whole point).
  for (const agent of agents) {
    if (agent.role === 'code' && agent.verify.length === 0) {
      agent.role = 'research';
      agent.verify = [];
    }
  }

  // --- rule 6: the dependency DAG -------------------------------------------------------
  const slugs = new Set(agents.map((a) => a.slug));
  const edges = new Map<string, string[]>();
  for (const agent of agents) {
    // rule 1 may have renamed the target, and the draft names the pre-rename slug
    agent.dependsOn = unique(agent.dependsOn.map((d) => renamed.get(d) ?? d)).filter((d) => d !== agent.slug);
    for (const dep of agent.dependsOn) {
      if (!slugs.has(dep)) return reject(kind, `agent ${agent.slug} depends on unknown slug ${clip(dep, 40)}`);
    }
    edges.set(agent.slug, [...agent.dependsOn]);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (slug: string): number | null => {
    const known = depth.get(slug);
    if (known !== undefined) return known;
    if (visiting.has(slug)) return null;
    visiting.add(slug);
    let deepest = 0;
    for (const dep of edges.get(slug) ?? []) {
      const below = depthOf(dep);
      if (below === null) return null;
      deepest = Math.max(deepest, below + 1);
    }
    visiting.delete(slug);
    depth.set(slug, deepest);
    return deepest;
  };
  for (const agent of agents) {
    const d = depthOf(agent.slug);
    if (d === null) return reject(kind, `dependsOn has a cycle through agent ${agent.slug}`);
    if (d > DEPENDS_DEPTH_MAX) return reject(kind, `dependsOn is ${d} deep through agent ${agent.slug}; the limit is ${DEPENDS_DEPTH_MAX}`);
  }

  // --- rule 7: caps, then the §6.1 money split ------------------------------------------
  const notes: string[] = [];
  let live = agents;
  const ceiling = Math.max(1, Math.min(policy.maxAgents, policy.maxChildren));
  if (live.length > ceiling) {
    const before = live.length;
    const kept = live.slice(0, ceiling);
    for (const extra of live.slice(ceiling)) mergeInto(kept, extra, input.fold);
    live = kept;
    const which = policy.maxChildren <= policy.maxAgents ? 'coordination.maxChildren' : 'orchestrate.maxAgents';
    notes.push(`${before} agents clamped to ${ceiling} by ${which}`);
  }

  // `w_i` is a code weight — the agent's item count. Jev has no say in money (§6.1).
  const reserveCents = Math.max(0, Math.floor(input.reserveUsd * 100 + 1e-6));
  const minCents = Math.max(0, Math.round(policy.minAgentUsd * 100));
  for (;;) {
    const weights = live.map((agent) => Math.max(1, agent.items.length));
    const total = weights.reduce((sum, w) => sum + w, 0);
    // rounded DOWN to the cent, so the sum can only ever be under the reserve
    const caps = weights.map((w) => Math.max(minCents, Math.floor((reserveCents * w) / Math.max(1, total))));
    if (caps.reduce((sum, c) => sum + c, 0) <= reserveCents) {
      for (let i = 0; i < live.length; i++) {
        const agent = live[i];
        if (agent !== undefined) agent.capUsd = (caps[i] ?? minCents) / 100;
      }
      break;
    }
    if (live.length <= 2) {
      return reject(kind, `the reserve $${input.reserveUsd.toFixed(2)} cannot give 2 agents the minimum $${policy.minAgentUsd.toFixed(2)} each`);
    }
    const before = live.length;
    const kept = live.slice(0, live.length - 1);
    const extra = live[live.length - 1];
    if (extra !== undefined) mergeInto(kept, extra, input.fold);
    live = kept;
    notes.push(`${before} agents reduced to ${live.length} to keep every cap at or above $${policy.minAgentUsd.toFixed(2)}`);
  }

  // the clamp merges `own` sets, and a merge that had to prefix-collapse can widen one agent's reach
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a === undefined || b === undefined) continue;
      const result = disjoint(a.globs, b.globs, input.fold);
      if (!result.ok) return reject(kind, `agents ${a.slug} and ${b.slug} both own ${result.left} / ${result.right} after the clamp`);
    }
  }

  const share = input.parentRemainingWallMs === undefined ? null : Math.max(AGENT_WALL_FLOOR_MS, Math.floor(input.parentRemainingWallMs / Math.max(1, live.length)));
  const maxWallMs = share === null ? policy.agentMaxWallMs : Math.min(policy.agentMaxWallMs, share);
  const maxSteps = policy.agentMaxSteps;

  // --- rule 8: [G11] the task must not name what the agent does not own ------------------
  const resolvable = new Set<string>();
  const directories = new Set<string>();
  for (const path of input.repoPaths) {
    resolvable.add(input.fold ? path.toLowerCase() : path);
    let dir = dirOf(path);
    while (dir.length > 0) {
      directories.add(input.fold ? dir.toLowerCase() : dir);
      dir = dirOf(dir);
    }
  }
  for (const agent of live) {
    for (const token of tokensOf(agent.task)) {
      const key = input.fold ? token.toLowerCase() : token;
      if (resolvable.has(key)) {
        if (!ownsPath(agent.globs, token, input.fold)) return reject(kind, `agent ${agent.slug} names ${token}, which it does not own`);
        continue;
      }
      if (directories.has(key) && !dirOwned(agent.globs, token, input.fold)) {
        return reject(kind, `agent ${agent.slug} names ${token}, which it does not own`);
      }
    }
  }

  // --- rule 9: secrets, counted, never quoted -------------------------------------------
  let secretHits = 0;
  for (const agent of live) {
    const hit = input.detectSecrets(agent.task) > 0 || agent.own.some((glob) => input.detectSecrets(glob) > 0);
    if (hit) secretHits += 1;
  }

  // --- the fixed order's tail: manifestId over the final slugs, then `branch` ------------
  const specs: AgentSpec[] = live.map((agent) => ({
    slug: agent.slug,
    task: agent.task,
    own: [...agent.own],
    role: agent.role,
    verify: [...agent.verify],
    dependsOn: [...agent.dependsOn],
    capUsd: agent.capUsd,
    maxSteps,
    maxWallMs,
    mode: input.mode,
    branch: agent.role === 'research' ? null : `jevcode/${agent.slug}`,
  }));
  const manifestId = manifestIdOf({ task: input.task, remaining: input.plan.remaining, splitKind: kind, agents: specs, baseSha: input.baseSha });
  return { ok: true, split: { kind, agents: specs, manifestId, secretHits, clampReason: notes.length === 0 ? null : notes.join('; ') } };
}
