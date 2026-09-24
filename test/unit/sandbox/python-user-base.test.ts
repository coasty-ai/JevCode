/**
 * A pytest installed with `pip install --user` lives under Python's user base, which is derived from HOME; the sandbox
 * remaps HOME, so without this pass-through the first live run on such a machine sees `No module named pytest`, a
 * baseline of errors, no failing test and nothing to fix (found by the 0.6.0 release drive).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePythonUserBase } from '../../../src/sandbox/run.js';

describe('resolvePythonUserBase', () => {
  const temps: string[] = [];
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("the caller's own PYTHONUSERBASE wins and is never probed", () => {
    let probed = 0;
    expect(resolvePythonUserBase({ env: { PYTHONUSERBASE: '/opt/pyuser' }, probe: () => { probed++; return '/elsewhere'; } })).toBe('/opt/pyuser');
    expect(probed).toBe(0);
  });

  it('a probe that answers an existing directory is passed through; a missing one or no answer yields null', () => {
    const d = mkdtempSync(join(tmpdir(), 'jevcode-pyuser-')); temps.push(d);
    expect(resolvePythonUserBase({ env: {}, probe: () => d })).toBe(d);
    expect(resolvePythonUserBase({ env: {}, probe: () => join(d, 'nope') })).toBeNull();
    expect(resolvePythonUserBase({ env: {}, probe: () => null })).toBeNull();
    expect(resolvePythonUserBase({ env: {}, probe: () => '' })).toBeNull();
  });

  it('an empty PYTHONUSERBASE in the environment does not win', () => {
    const d = mkdtempSync(join(tmpdir(), 'jevcode-pyuser-')); temps.push(d);
    expect(resolvePythonUserBase({ env: { PYTHONUSERBASE: '' }, probe: () => d })).toBe(d);
  });
});
