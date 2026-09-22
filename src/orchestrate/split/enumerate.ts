/**
 * The five enumerators (docs/ORCHESTRATION-DESIGN.md §3.2): code builds the options, the LLM writes
 * at most one of them (§3.3), and the normaliser (§3.4) is what deletes them.
 *
 * The options come back in the FIXED order `by_failing_test → by_layer → by_directory → by_plan_item
 * → as_written`, with `no_split` always last and always present. That order is load-bearing: §3.5's
 * `split: 'auto'` fallback takes the first option that normalised, in exactly this order, so a
 * relaunch of the same run must enumerate the same list in the same sequence or the fallback stops
 * being deterministic.
 *
 * An enumerator that does not apply (no failing tests, no workspace manifest, fewer than two groups)
 * returns nothing and records nothing — that is not a rejection. Only a DELETED option (the shared
 * prelude over `preludeMaxFiles`, or an agent that would own the whole repository) becomes a
 * `RejectedOption`; an option that simply collapses below two agents is dropped in silence.
 *
 * The non-obvious interaction: the shared-file prelude is computed over FILES, while `by_directory`
 * and `by_layer` own whole TREES. A file two of their agents both need therefore becomes a prelude
 * glob nested inside a tree another agent owns, and normalise rule 3 deletes that option with the
 * exact overlapping pair. That is the intended outcome — those directories were not separable — and
 * the message a human reads is better from rule 3 than from a second check here.
 *
 * Pure: no fs, no spawn, no clock. The listing, the failing tests, the imports, the workspace members
 * and the verification resolver all arrive as arguments (§8.1 rule 1).
 */
import { OWN_GLOBS_MAX } from '../../core/limits.js';
import { collapseOwn, ownStrings, ownsPath, parseOwnGlob, type OwnGlob } from './globs.js';
import type { DraftAgent, DraftSplit, RejectedOption, SplitKind, SplitPolicy } from '../types.js';

/** §3.3: the prefix tree handed to the generator is bounded at this many entries. */
export const PREFIX_TREE_MAX = 200;

/** The slug of the shared-file agent every other agent of an option `dependsOn` (§3.2, corner row 1). */
export const PRELUDE_SLUG = 'prelude';

export interface EnumerateInput {
  plan: { remaining: readonly string[] };
  /** parallel to plan.remaining: the repo-relative files the item's evidence + fileMemory associate with it */
  itemFiles: readonly (readonly string[])[];
  /** `git ls-files` output — the prefix tree source, already computed by workspace.listCandidates() */
  listing: readonly string[];
  lastTestRun: { failingFiles: readonly string[] } | null;
  /** single-hop imports of a failing test file, code-computed by the caller for ts/py */
  testImports: Readonly<Record<string, readonly string[]>>;
  /** workspace-manifest members (package.json workspaces / pyproject members / Cargo members) */
  packages: readonly { name: string; dir: string }[];
  /** the generator's `propose_split` answer, already schema-checked; null in jev-only (§3.3) */
  asWritten: DraftSplit | null;
  policy: SplitPolicy;
  /** §5.1's resolution, injected so this module does no I/O */
  verifyFor: (own: readonly string[]) => readonly string[];
}

// ---------------------------------------------------------------------------------------
// The prefix tree (§3.2, §3.3)
// ---------------------------------------------------------------------------------------

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function topDirOf(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** The distinct top-level directories of a `git ls-files` listing, in lexicographic order. */
export function topLevelDirs(listing: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const path of listing) {
    const top = topDirOf(path);
    if (top.length > 0) seen.add(top);
  }
  return [...seen].sort();
}

/**
 * Every directory prefix of the listing, shallowest first, bounded at `max` (§3.3's ≤ 200 entries).
 * Shallowest first because a truncated tree must still describe the repository's shape.
 */
export function prefixTree(listing: readonly string[], max: number = PREFIX_TREE_MAX): string[] {
  const seen = new Set<string>();
  for (const path of listing) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) seen.add(segments.slice(0, i).join('/'));
  }
  const all = [...seen].sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    return da === db ? (a < b ? -1 : a > b ? 1 : 0) : da - db;
  });
  return all.slice(0, Math.max(0, max));
}

/** The directory a glob of the sub-language is rooted at: `src/**` and `src/` and `src/a.ts` all give `src`. */
function globDir(raw: string): string {
  if (raw.endsWith('/**')) return raw.slice(0, -3);
  if (raw.endsWith('/')) return raw.slice(0, -1);
  return dirOf(raw);
}

