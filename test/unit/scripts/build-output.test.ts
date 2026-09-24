/**
 * The shipped bundle carries no dangling source-map reference (F24c).
 *
 * `scripts/build.mjs` wrote `dist/jevcode.mjs` with `sourcemap: true`, which appends
 * `//# sourceMappingURL=jevcode.mjs.map` to the end of the file. The map is deliberately NOT in package.json
 * `files`, and `scripts/check-pack.mjs`'s forbidden list rejects any `*.map` in the tarball — so every installed
 * copy of jevcode carried a reference to a file that is not there. Node with `--enable-source-maps`, and any tool
 * that follows the directive, then reads a missing file on every stack trace. The release pass emits the map with
 * `sourcemap: 'external'` instead: the map is still written for local debugging, the bundle just does not point
 * at it.
 *
 * WHICH artefact the first case reads is the whole difficulty, and the first version of this file got it wrong:
 * it asserted on `dist/jevcode.mjs` whenever one existed, so any working tree carrying a bundle built BEFORE this
 * commit — the integrator's own checkout, for one — went red on `npm test` with nothing wrong in it. A unit test
 * may only assert on an artefact THIS tree's build produced, so the case runs when the bundle is at least as new
 * as `scripts/build.mjs` and is skipped, loudly and with both timestamps, when it is not. The three cases below
 * it read only tracked files and are therefore unconditional.
 *
 * That leaves the shipped artefact itself gated where a build always precedes the check rather than here:
 * `scripts/check-pack.mjs` gate 9 reads the same directive out of `dist/jevcode.mjs` and runs immediately after
 * `npm run build` in `npm run release:check` and in .github/workflows/release.yml (where the unit suite runs BEFORE
 * the build and this case therefore skips by design).
 *
 * Failing-first, twice: (1) red against the bundle built at d297b29 (`tail -c 80 dist/jevcode.mjs` ends in the
 * directive) — that is the fact the file pins; (2) the staleness guard itself, verified 2026-09-22 by copying the
 * d297b29 bundle (2,854,415 bytes, directive present) over `dist/jevcode.mjs` with `cp -p`, i.e. with its mtime
 * preserved. Before the guard the case FAILED ("expected 'jevcode.mjs.map' to be null"); after it the run reads
 *   ↓ dist/jevcode.mjs has no sourceMappingURL directive (skipped: dist/jevcode.mjs is stale
 *     (2026-09-22T21:26:04Z < scripts/build.mjs 2026-09-22T21:27:40Z) — run `npm run build`; ...)
 * and it passes again on the bundle this tree's own build wrote.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const BUNDLE = join(ROOT, 'dist/jevcode.mjs');
/** the bundle is this build's output only if it is no older than the script that writes it */
const BUILD_SCRIPT = join(ROOT, 'scripts/build.mjs');

/** UTC, marked as such: the skip line is read next to an `ls -la` in local time and must not be mistaken for it */
const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

const bundleStat = existsSync(BUNDLE) ? statSync(BUNDLE) : null;
const scriptMs = statSync(BUILD_SCRIPT).mtimeMs;
/** THIS build produced it: an older bundle is a different program's output and says nothing about this tree */
const FRESH = bundleStat !== null && bundleStat.mtimeMs >= scriptMs;
/** the run where the artefact exists says so; the skip says exactly why it does not, so it is never silent */
const WHY =
  bundleStat === null
    ? 'skipped: dist/jevcode.mjs is absent — run `npm run build`'
    : FRESH
      ? `${bundleStat.size} bytes, built ${stamp(bundleStat.mtimeMs)}`
      : `skipped: dist/jevcode.mjs is stale (${stamp(bundleStat.mtimeMs)} < scripts/build.mjs ${stamp(scriptMs)}) — run \`npm run build\`; check-pack gate 9 is the always-on gate`;

describe('the built bundle and the gates that keep it shippable', () => {
  it.skipIf(!FRESH)(`dist/jevcode.mjs has no sourceMappingURL directive (${WHY})`, () => {
    const text = readFileSync(BUNDLE, 'utf8');
    const hit = /\/\/[#@]\s*sourceMappingURL=(.*)/.exec(text);
    expect(hit?.[1] ?? null, 'the map is excluded from the tarball, so the directive would dangle in every install').toBeNull();
    // the map itself is still written beside it for local debugging
    expect(existsSync(`${BUNDLE}.map`)).toBe(true);
  });

  it('the build emits the map without a directive rather than stripping one afterwards', () => {
    const build = readFileSync(BUILD_SCRIPT, 'utf8');
    // pass 2 is the shipped artefact; `sourcemap: true` is what appends the directive
    expect(build).toMatch(/sourcemap:\s*'external'/);
    expect(build).not.toMatch(/sourcemap:\s*true/);
  });

  it('the map is excluded from the tarball, which is what makes a directive dangling', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('dist/jevcode.mjs');
    expect(pkg.files).not.toContain('dist/jevcode.mjs.map');
    expect(pkg.files.some((f) => f === 'dist' || f === 'dist/')).toBe(false);
  });

  it('check-pack gates the directive too, so the artefact is checked even when no unit run sees a fresh dist/', () => {
    const check = readFileSync(join(ROOT, 'scripts/check-pack.mjs'), 'utf8');
    expect(check).toMatch(/sourceMappingURL/);
    expect(check).toMatch(/\\\.map\$/); // the forbidden-path rule that makes the reference dangle
    // and it runs after a build, never before one: that ordering is what this file cannot have, because
    // the unit suite (`npm test`, this file) runs BEFORE `npm run build` in the same job
    const wf = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const at = (step: string): number => wf.indexOf(`run: npm run ${step}`);
    expect(at('build'), 'the release job must build').toBeGreaterThan(0);
    expect(at('pack:check'), 'the release job must run the pack gates').toBeGreaterThan(at('build'));
    const suite = wf.indexOf('run: npm test');
    expect(suite, 'the release job must run the unit suite').toBeGreaterThan(0);
    expect(suite, 'this suite runs before the build, which is why the case above is skipped there').toBeLessThan(at('build'));
  });
});
