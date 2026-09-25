/**
 * TUI-DESIGN §19.0 (`files.test.ts` row) / §5.4: the standalone `listCandidates(root, { secretPaths, redact, max })`
 * walker — no run dir, no Sandbox, no git — with the in-run exclusions plus the `@` denylist.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '../../../src/errors.js';
import { MAX_CANDIDATE_BYTES } from '../../../src/workspace/candidates.js';
import { listCandidates } from '../../../src/workspace/files.js';
import { write } from './helpers.js';

let temps: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'jev-lc-')));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});
const id = (s: string): string => s;

describe('listCandidates standalone (§5.4)', () => {
  it('walks without a run dir, sandbox or git; applies the secret, mention-denylist, symlink, binary and size rules; sorted', async () => {
    const base = tmp();
    const root = join(base, 'ws');
    mkdirSync(root);
    write(root, 'src/a.py', 'print(1)\n');
    write(root, 'README.md', '# hi\n');
    write(root, '.env', 'KEY=abcdefghijkl\n');
    write(root, '.env.example', 'KEY=\n');
    write(root, 'config/.npmrc', '//registry/:_authToken=abc\n');
    write(root, 'aws/credentials', '[default]\n');
    write(root, 'certs/site.p12', 'x');
    write(root, 'keys/id_rsa', 'x');
    write(root, '.git/config', '[core]\n');
    write(root, '.git/HEAD', 'ref: refs/heads/main\n');
    write(root, 'node_modules/x/index.js', 'x');
    write(root, 'conf/settings.json', '{"token":"abcdefghijkl"}');
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(join(root, 'big.txt'), Buffer.alloc(MAX_CANDIDATE_BYTES + 1, 0x61));
    writeFileSync(join(base, 'outside.txt'), 'o');
    symlinkSync(join(base, 'outside.txt'), join(root, 'link.txt'));
    symlinkSync(join(root, 'src'), join(root, 'src-link'));
    const list = await listCandidates(root, { secretPaths: [join(root, 'conf', 'settings.json')], redact: id });
    expect(list.map((c) => c.path)).toEqual(['.env.example', 'README.md', 'src/a.py']);
    expect(list.find((c) => c.path === 'src/a.py')?.bytes).toBe(Buffer.byteLength('print(1)\n'));
    // nothing was created: no run dir, no profile, no tmp
    expect(readdirSync(base).sort()).toEqual(['outside.txt', 'ws']);
  });

  it('secret stores are matched canonically (through a symlinked store path) and relative to the root', async () => {
    const base = tmp();
    const root = join(base, 'ws');
    mkdirSync(join(root, 'conf'), { recursive: true });
    write(root, 'conf/real.json', '{}');
    write(root, 'a.txt', 'a');
    symlinkSync(join(root, 'conf', 'real.json'), join(base, 'store-link.json'));
    const viaLink = await listCandidates(root, { secretPaths: [join(base, 'store-link.json')], redact: id });
    expect(viaLink.map((c) => c.path)).toEqual(['a.txt']);
    const none = await listCandidates(root, { secretPaths: [], redact: id });
    expect(none.map((c) => c.path)).toEqual(['a.txt', 'conf/real.json']);
    // empty and non-string entries in secretPaths are ignored
    const loose = await listCandidates(root, { secretPaths: ['', 42 as unknown as string], redact: id });
    expect(loose.map((c) => c.path)).toEqual(['a.txt', 'conf/real.json']);
  });

  it('a path the redactor would alter is never offered; the others keep their exact text', async () => {
    const base = tmp();
    const root = join(base, 'ws');
    mkdirSync(root);
    write(root, 'notes-sk-ant-api03-abcdefghijklmnop.md', 'x');
    write(root, 'plain.md', 'x');
    write(root, 'wörld/ünïcode.txt', 'x');
    const list = await listCandidates(root, { secretPaths: [], redact: (s) => s.replace(/sk-ant-api03-[A-Za-z0-9]+/g, '[REDACTED]') });
    expect(list.map((c) => c.path)).toEqual(['plain.md', 'wörld/ünïcode.txt']);
  });

  it('`max` caps the walk and warns once; the default cap lists everything here', async () => {
    const base = tmp();
    const root = join(base, 'ws');
    mkdirSync(root);
    for (let i = 0; i < 30; i++) write(root, `f${String(i).padStart(2, '0')}.txt`, 'x');
    const warnings: string[] = [];
    const capped = await listCandidates(root, { secretPaths: [], redact: id, max: 5, warn: (m) => warnings.push(m) });
    expect(capped.length).toBeLessThanOrEqual(5);
    expect(capped.length).toBeGreaterThan(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('candidate listing stopped at 5 entries');
    const all = await listCandidates(root, { secretPaths: [], redact: id });
    expect(all.length).toBe(30);
    // a non-positive or non-finite max falls back to the default
    expect((await listCandidates(root, { secretPaths: [], redact: id, max: 0 })).length).toBe(30);
    expect((await listCandidates(root, { secretPaths: [], redact: id, max: Number.POSITIVE_INFINITY })).length).toBe(30);
  });

  it('a symlinked root resolves to its realpath; a missing root or a file is a ConfigError', async () => {
    const base = tmp();
    const root = join(base, 'ws');
    mkdirSync(root);
    write(root, 'a.txt', 'a');
    symlinkSync(root, join(base, 'ws-link'));
    expect((await listCandidates(join(base, 'ws-link'), { secretPaths: [], redact: id })).map((c) => c.path)).toEqual(['a.txt']);
    await expect(listCandidates(join(base, 'nope'), { secretPaths: [], redact: id })).rejects.toBeInstanceOf(ConfigError);
    await expect(listCandidates(join(root, 'a.txt'), { secretPaths: [], redact: id })).rejects.toBeInstanceOf(ConfigError);
  });

  it('an empty directory lists nothing; skipped directories (node_modules, dist, .git) never contribute', async () => {
    const base = tmp();
    const root = join(base, 'ws');
    mkdirSync(root);
    expect(await listCandidates(root, { secretPaths: [], redact: id })).toEqual([]);
    write(root, 'dist/out.js', 'x');
    write(root, '.git/objects/ab/cd', 'x');
    write(root, '__pycache__/a.pyc', 'x');
    expect(await listCandidates(root, { secretPaths: [], redact: id })).toEqual([]);
    // the frameworks' build and cache directories, and setuptools' <pkg>.egg-info, the same
    for (const d of ['.next', '.svelte-kit', '.turbo', 'coverage', '.gradle', '.dart_tool', '.terraform', 'DerivedData', 'mypkg.egg-info']) write(root, `${d}/x.js`, 'x');
    write(root, 'src/app.ts', 'x');
    expect((await listCandidates(root, { secretPaths: [], redact: id })).map((c) => c.path)).toEqual(['src/app.ts']);
  });
});