function sharedPrefixSegments(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n += 1;
  return n;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------------------
// The working shape, before the shared-file pass turns it into `DraftAgent`s
// ---------------------------------------------------------------------------------------

interface RawAgent {
  slug: string;
  /** indices into `plan.remaining` */
  items: number[];
  /** the concrete files this agent must be able to write */
  files: string[];
  /** globs unioned with the file-derived ones: `<dir>/**` for by_directory / by_layer, the generator's own for as_written */
  ownRaw: string[];
  /** as_written only: the globs pass through untouched (§3.3) and are never widened by a merge */
  ownFixed: boolean;
  /** as_written only: the generator's task text, used verbatim */
  fixedTask: string | null;
  /** the task when the agent covers no plan item */
  fallbackTask: string;
  dependsOn: string[];
}

interface RawOption {
  kind: SplitKind;
  agents: RawAgent[];
  /** remaining item indices no agent claimed — corner row 3's merge */
  leftovers: number[];
}

function rawAgent(slug: string, over: Partial<RawAgent> = {}): RawAgent {
  return { slug, items: [], files: [], ownRaw: [], ownFixed: false, fixedTask: null, fallbackTask: '', dependsOn: [], ...over };
}

function slugify(text: string, fallback: string): string {
  const flattened = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const words = flattened.split('-').filter((w) => w.length > 0).slice(0, 4).join('-');
  const clipped = words.slice(0, 40).replace(/-+$/, '');
  return /^[a-z0-9]/.test(clipped) ? clipped : fallback;
}

function uniqueSlug(used: Set<string>, base: string): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, 37)}-${n}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  used.add(base);
  return base;
}

/**
 * One glob per file, falling back to the containing directory's tree when the sub-language cannot
 * name the file itself (an extensionless `bin/run`). A root-level extensionless file has no legal
 * spelling at all and is dropped here; rule 4's coverage check is what then notices.
 */
function globsForFiles(files: readonly string[]): OwnGlob[] {
  const out: OwnGlob[] = [];
  for (const file of files) {
    const direct = parseOwnGlob(file);
    if (direct.ok) {
      out.push(direct.glob);
      continue;
    }
    const dir = dirOf(file);
    if (dir.length === 0) continue;
    const tree = parseOwnGlob(`${dir}/**`);
    if (tree.ok) out.push(tree.glob);
  }
  return out;
}

function parseAll(raws: readonly string[]): OwnGlob[] {
  const out: OwnGlob[] = [];
  for (const raw of raws) {
    const parsed = parseOwnGlob(raw);
    if (parsed.ok) out.push(parsed.glob);
  }
  return out;
}

function ownOf(agent: RawAgent): string[] {
  // as_written passes through untouched: a glob the generator wrote that this module cannot parse
  // must still reach rule 2, which is the one place that reports WHY it was refused.
  if (agent.ownFixed) return [...agent.ownRaw];
  return ownStrings(collapseOwn([...parseAll(agent.ownRaw), ...globsForFiles(agent.files)], OWN_GLOBS_MAX));
}

function taskOf(agent: RawAgent, remaining: readonly string[]): string {
  if (agent.fixedTask !== null) return agent.fixedTask;
  const texts: string[] = [];
  for (const i of agent.items) {
    const text = remaining[i];
    if (typeof text === 'string' && text.trim().length > 0) texts.push(text.trim());
  }
  return texts.length > 0 ? texts.join('; ') : agent.fallbackTask;
}

// ---------------------------------------------------------------------------------------
// Shared post-processing (§3.2's last paragraph, corner rows 1 and 3)
// ---------------------------------------------------------------------------------------

interface Finished {
  option: DraftSplit | null;
  rejected: RejectedOption | null;
}

function nearestAgent(agents: readonly RawAgent[], files: readonly string[]): { agent: RawAgent; score: number } | null {
  let best: RawAgent | null = null;
  let bestScore = -1;
  for (const agent of agents) {
    let score = 0;
    const theirs = [...agent.files.map(dirOf), ...agent.ownRaw.map(globDir)];
    for (const file of files) for (const dir of theirs) score = Math.max(score, sharedPrefixSegments(dirOf(file), dir));
    if (score > bestScore) {
      best = agent;
      bestScore = score;
    }
  }
  return best === null ? null : { agent: best, score: bestScore };
}

