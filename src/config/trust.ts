/**
 * Workspace trust store (TUI-DESIGN §11.3, A59, A122, D6). `~/.jevcode/trust.json` (0600, inside
 * the seatbelt-protected tree) keyed by the realpath of the git root (or the workspace):
 * `{ "<root>": { decision, at, agents: { path, sha256 } | null } }`. A stored `trust` whose
 * `AGENTS.md` sha256 changed re-prompts; `session` decisions live in memory only; `$HOME` as
 * the workspace is never persisted; `--trust-workspace` / `JEVCODE_TRUST_WORKSPACE=1` trusts
 * for scripts; non-interactive runs skip instruction files with one stderr line.
 */
import { chmod, readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { isJsonObject, parseJson } from '../core/json.js';
import { SECRET_NAME_RE } from '../core/redact.js';
import type { InstructionRecord, Json, JsonObject } from '../core/types.js';
import { readDotenv } from './env.js';

/** TUI-DESIGN §11.3: what the trust prompt lists — sizes and counts, never values (F-O). Rendered by `tui/onboarding/lines.ts`. */
export interface TrustInputs {
  /** git root or workspace realpath */
  root: string;
  agents: { name: 'AGENTS.md' | 'CLAUDE.md'; bytes: number } | null;
  /** `unreadable` = the file exists but could not be parsed (oversize, EACCES): still an untrusted input */
  dotenv: { vars: number; secretLike: number; unreadable?: boolean } | null;
  jevcodeJson: { bytes: number } | null;
  /** a stored decision exists but the instruction file's sha256 changed: `<old8> → <new8>` */
  changed?: { from: string; to: string } | null;
}

/** TUI-DESIGN §11.3: the stored decision (`session` is memory-only). */
export type TrustDecision = 'trust' | 'session' | 'none';
/** TUI-DESIGN §11.3: the prompt's numbered options. */
export type TrustOption = 1 | 2 | 3;

/** TUI-DESIGN §11.3: `AGENTS.md@sha256` as stored. */
export interface TrustAgents {
  path: string;
  sha256: string;
}
/** TUI-DESIGN §11.3: one entry of trust.json. */
export interface TrustRecord {
  decision: TrustDecision;
  at: string;
  agents: TrustAgents | null;
}
/** TUI-DESIGN §11.3: trust.json keyed by root realpath. */
export type TrustFileData = Record<string, TrustRecord>;

/** TUI-DESIGN §11.3: `~/.jevcode/trust.json`. */
export function trustFilePath(home: string): string {
  return join(home, '.jevcode', 'trust.json');
}

/** TUI-DESIGN §11.3: `1 trust · 2 this session only · 3 don't trust`. */
export function decisionFromOption(option: TrustOption): TrustDecision {
  return option === 1 ? 'trust' : option === 2 ? 'session' : 'none';
}

/** TUI-DESIGN §11.3: the realpath of the git root, else of the workspace (a missing path resolves lexically). */
export function trustKey(gitRoot: string | null, workspace: string, realpath: (p: string) => string = realpathSync): string {
  const p = gitRoot ?? workspace;
  try {
    return realpath(p);
  } catch {
    return resolvePath(p);
  }
}

/** TUI-DESIGN §11.3: `--trust-workspace` or `JEVCODE_TRUST_WORKSPACE=1` (`0`/`false` unset). */
export function trustWorkspaceFlag(env: NodeJS.ProcessEnv, flag: boolean | undefined): boolean {
  if (flag === true) return true;
  const v = env['JEVCODE_TRUST_WORKSPACE']?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

function isDecision(v: unknown): v is TrustDecision {
  return v === 'trust' || v === 'session' || v === 'none';
}

/** Tolerant parse of trust.json: malformed entries are dropped, `session` entries never load (memory-only by definition). */
export function parseTrustFile(text: string): TrustFileData {
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return {};
  const out: TrustFileData = {};
  for (const [root, rec] of Object.entries(parsed.value)) {
    if (!isJsonObject(rec) || !isDecision(rec['decision']) || rec['decision'] === 'session') continue;
    const at = typeof rec['at'] === 'string' ? rec['at'] : '';
    const a = rec['agents'];
    const agents = isJsonObject(a) && typeof a['path'] === 'string' && typeof a['sha256'] === 'string' ? { path: a['path'], sha256: a['sha256'] } : null;
    out[root] = { decision: rec['decision'], at, agents };
  }
  return out;
}

/** TUI-DESIGN §11.3: the outcome of `evaluateTrust`. */
export type TrustStatus =
  | { kind: 'trusted'; via: 'flag' | 'stored' | 'session' | 'nothing' }
  | { kind: 'untrusted'; via: 'stored' | 'session' | 'non-interactive' }
  | { kind: 'prompt'; reason: 'none' | 'changed'; changed: { from: string; to: string } | null };

/** TUI-DESIGN §11.3: inputs of the pure trust decision. */
export interface EvaluateTrustInput {
  /** the stored (or session) record for this root */
  record: TrustRecord | null;
  /** the instruction file found for this run (path + sha256), or null */
  agents: TrustAgents | null;
  /** anything untrusted exists: AGENTS.md/CLAUDE.md, ./.env, ./jevcode.json */
  hasUntrustedInputs: boolean;
  interactive: boolean;
  trustWorkspace: boolean;
}

/**
 * TUI-DESIGN §11.3: decide whether to prompt. Pure. `--trust-workspace` wins; nothing untrusted →
 * nothing to ask; a stored `trust` with a changed `AGENTS.md` sha256 re-prompts (`changed`); a
 * stored `trust` without an instruction file that now has one prompts; `none` stays untrusted;
 * no record → prompt when interactive, else untrusted (skip with the stderr line).
 */
export function evaluateTrust(input: EvaluateTrustInput): TrustStatus {
  if (input.trustWorkspace) return { kind: 'trusted', via: 'flag' };
  if (!input.hasUntrustedInputs) return { kind: 'trusted', via: 'nothing' };
  const r = input.record;
  if (r) {
    if (r.decision === 'none') return { kind: 'untrusted', via: 'stored' };
    const via = r.decision === 'session' ? 'session' : 'stored';
    if (input.agents) {
      if (r.agents === null) return input.interactive ? { kind: 'prompt', reason: 'none', changed: null } : { kind: 'untrusted', via: 'non-interactive' };
      if (r.agents.sha256 !== input.agents.sha256) {
        return input.interactive ? { kind: 'prompt', reason: 'changed', changed: { from: r.agents.sha256.slice(0, 8), to: input.agents.sha256.slice(0, 8) } } : { kind: 'untrusted', via: 'non-interactive' };
      }
    }
    return { kind: 'trusted', via };
  }
  return input.interactive ? { kind: 'prompt', reason: 'none', changed: null } : { kind: 'untrusted', via: 'non-interactive' };
}

/** TUI-DESIGN §11.3: I/O seams for tests. */
export interface TrustStoreDeps {
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, text: string) => Promise<void>;
  realpath?: (p: string) => string;
}

/** TUI-DESIGN §11.3: the trust store handle. */
export interface TrustStore {
  readonly path: string;
  /** read the file once (missing or malformed → empty); safe to call again */
  load(): Promise<void>;
  /** session decisions first, then the file */
  get(root: string): TrustRecord | null;
  /**
   * record a decision; `session` and a `$HOME` root stay in memory (`persisted: false`); `trust`
   * and `none` are written atomically with mode 0600
   */
  set(root: string, decision: TrustDecision, agents: TrustAgents | null, at: string, home: string): Promise<{ persisted: boolean }>;
  evaluate(root: string, input: Omit<EvaluateTrustInput, 'record'>): TrustStatus;
  /** the persisted records (for tests and `jevcode report`) */
  snapshot(): TrustFileData;
}

/** TUI-DESIGN §11.3: the trust store over `~/.jevcode/trust.json` (0600). */
export function createTrustStore(path: string, deps: TrustStoreDeps = {}): TrustStore {
  const read = deps.readFile ?? ((p: string): Promise<string> => readFile(p, 'utf8'));
  const write =
    deps.writeFile ??
    (async (p: string, text: string): Promise<void> => {
      await writeFileAtomic(p, text, { mode: 0o600, mkdir: true });
      try {
        await chmod(p, 0o600);
      } catch {
        /* Windows or a foreign mount: the atomic write already asked for 0600 */
      }
    });
  const realpath = deps.realpath ?? realpathSync;
  let data: TrustFileData = {};
  const session = new Map<string, TrustRecord>();
  let loaded = false;

  function realKey(p: string): string {
    try {
      return realpath(p);
    } catch {
      return resolvePath(p);
    }
  }
  /** `$HOME` as the root is never persisted — compared by realpath so a symlink to the home directory counts too. */
  function isHome(root: string, home: string): boolean {
    return root === home || root === resolvePath(home) || realKey(root) === realKey(home);
  }
  async function load(): Promise<void> {
    try {
      data = parseTrustFile(await read(path));
    } catch {
      data = {};
    }
    loaded = true;
  }
  function get(root: string): TrustRecord | null {
    return session.get(root) ?? data[root] ?? null;
  }

  return {
    path,
    load,
    get,
    async set(root, decision, agents, at, home) {
      const rec: TrustRecord = { decision, at, agents };
      if (decision === 'session' || isHome(root, home)) {
        session.set(root, rec);
        return { persisted: false };
      }
      session.delete(root);
      if (!loaded) await load();
      data = { ...data, [root]: rec };
      const json: Json = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { decision: v.decision, at: v.at, agents: v.agents ? { path: v.agents.path, sha256: v.agents.sha256 } : null } as JsonObject]));
      try {
        await write(path, `${JSON.stringify(json, null, 2)}\n`);
      } catch {
        // §4.6 judge-safety rule d: a failed trust.json write is a toast + log line, never fatal; the decision holds for this process.
        return { persisted: false };
      }
      return { persisted: true };
    },
    evaluate(root, input) {
      return evaluateTrust({ ...input, record: get(root) });
    },
    snapshot() {
      return { ...data };
    },
  };
}

