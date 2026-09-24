import { describe, expect, it } from 'vitest';

import { isMentionDenied, isMentionDeniedBasename, isSecretBasename } from '../../../src/sandbox/paths.js';

const WS = '/ws';

describe('isMentionDeniedBasename (§10.4)', () => {
  it('extends isSecretBasename with credential, .npmrc, .pypirc and key-store extensions', () => {
    for (const name of ['.env', '.env.local', '.netrc', 'id_rsa', 'id_ed25519.pub', 'server.key', 'cert.pem', 'CERT.PEM']) {
      expect(isSecretBasename(name), name).toBe(true);
      expect(isMentionDeniedBasename(name), name).toBe(true);
    }
    for (const name of ['.npmrc', '.pypirc', 'credentials', 'aws-credentials.json', 'Credentials.txt', 'my_CREDENTIAL_store', 'site.p12', 'x.PFX', 'keystore.jks']) {
      expect(isMentionDeniedBasename(name), name).toBe(true);
    }
    for (const name of ['README.md', 'a.py', '.env.example', '.gitignore', 'package.json', 'key.ts', 'pemfile.txt', 'p12.txt', 'credible.md', 'npmrc']) {
      expect(isMentionDeniedBasename(name), name).toBe(false);
    }
  });
});

describe('isMentionDenied (§10.4, §5.4)', () => {
  it.each([
    ['src/a.py', false],
    ['README.md', false],
    ['./src/a.py', false],
    ['src/./a.py', false],
    ['src/../src/a.py', false],
    ['.github/workflows/ci.yml', false],
    ['.gitignore', false],
    ['.gitmodules', false],
    ['docs/git/guide.md', false],
    ['.env', true],
    ['config/.env.production', true],
    ['.env.example', false],
    ['config/.npmrc', true],
    ['.pypirc', true],
    ['aws/credentials', true],
    ['certs/site.p12', true],
    ['x.PFX', true],
    ['keystore.jks', true],
    ['id_rsa', true],
    ['keys/server.key', true],
    ['.git', true],
    ['.git/config', true],
    ['.git/HEAD', true],
    ['sub/.git/HEAD', true],
    ['.GIT/config', true],
    ['.Git/HEAD', true],
    ['sub/.GIT/objects/ab', true],
    ['.gitx/config', false],
    ['secrets/', false],
    ['', true],
    ['a\u0000b', true],
    ['../outside.txt', true],
    ['src/../../outside.txt', true],
    ['/etc/passwd', true],
    ['/ws/src/a.py', false],
    ['/ws/.env', true],
    ['src\\.env', true],
    ['src\\a.py', false],
    ['ファイル/日本語.md', false],
    ['🚀/launch.txt', false],
  ])('%j → denied=%s', (rel, denied) => {
    expect(isMentionDenied(WS, rel, [])).toBe(denied);
  });
  it('configured secret stores deny the file and everything under a directory store', () => {
    const stores = ['/ws/secrets', '/home/me/.config/jevcode/credentials.json'];
    expect(isMentionDenied(WS, 'secrets/x.txt', stores)).toBe(true);
    expect(isMentionDenied(WS, 'secrets', stores)).toBe(true);
    expect(isMentionDenied(WS, 'secretsandmore/x.txt', stores)).toBe(false);
    expect(isMentionDenied(WS, 'src/a.py', stores)).toBe(false);
    expect(isMentionDenied(WS, 'src/a.py', ['', 42 as unknown as string])).toBe(false);
    // a trailing slash names the same directory
    expect(isMentionDenied(WS, 'secrets/', stores)).toBe(true);
    expect(isMentionDenied(WS, './secrets/./', stores)).toBe(true);
  });
  it('a relative secret store is taken relative to the workspace, never to process.cwd()', () => {
    expect(isMentionDenied(WS, 'secrets/x.txt', ['secrets'])).toBe(true);
    expect(isMentionDenied(WS, 'secrets', ['secrets'])).toBe(true);
    expect(isMentionDenied(WS, 'src/a.py', ['secrets'])).toBe(false);
    expect(isMentionDenied(WS, 'other/x.txt', ['./other/'])).toBe(true);
    expect(isMentionDenied(WS, 'x.txt', ['../x.txt'])).toBe(false);
  });
  it('is lexical: a symlinked workspace path and a canonical store path must be given in the same form', () => {
    // same form on both sides matches
    expect(isMentionDenied('/tmp/link-ws', 'secrets/a', ['/tmp/link-ws/secrets'])).toBe(true);
    expect(isMentionDenied('/private/tmp/link-ws', 'secrets/a', ['/private/tmp/link-ws/secrets'])).toBe(true);
    // mixed forms do not (documented: files.ts passes both canonical)
    expect(isMentionDenied('/tmp/link-ws', 'secrets/a', ['/private/tmp/link-ws/secrets'])).toBe(false);
    // the basename and .git rules hold regardless of the workspace form
    expect(isMentionDenied('/tmp/link-ws', 'secrets/.env', ['/private/tmp/link-ws/secrets'])).toBe(true);
    expect(isMentionDenied('/tmp/link-ws/', '.GIT/config', [])).toBe(true);
  });
  it('agrees with isSecretBasename on every denied basename, is lexical (no disk) and fast on long listings', () => {
    for (const name of ['.env', '.netrc', 'id_dsa', 'a.pem', 'b.key']) expect(isMentionDenied(WS, `deep/er/${name}`, [])).toBe(true);
    const huge = `${'d/'.repeat(5000)}file.txt`;
    expect(isMentionDenied(WS, huge, [])).toBe(false);
    const t0 = performance.now();
    let denied = 0;
    for (let i = 0; i < 5000; i++) if (isMentionDenied(WS, i % 50 === 0 ? `src/mod${i % 97}/.env.${i}` : `src/mod${i % 97}/file-${i}.ts`, ['/ws/secrets'])) denied++;
    const ms = performance.now() - t0;
    expect(denied).toBe(100);
    expect(ms).toBeLessThan(200);
  });
});
