import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PathEscapeError, SecretPathError } from '../../../src/errors.js';
import { assertNotSecret, canonicalPath, isSecretBasename, isSecretPath, isWithin, resolveInside } from '../../../src/sandbox/paths.js';
import { makeTemp } from './helpers.js';

let base: { dir: string; cleanup: () => void };
let ws: string;
let outside: string;
let wsLink: string;

beforeAll(() => {
  base = makeTemp('jev-paths-');
  ws = join(base.dir, 'ws');
  outside = join(base.dir, 'outside');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(ws, 'src', 'a.py'), 'print(1)\n');
  writeFileSync(join(ws, '.git', 'config'), '[core]\n');
  writeFileSync(join(outside, 'secret.txt'), 'x\n');
  writeFileSync(join(ws, '.env'), 'KEY=1\n');
  symlinkSync(join(outside, 'secret.txt'), join(ws, 'link-file'));
  symlinkSync(outside, join(ws, 'link-dir'));
  symlinkSync(join(ws, 'src', 'a.py'), join(ws, 'link-inside'));
  symlinkSync(join(ws, 'src'), join(ws, 'link-inside-dir'));
  symlinkSync(join(ws, 'does-not-exist'), join(ws, 'dangling'));
  symlinkSync(join(outside, 'nope.txt'), join(ws, 'dangling-outside'));
  wsLink = join(base.dir, 'ws-link');
  symlinkSync(ws, wsLink);
});
afterAll(() => base.cleanup());

async function kindOf(p: string, mode: 'read' | 'write' = 'read'): Promise<string> {
  try {
    await resolveInside(ws, p, mode);
    return 'ok';
  } catch (e) {
    if (e instanceof PathEscapeError) return e.kind;
    throw e;
  }
}

describe('resolveInside', () => {
  it('table of escapes and allowed paths', async () => {
    expect(await kindOf('src/a.py')).toBe('ok');
    expect(await kindOf('./src/../src/a.py')).toBe('ok');
    expect(await kindOf('new/dir/file.txt', 'write')).toBe('ok');
    expect(await kindOf('../outside/secret.txt')).toBe('outside');
    expect(await kindOf('src/../../outside/secret.txt')).toBe('outside');
    expect(await kindOf('/etc/passwd')).toBe('absolute');
    expect(await kindOf(join(outside, 'secret.txt'))).toBe('absolute');
    expect(await kindOf(join(ws, 'src', 'a.py'))).toBe('ok');
    expect(await kindOf('link-file')).toBe('symlink');
    expect(await kindOf('link-dir/secret.txt')).toBe('symlink');
    expect(await kindOf('link-dir/new.txt', 'write')).toBe('symlink');
    expect(await kindOf('link-inside')).toBe('ok');
    expect(await kindOf('link-inside-dir/a.py')).toBe('ok');
    expect(await kindOf('dangling')).toBe('symlink');
    expect(await kindOf('dangling', 'write')).toBe('symlink');
    expect(await kindOf('dangling-outside', 'write')).toBe('symlink');
    expect(await kindOf('.git/config', 'write')).toBe('git');
    expect(await kindOf('.git/hooks/pre-commit', 'write')).toBe('git');
    expect(await kindOf('.git', 'write')).toBe('git');
    expect(await kindOf('.git/config', 'read')).toBe('ok');
    expect(await kindOf('.gitignore', 'write')).toBe('ok');
    expect(await kindOf('')).toBe('outside');
    expect(await kindOf('a\0b')).toBe('outside');
  });

  it('returns canonical paths and follows a symlinked workspace root', async () => {
    const viaLink = await resolveInside(wsLink, 'src/a.py', 'read');
    expect(viaLink).toBe(join(ws, 'src', 'a.py'));
    const inside = await resolveInside(ws, 'link-inside', 'read');
    expect(inside).toBe(join(ws, 'src', 'a.py'));
    expect(await resolveInside(ws, '.', 'read')).toBe(ws);
  });

  it('canonicalPath keeps the non-existent remainder and flags dangling links', async () => {
    expect((await canonicalPath(join(ws, 'x', 'y', 'z.txt'))).path).toBe(join(ws, 'x', 'y', 'z.txt'));
    expect((await canonicalPath(join(wsLink, 'x'))).path).toBe(join(ws, 'x'));
    expect((await canonicalPath(join(ws, 'dangling'))).dangling).toBe(true);
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
  });
});

describe('secret paths', () => {
  it('basename rule', () => {
    for (const n of ['.env', '.env.local', '.env.production', 'server.pem', 'private.key', 'id_rsa', 'id_ed25519.pub', '.netrc']) expect(isSecretBasename(n)).toBe(true);
    for (const n of ['.env.example', 'env', 'keyboard.ts', 'identity.py', 'README.md', 'a.env']) expect(isSecretBasename(n)).toBe(false);
  });

  it('configured absolute paths and workspace secrets throw SecretPathError', () => {
    const cfg = [join(base.dir, 'home', '.config', 'jevcode', 'config.json'), join(ws, 'conf', 'settings.json')];
    expect(isSecretPath(ws, 'conf/settings.json', cfg)).toBe(true);
    expect(isSecretPath(ws, cfg[0]!, cfg)).toBe(true);
    expect(isSecretPath(ws, 'conf/other.json', cfg)).toBe(false);
    expect(isSecretPath(ws, 'conf/settings.json/child', cfg)).toBe(true);
    expect(isSecretPath(ws, 'conf/settings.jsonx', cfg)).toBe(false);
    expect(isSecretPath(ws, './.env', [])).toBe(true);
    expect(isSecretPath(ws, 'deploy/.env.prod', [])).toBe(true);
    expect(() => assertNotSecret(ws, '.env', [])).toThrow(SecretPathError);
    expect(() => assertNotSecret(ws, 'src/a.py', [], join(ws, 'src', 'a.py'))).not.toThrow();
    expect(() => assertNotSecret(ws, 'alias', [], join(ws, 'id_rsa'))).toThrow(SecretPathError);
    let err: unknown;
    try {
      assertNotSecret(ws, '.env', []);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PathEscapeError);
    expect((err as PathEscapeError).kind).toBe('secret');
    expect((err as PathEscapeError).code).toBe('secret_path');
  });
});