/**
 * TUI-DESIGN §11.3: the prompt's inputs — sizes and counts only (F-O); never a value. A `.env`
 * that is a directory is no `.env`; one that exists but cannot be parsed (oversize → ConfigError,
 * EACCES) is listed as `unreadable` and still counts as an untrusted input.
 */
export async function probeTrustInputs(workspace: string, root: string, agents: InstructionRecord | null, agentsName: 'AGENTS.md' | 'CLAUDE.md' | null, changed: { from: string; to: string } | null = null): Promise<TrustInputs & { hasUntrustedInputs: boolean }> {
  let dotenv: TrustInputs['dotenv'] = null;
  const dotenvPath = join(workspace, '.env');
  let dotenvIsFile = false;
  try {
    dotenvIsFile = (await stat(dotenvPath)).isFile();
  } catch {
    dotenvIsFile = false;
  }
  if (dotenvIsFile) {
    try {
      const loaded = await readDotenv(dotenvPath);
      if (loaded) {
        let secretLike = 0;
        for (const k of loaded.vars.keys()) if (SECRET_NAME_RE.test(k)) secretLike++;
        dotenv = { vars: loaded.vars.size, secretLike };
      }
    } catch {
      dotenv = { vars: 0, secretLike: 0, unreadable: true };
    }
  }
  let jevcodeJson: TrustInputs['jevcodeJson'] = null;
  try {
    const st = await stat(join(workspace, 'jevcode.json'));
    if (st.isFile()) jevcodeJson = { bytes: st.size };
  } catch {
    jevcodeJson = null;
  }
  const agentsInput: TrustInputs['agents'] = agents ? { name: agentsName ?? 'AGENTS.md', bytes: agents.bytes } : null;
  return { root, agents: agentsInput, dotenv, jevcodeJson, changed, hasUntrustedInputs: agentsInput !== null || dotenv !== null || jevcodeJson !== null };
}
