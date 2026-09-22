/**
 * The verification set, resolved by code (docs/ORCHESTRATION-DESIGN.md §5.1).
 *
 * Six steps, first hit wins: config, `package.json` scripts, the ecosystem's own marker files, the
 * synth oracle's runner, the parent's last test command, nothing. Step 6 hands back the exact string
 * §5.1 names, because §3.4 rule 5 quotes it into the manifest when every agent is downgraded to
 * `research`.
 *
 * The non-obvious invariant: a step whose candidates are ALL lost to the hostile-string filter (a NUL
 * or a newline would turn one command into two) does not end the search — the next step is tried, and
 * the drop is recorded in `reason`. A config holding one unusable command must not leave a repository
 * that plainly has `npm test` with no verification at all.
 *
 * Pure: no fs, no spawn, no clock. The root file names, the Makefile text, the oracle's runner and the
 * parent's last command all arrive on the input, because `src/orchestrate/**` owns no I/O (§8.1 rule 1).
 */
import { VERIFY_COMMANDS_MAX } from '../core/limits.js';

/** §3.7 `AgentSpec.verify`: one command is at most this many characters. */
export const VERIFY_COMMAND_CHARS = 200;

/** §5.1 step 6, verbatim: the manifest shows this when no command could be resolved. */
export const NO_VERIFICATION_REASON = 'no verification command found; agents are research-only (set orchestrate.verify to allow code agents)';

export type VerifySource = 'config' | 'package_scripts' | 'ecosystem' | 'synth_oracle' | 'last_test_run' | 'none';

/** §5.1 step 2: only these three script names, only when present, in this order. */
const PACKAGE_SCRIPTS: readonly string[] = ['test', 'typecheck', 'lint'];

export interface VerifyResolveInput {
  /** `orchestrate.verify` — explicit wins over all six steps */
  configured: readonly string[];
  packageJson: { scripts?: Readonly<Record<string, string>> } | null;
  /** repo-relative file names that exist at the repo root (pyproject.toml, Cargo.toml, go.mod, Makefile, …) */
  rootFiles: ReadonlySet<string>;
  /** the Makefile's text, so a `test:` target can be detected; null when there is none */
  makefile: string | null;
  /** the synth oracle's runner command when the workspace is one it handles; null otherwise */
  synthRunner: string | null;
  /** the parent's `lastTestRun.command` — whatever the parent actually ran and parsed */
  lastTestRunCommand: string | null;
}

export interface VerifyResolution {
  commands: readonly string[];
  source: VerifySource;
  reason: string | null;
}

interface Filtered {
  commands: string[];
  /** commands refused for holding a NUL or a newline; a count, so the reason never quotes one */
  dropped: number;
}

function filterCommands(raw: readonly string[]): Filtered {
  const out: string[] = [];
  let dropped = 0;
  for (const candidate of raw) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.includes('\0') || /[\r\n]/.test(trimmed)) {
      dropped += 1;
      continue;
    }
    out.push(trimmed.length > VERIFY_COMMAND_CHARS ? trimmed.slice(0, VERIFY_COMMAND_CHARS) : trimmed);
    if (out.length === VERIFY_COMMANDS_MAX) break;
  }
  return { commands: out, dropped };
}

function packageScriptCommands(pkg: VerifyResolveInput['packageJson']): string[] {
  const scripts = pkg?.scripts;
  if (scripts === undefined) return [];
  const out: string[] = [];
  for (const name of PACKAGE_SCRIPTS) {
    const body = scripts[name];
    if (typeof body === 'string' && body.trim().length > 0) out.push(`npm run ${name}`);
  }
  return out;
}

/**
 * §5.1 step 3. First ecosystem wins inside the step too: a repository that is both a cargo crate and a
 * go module would otherwise run two suites for every agent, and the parent's own `lastTestRun` is the
 * better evidence of which one matters.
 */
function ecosystemCommands(rootFiles: ReadonlySet<string>, makefile: string | null): string[] {
  if (rootFiles.has('pyproject.toml') || rootFiles.has('pytest.ini') || rootFiles.has('tox.ini')) return ['pytest -q'];
  if (rootFiles.has('Cargo.toml')) return ['cargo test'];
  if (rootFiles.has('go.mod')) return ['go test ./...'];
  if (rootFiles.has('Makefile') && makefile !== null && /^test:/m.test(makefile)) return ['make test'];
  return [];
}

export function resolveVerification(input: VerifyResolveInput): VerifyResolution {
  const notes: string[] = [];
  const steps: readonly { source: VerifySource; raw: readonly string[] }[] = [
    { source: 'config', raw: input.configured },
    { source: 'package_scripts', raw: packageScriptCommands(input.packageJson) },
    { source: 'ecosystem', raw: ecosystemCommands(input.rootFiles, input.makefile) },
    { source: 'synth_oracle', raw: input.synthRunner === null ? [] : [input.synthRunner] },
    { source: 'last_test_run', raw: input.lastTestRunCommand === null ? [] : [input.lastTestRunCommand] },
  ];
  for (const step of steps) {
    if (step.raw.length === 0) continue;
    const filtered = filterCommands(step.raw);
    if (filtered.dropped > 0) notes.push(`dropped ${filtered.dropped} ${step.source} verification command${filtered.dropped === 1 ? '' : 's'} holding a newline or NUL`);
    if (step.raw.length > VERIFY_COMMANDS_MAX) notes.push(`kept the first ${VERIFY_COMMANDS_MAX} of ${step.raw.length} verification commands`);
    if (filtered.commands.length === 0) continue;
    return { commands: filtered.commands, source: step.source, reason: notes.length === 0 ? null : notes.join('; ') };
  }
  // Step 6's string is quoted into the manifest, so the drop notes are deliberately not appended to it.
  return { commands: [], source: 'none', reason: NO_VERIFICATION_REASON };
}

/**
 * The per-agent view of the resolution, and the single function `enumerate.ts` is injected with.
 * Scoping a suite to one agent's slice (running only the tests its `own` covers) is a later wave, so
 * every agent gets the whole set today; the seam exists now so that change touches one function.
 */
export function verifyForOwn(resolution: VerifyResolution, _own: readonly string[]): readonly string[] {
  return resolution.commands;
}
