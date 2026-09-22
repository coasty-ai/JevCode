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
 * Failing-first: red against the bundle built at d297b29 (`tail -c 80 dist/jevcode.mjs` ends in the directive).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const BUNDLE = join(ROOT, 'dist/jevcode.mjs');
const BUILT = existsSync(BUNDLE);
/** the run where the artefact exists says so; the skip says why it does not, so it is never silent */
const WHY = BUILT ? `${statSync(BUNDLE).size} bytes` : 'dist/jevcode.mjs is absent — run `npm run build`';

describe('the built bundle and the gates that keep it shippable', () => {
  it.skipIf(!BUILT)(`dist/jevcode.mjs has no sourceMappingURL directive (${WHY})`, () => {
    const text = readFileSync(BUNDLE, 'utf8');
    const hit = /\/\/[#@]\s*sourceMappingURL=(.*)/.exec(text);
    expect(hit?.[1] ?? null, 'the map is excluded from the tarball, so the directive would dangle in every install').toBeNull();
    // the map itself is still written beside it for local debugging
    expect(existsSync(`${BUNDLE}.map`)).toBe(true);
  });

  it('the build emits the map without a directive rather than stripping one afterwards', () => {
    const build = readFileSync(join(ROOT, 'scripts/build.mjs'), 'utf8');
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

  it('check-pack gates the directive too, so the artefact is checked even when no unit run sees a dist/', () => {
    const check = readFileSync(join(ROOT, 'scripts/check-pack.mjs'), 'utf8');
    expect(check).toMatch(/sourceMappingURL/);
    expect(check).toMatch(/\\\.map\$/); // the forbidden-path rule that makes the reference dangle
  });
});