function finish(option: RawOption, input: EnumerateInput): Finished {
  for (const agent of option.agents) agent.files = unique(agent.files);

  // 1. the shared set: every file two or more agents would have to write
  const owners = new Map<string, number>();
  for (const agent of option.agents) for (const file of agent.files) owners.set(file, (owners.get(file) ?? 0) + 1);
  const shared = [...owners.entries()].filter(([, n]) => n >= 2).map(([file]) => file).sort();
  if (shared.length > input.policy.preludeMaxFiles) {
    const reason = `the shared file set is ${shared.length} files (> preludeMaxFiles ${input.policy.preludeMaxFiles}): the work is not separable`;
    return { option: null, rejected: { kind: option.kind, reason, probability: null } };
  }

  // 2. the prelude owns them, and lands first
  let prelude: RawAgent | null = null;
  let agents = option.agents;
  if (shared.length > 0) {
    prelude = rawAgent(PRELUDE_SLUG, {
      files: [...shared],
      fallbackTask: `make the shared change the other agents depend on: ${shared.slice(0, 8).join(', ')}`,
    });
    const sharedSet = new Set(shared);
    const kept: RawAgent[] = [];
    for (const agent of agents) {
      agent.files = agent.files.filter((f) => !sharedSet.has(f));
      agent.ownRaw = agent.ownRaw.filter((raw) => !sharedSet.has(raw));
      if (agent.files.length === 0 && agent.ownRaw.length === 0) {
        prelude.items.push(...agent.items);
        continue;
      }
      kept.push(agent);
    }
    agents = kept;
  }

  // 3. corner row 3: an unclaimed item joins the nearest agent by directory, else the prelude
  for (const index of option.leftovers) {
    const files = input.itemFiles[index] ?? [];
    const near = files.length === 0 ? null : nearestAgent(agents, files);
    const target = near !== null && near.score > 0 ? near.agent : (prelude ?? near?.agent ?? agents[0] ?? null);
    if (target === null) continue;
    target.items.push(index);
    if (!target.ownFixed) target.files.push(...files);
  }

  const all = prelude === null ? agents : [prelude, ...agents];
  if (all.length < 2) return { option: null, rejected: null };
  if (prelude !== null) for (const agent of agents) agent.dependsOn = unique([...agent.dependsOn, PRELUDE_SLUG]);

  // 4. corner row 3's delete clause: a merge that hands one agent the entire repository is no split
  const built: DraftAgent[] = [];
  for (const agent of all) {
    const own = ownOf(agent);
    if (input.listing.length > 0 && agent.slug !== PRELUDE_SLUG) {
      const globs = parseAll(own);
      if (globs.length > 0 && input.listing.every((path) => ownsPath(globs, path))) {
        const reason = `agent ${agent.slug} would own the whole repository`;
        return { option: null, rejected: { kind: option.kind, reason, probability: null } };
      }
    }
    built.push({
      slug: agent.slug,
      task: taskOf(agent, input.plan.remaining),
      own,
      verify: input.verifyFor(own),
      dependsOn: [...agent.dependsOn],
      items: [...agent.items].sort((a, b) => a - b),
    });
  }
  return { option: { kind: option.kind, agents: built }, rejected: null };
}

// ---------------------------------------------------------------------------------------
// The five enumerators (§3.2's table)
// ---------------------------------------------------------------------------------------

/** Assign each remaining item to the agent covering most of its files; the rest are leftovers. */
function assignByFiles(agents: readonly RawAgent[], input: EnumerateInput, covers: (agent: RawAgent, file: string) => boolean): number[] {
  const leftovers: number[] = [];
  for (let i = 0; i < input.plan.remaining.length; i++) {
    const files = input.itemFiles[i] ?? [];
    let best: RawAgent | null = null;
    let bestCount = 0;
    for (const agent of agents) {
      let count = 0;
      for (const file of files) if (covers(agent, file)) count += 1;
      if (count > bestCount) {
        best = agent;
        bestCount = count;
      }
    }
    if (best === null) {
      leftovers.push(i);
      continue;
    }
    const target = best;
    target.items.push(i);
    if (!target.ownFixed) target.files.push(...files.filter((f) => covers(target, f)));
  }
  return leftovers;
}

function byPlanItem(input: EnumerateInput): RawOption | null {
  const agents: RawAgent[] = [];
  const leftovers: number[] = [];
  const used = new Set<string>();
  for (let i = 0; i < input.plan.remaining.length; i++) {
    const files = input.itemFiles[i] ?? [];
    if (files.length === 0) {
      leftovers.push(i);
      continue;
    }
    const slug = uniqueSlug(used, slugify(input.plan.remaining[i] ?? '', `item-${i + 1}`));
    agents.push(rawAgent(slug, { items: [i], files: [...files], fallbackTask: `work on ${files.slice(0, 4).join(', ')}` }));
  }
  if (agents.length < 2) return null;
  return { kind: 'by_plan_item', agents, leftovers };
}

