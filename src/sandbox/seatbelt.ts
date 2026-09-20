/**
 * Seatbelt (sandbox-exec) profile generation (DESIGN.md §8, research 09 §3.2).
 *
 * Base is `(allow default)`: `(deny default)` breaks ordinary toolchains. Writes are then
 * denied everywhere except the workspace, the run's tmp/home and the tty devices; the
 * harness's own secret stores are unreadable. Every path is canonicalised first because
 * `subpath` matches kernel paths only (`/tmp` -> `/private/tmp`); a symlinked prefix would
 * silently deny everything under it. Later rules win, so the specific `.git` denials sit
 * after the workspace allow.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SandboxLevel, SandboxProfile } from '../core/types.js';
import { canonicalPathSync } from './paths.js';

export interface ProfileOptions {
  ws: string;
  runTmp: string;
  runHome: string;
  /** realpath of the harness's stdout when it is a terminal; writes to it are denied */
  ttyPath: string | null;
  /** absolute paths (files or directories) the child must not read */
  readDenies: readonly string[];
  noNetwork: boolean;
  /** injectable for tests; default os.homedir() (the child's HOME is remapped, so never $HOME) */
  home?: string;
  /** further writable roots (bench stand-ins for /output, /results, /logs); canonicalised like every other path */
  extraWritable?: readonly string[];
  /** further read-only roots under a read-denied prefix (the bench's shared git object cache) */
  extraReadable?: readonly string[];
}

/** SBPL string literal: double-quoted with backslash and quote escaped. */
export function sbplString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const HOME_SECRET_SUBPATHS = [join('.config', 'jevcode'), '.ssh', '.aws', join('.config', 'gh')];
const HOME_SECRET_LITERALS = ['.netrc'];

export function buildProfile(opts: ProfileOptions): string {
  const ws = canonicalPathSync(opts.ws);
  const runTmp = canonicalPathSync(opts.runTmp);
  const runHome = canonicalPathSync(opts.runHome);
  const home = canonicalPathSync(opts.home ?? homedir());

  const extra: string[] = [];
  for (const p of opts.extraWritable ?? []) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const canon = canonicalPathSync(p);
    if (canon !== ws && canon !== runTmp && canon !== runHome && !extra.includes(canon)) extra.push(canon);
  }

  const lines: string[] = ['(version 1)', '(allow default)', '(deny file-write*)'];
  lines.push(
    `(allow file-write* (subpath ${sbplString(ws)}) (subpath ${sbplString(runTmp)}) (subpath ${sbplString(runHome)})${extra.map((p) => ` (subpath ${sbplString(p)})`).join('')}`,
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")',
    '  (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))',
  );
  const gitDenies = [`(literal ${sbplString(join(ws, '.git', 'config'))})`, `(subpath ${sbplString(join(ws, '.git', 'hooks'))})`];
  if (opts.ttyPath && opts.ttyPath.startsWith('/dev/')) gitDenies.push(`(literal ${sbplString(canonicalPathSync(opts.ttyPath))})`);
  lines.push(`(deny file-write* ${gitDenies.join(' ')})`);

  const reads: string[] = [];
  const seen = new Set<string>();
  const addRead = (rule: string): void => {
    if (!seen.has(rule)) {
      seen.add(rule);
      reads.push(rule);
    }
  };
  for (const p of opts.readDenies) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const canon = canonicalPathSync(p);
    // A directory deny must cover its contents; a file deny is a literal. Unknown (not yet
    // existing) paths get both so a later mkdir cannot slip through.
    addRead(`(literal ${sbplString(canon)})`);
    addRead(`(subpath ${sbplString(canon)})`);
  }
  for (const rel of HOME_SECRET_SUBPATHS) addRead(`(subpath ${sbplString(canonicalPathSync(join(home, rel)))})`);
  for (const rel of HOME_SECRET_LITERALS) addRead(`(literal ${sbplString(canonicalPathSync(join(home, rel)))})`);
  lines.push(`(deny file-read* ${reads.join(' ')})`);
  // The jevcode home holds every run's checkpoints and the bench work areas. Deny reading file
  // CONTENTS there (other runs' prompts and outputs stay private) but keep metadata readable, so
  // `mkdir -p`, `cd` and `git clone` can traverse into the roots this run may use; then re-allow
  // full reads under every writable root (later rules win in SBPL). The run's own checkpoints
  // (state.json, *.jsonl) sit outside runTmp/runHome and therefore stay unreadable.
  const jevHome = canonicalPathSync(join(home, '.jevcode'));
  lines.push(`(deny file-read-data (subpath ${sbplString(jevHome)}))`);
  // A deny on the specific operation outranks a later allow on the `file-read*` family, so the
  // re-allow names file-read-data explicitly (verified on macOS 26).
  const readable: string[] = [];
  for (const p of opts.extraReadable ?? []) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const canon = canonicalPathSync(p);
    if (canon !== ws && canon !== runTmp && canon !== runHome && !extra.includes(canon) && !readable.includes(canon)) readable.push(canon);
  }
  const roots = `(subpath ${sbplString(ws)}) (subpath ${sbplString(runTmp)}) (subpath ${sbplString(runHome)})${[...extra, ...readable].map((p) => ` (subpath ${sbplString(p)})`).join('')}`;
  lines.push(`(allow file-read-data ${roots})`);
  lines.push(`(allow file-read* ${roots})`);

  if (opts.noNetwork) lines.push('(deny network*)');
  return `${lines.join('\n')}\n`;
}

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function detectSandboxLevel(profile: SandboxProfile, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): SandboxLevel {
  if (profile === 'none') return 'none';
  return platform === 'darwin' && exists(SANDBOX_EXEC) ? 'seatbelt' : 'none';
}
