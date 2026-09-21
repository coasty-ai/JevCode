/**
 * Global setup of the `pty` project (TUI-DESIGN §19.5): the scenarios drive `bin/jevcode.js`, which loads the
 * bundle `dist/jevcode.mjs`, so a bundle older than the newest input (src/**, package.json, package-lock.json,
 * scripts/build.mjs, bin/jevcode.js) is rebuilt first (`scripts/build.mjs --no-smoke --no-measure`;
 * `JEVCODE_PTY_NO_BUILD=1` skips the check). The launcher and the bundle are then copied into a per-run temp dir
 * (`<tmp>/bin/jevcode.js` + `<tmp>/dist/jevcode.mjs`, the layout the launcher's relative import needs) whose path the
 * workers read from `JEVCODE_PTY_BIN`, so a rebuild of the shared `dist/` by another process mid-suite cannot change
 * or tear the bundle under a running scenario; one `--version` spawn of the copy warms the V8 compile cache so the
 * first-frame gate measures a warm start (§18). Nothing runs without expect(1); with expect present a missing driver
 * script is an error, never a silent skip.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN, DIST, DRIVER, PTY_BIN_ENV, ROOT, hasExpect, newestMtime } from './helpers.js';

function mtimeOrZero(p: string): number {
  return existsSync(p) ? statSync(p).mtimeMs : 0;
}

export default function setup(): (() => void) | undefined {
  if (!hasExpect) return undefined;
  if (!existsSync(DRIVER)) throw new Error(`pty global setup: ${DRIVER} is missing while expect(1) is present — the suite cannot skip`);
  if (process.env['JEVCODE_PTY_NO_BUILD'] !== '1') {
    const inputs = [join(ROOT, 'package.json'), join(ROOT, 'package-lock.json'), join(ROOT, 'scripts', 'build.mjs'), BIN];
    const newest = Math.max(newestMtime(join(ROOT, 'src')), ...inputs.map(mtimeOrZero));
    const stale = !existsSync(DIST) || statSync(DIST).mtimeMs < newest;
    if (stale) {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--no-smoke', '--no-measure'], { cwd: ROOT, stdio: 'inherit', timeout: 120_000 });
      if (r.status !== 0) throw new Error(`pty global setup: scripts/build.mjs exited ${r.status ?? 'null'}`);
    }
  }
  if (!existsSync(DIST)) throw new Error(`pty global setup: ${DIST} is missing (JEVCODE_PTY_NO_BUILD=1 with no bundle on disk?)`);
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-pty-bundle-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'dist'));
  copyFileSync(BIN, join(dir, 'bin', 'jevcode.js'));
  copyFileSync(DIST, join(dir, 'dist', 'jevcode.mjs'));
  const bin = join(dir, 'bin', 'jevcode.js');
  process.env[PTY_BIN_ENV] = bin;
  const warm = spawnSync(process.execPath, [bin, '--version'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  if (warm.status !== 0) throw new Error(`pty global setup: ${bin} --version exited ${warm.status ?? 'null'}: ${warm.stderr}`);
  return () => rmSync(dir, { recursive: true, force: true });
}