function byDirectory(input: EnumerateInput): RawOption | null {
  const groups = new Map<string, { items: number[]; files: string[] }>();
  const leftovers: number[] = [];
  for (let i = 0; i < input.plan.remaining.length; i++) {
    const files = input.itemFiles[i] ?? [];
    const counts = new Map<string, number>();
    for (const file of files) {
      const top = topDirOf(file);
      if (top.length > 0) counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    let dir: string | null = null;
    let best = 0;
    for (const [candidate, count] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (count > best) {
        dir = candidate;
        best = count;
      }
    }
    if (dir === null) {
      leftovers.push(i);
      continue;
    }
    const group = groups.get(dir);
    if (group === undefined) groups.set(dir, { items: [i], files: [...files] });
    else {
      group.items.push(i);
      group.files.push(...files);
    }
  }
  if (groups.size < 2) return null;
  const used = new Set<string>();
  const agents = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([dir, group]) =>
      rawAgent(uniqueSlug(used, slugify(dir, 'dir')), {
        items: group.items,
        files: unique(group.files),
        ownRaw: [`${dir}/**`],
        fallbackTask: `work under ${dir}/`,
      }),
    );
  return { kind: 'by_directory', agents, leftovers };
}

function byFailingTest(input: EnumerateInput): RawOption | null {
  const failing = unique(input.lastTestRun?.failingFiles ?? []);
  if (failing.length < 2) return null;
  const used = new Set<string>();
  const agents = failing.map((test) => {
    const imports = input.testImports[test] ?? [];
    return rawAgent(uniqueSlug(used, slugify(test.replace(/\.[^./]+$/, ''), 'test')), {
      files: unique([test, ...imports]),
      fallbackTask: `make ${test} pass`,
    });
  });
  const fileSets = new Map<string, Set<string>>();
  for (const agent of agents) fileSets.set(agent.slug, new Set(agent.files));
  const leftovers = assignByFiles(agents, input, (agent, file) => fileSets.get(agent.slug)?.has(file) === true);
  return { kind: 'by_failing_test', agents, leftovers };
}

function byLayer(input: EnumerateInput): RawOption | null {
  if (input.packages.length < 2) return null;
  const used = new Set<string>();
  const agents = input.packages.map((pkg) =>
    rawAgent(uniqueSlug(used, slugify(pkg.name.length > 0 ? pkg.name : pkg.dir, 'package')), {
      ownRaw: [`${pkg.dir}/**`],
      fallbackTask: `work on the ${pkg.name} package under ${pkg.dir}/`,
    }),
  );
  const dirs = new Map<string, string>();
  for (let i = 0; i < agents.length; i++) dirs.set(agents[i]?.slug ?? '', input.packages[i]?.dir ?? '');
  const leftovers = assignByFiles(agents, input, (agent, file) => {
    const dir = dirs.get(agent.slug) ?? '';
    return dir.length > 0 && file.startsWith(`${dir}/`);
  });
  const withWork = agents.filter((agent) => agent.items.length > 0);
  if (withWork.length < 2) return null;
  return { kind: 'by_layer', agents: withWork, leftovers };
}

function asWritten(input: EnumerateInput): RawOption | null {
  const draft = input.asWritten;
  if (draft === null || draft.agents.length < 2) return null;
  const used = new Set<string>();
  const agents = draft.agents.map((agent, i) =>
    rawAgent(uniqueSlug(used, agent.slug.length > 0 ? agent.slug : `agent-${i + 1}`), {
      ownRaw: [...agent.own],
      ownFixed: true,
      fixedTask: agent.task,
      dependsOn: [...(agent.dependsOn ?? [])],
      fallbackTask: agent.task,
    }),
  );
  const globs = new Map<string, OwnGlob[]>();
  for (const agent of agents) globs.set(agent.slug, parseAll(agent.ownRaw));
  // The generator's globs are kept verbatim, so the agent's file set exists only to find the shared
  // ones: it is the slice of the listing its globs already cover.
  for (const agent of agents) {
    const parsed = globs.get(agent.slug) ?? [];
    agent.files = input.listing.filter((path) => ownsPath(parsed, path));
  }
  const leftovers = assignByFiles(agents, input, (agent, file) => ownsPath(globs.get(agent.slug) ?? [], file));
  return { kind: 'as_written', agents, leftovers };
}

// ---------------------------------------------------------------------------------------

export function enumerateSplits(input: EnumerateInput): { options: DraftSplit[]; rejected: RejectedOption[] } {
  const options: DraftSplit[] = [];
  const rejected: RejectedOption[] = [];
  // §3.5's `split: 'auto'` fallback takes the first option that normalised, in exactly this order.
  const raws = [byFailingTest(input), byLayer(input), byDirectory(input), byPlanItem(input), asWritten(input)];
  for (const raw of raws) {
    if (raw === null) continue;
    const done = finish(raw, input);
    if (done.rejected !== null) rejected.push(done.rejected);
    if (done.option !== null) options.push(done.option);
  }
  options.push({ kind: 'no_split', agents: [] });
  return { options, rejected };
}
