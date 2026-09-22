import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVICE_ID_RE,
  DEVICE_KEY_FILE,
  LANE_DIR_RE,
  LEASE_ID_RE,
  MSG_ID_RE,
  REPO_KEY_RE,
  SLUG_RE,
  actor8Of,
  adoptNewDevice,
  createStampClock,
  deviceIdentity,
  ignoreDevice,
  isValidBranch,
  isValidRelPath,
  isValidTarget,
  labelFor,
  mintActor8,
  mintCommonsKey,
  mintDeviceId,
  normaliseOriginUrl,
  probeCaseInsensitive,
  readCommonsKey,
  readIgnoredDevices,
  readRepoKeyCache,
  readTrustKeys,
  readTrusted,
  repoKeyOf,
  sameRepo,
  trustDevice,
  writeCommonsKey,
  writeRepoKeyCache,
  writeTrusted,
  wsKeyOf,
  TRUSTED_FILE,
} from '../../../src/coordination/ids.js';
import { COMMONS_KEY_RE, hmacOf, hmacValid } from '../../../src/coordination/claims.js';
import { commonsPaths } from '../../../src/coordination/paths.js';
import { compareStamp } from '../../../src/coordination/records.js';
import { nodeFs } from '../../../src/coordination/fs.js';
import { DEV_A, DEV_B, REPO, WS, iso, runId, T0, tempHome } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // LIFO: a ledger must close (draining its write chain) before its temp dir is removed
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('validators (§3.1)', () => {
  it('device / repo / msg / lease / slug ids by regex', () => {
    expect(DEVICE_ID_RE.test(DEV_A)).toBe(true);
    expect(DEVICE_ID_RE.test('K3Q7M2AB')).toBe(false);
    expect(DEVICE_ID_RE.test('k3q7m2a')).toBe(false);
    for (const k of [REPO, `ws:${REPO}`, `rm:${REPO}`]) expect(REPO_KEY_RE.test(k)).toBe(true);
    expect(REPO_KEY_RE.test('xx:9c3a7ac066816f2b')).toBe(false);
    expect(REPO_KEY_RE.test('9c3a7ac066816f2')).toBe(false);
    expect(MSG_ID_RE.test(`${DEV_A}-abcdefgh-12`)).toBe(true);
    expect(MSG_ID_RE.test(`${DEV_A}-abcdefgh-1234567890`)).toBe(false);
    expect(LEASE_ID_RE.test(`${runId(1)}-7`)).toBe(true);
    expect(LEASE_ID_RE.test(`${runId(1)}`)).toBe(false);
    expect(SLUG_RE.test('fix-tests')).toBe(true);
    expect(SLUG_RE.test('-bad')).toBe(false);
    expect(SLUG_RE.test('a'.repeat(41))).toBe(false);
  });

  it('targets: <sessionId> | @<repoKey> | @all', () => {
    expect(isValidTarget(runId(3))).toBe(true);
    expect(isValidTarget(`@${REPO}`)).toBe(true);
    expect(isValidTarget('@all')).toBe(true);
    expect(isValidTarget('@main')).toBe(false);
    expect(isValidTarget('../x')).toBe(false);
  });

  it('§11 row 26: relative NFC paths only — traversal, absolute, drive letters, controls and NFD are refused', () => {
    expect(isValidRelPath('src/x.ts')).toBe(true);
    expect(isValidRelPath('src/tui/')).toBe(true);
    expect(isValidRelPath('café.ts'.normalize('NFC'))).toBe(true);
    for (const bad of ['', '/etc/passwd', 'C:\\x', '..', 'a/../b', './a', 'a//b', 'a\u0000b', 'café.ts'.normalize('NFD'), 'x'.repeat(513)]) expect(isValidRelPath(bad)).toBe(false);
  });
});

describe('minting and keys (§3.2)', () => {
  it('mints 8 base32 chars; actor8 is the run tail or a minted id', () => {
    expect(mintDeviceId()).toMatch(DEVICE_ID_RE);
    expect(mintActor8(() => new Uint8Array([0, 0, 0, 0, 0]))).toBe('aaaaaaaa');
    expect(actor8Of(runId(5))).toBe(runId(5).slice(-8));
    expect(actor8Of(null)).toMatch(/^[a-z2-7]{8}$/);
  });

  it('wsKey is ws: + sha16 of the realpath', () => {
    expect(wsKeyOf('/Users/p/proj')).toMatch(/^ws:[0-9a-f]{16}$/);
    expect(wsKeyOf('/Users/p/proj')).toBe(wsKeyOf('/Users/p/proj'));
    expect(wsKeyOf('/Users/p/proj')).not.toBe(wsKeyOf('/Users/p/proj2'));
  });

  it('§11 row 40: root commits give the key; a shallow clone falls back to the origin URL; unborn + no origin has none', () => {
    const roots = ['b'.repeat(40), 'a'.repeat(40)];
    const full = repoKeyOf({ rootOids: roots, shallow: false, originUrl: 'git@github.com:acme/JevCode.git' });
    expect(full.kind).toBe('roots');
    expect(full.repoKey).toMatch(/^[0-9a-f]{16}$/);
    expect(full.remoteKey).toMatch(/^rm:[0-9a-f]{16}$/);
    // order-independent
    expect(repoKeyOf({ rootOids: [...roots].reverse(), shallow: false, originUrl: null }).repoKey).toBe(full.repoKey);
    const shallow = repoKeyOf({ rootOids: ['c'.repeat(40)], shallow: true, originUrl: 'https://github.com/acme/JevCode' });
    expect(shallow.kind).toBe('remote');
    expect(shallow.repoKey).toBeNull();
    expect(shallow.remoteKey).toBe(full.remoteKey); // both clones of one repo meet on the remote key
    expect(repoKeyOf({ rootOids: [], shallow: false, originUrl: null })).toEqual({ repoKey: null, remoteKey: null, kind: 'none' });
  });

  it('origin URLs normalise across scp / ssh / https forms, credentials, .git and case', () => {
    const forms = ['git@github.com:acme/JevCode.git', 'ssh://git@github.com/acme/JevCode.git', 'https://GitHub.com/acme/JevCode', 'https://user:tok@github.com/acme/JevCode.git/', 'https://github.com:443/acme/JevCode'];
    const norm = forms.map(normaliseOriginUrl);
    expect(new Set(norm).size).toBe(1);
    expect(norm[0]).toBe('github.com/acme/JevCode');
  });

  it('§11 rows 8 / 24 / 35: two clones / worktrees of one repo match on either key; a non-git tree only by wsKey', () => {
    const a = { repoKey: REPO, remoteKey: null, wsKey: WS };
    const b = { repoKey: REPO, remoteKey: 'rm:0000000000000000', wsKey: 'ws:1111111111111111' };
    expect(sameRepo(a, b)).toBe(true);
    expect(sameRepo({ repoKey: null, remoteKey: 'rm:0000000000000000', wsKey: 'ws:2222222222222222' }, b)).toBe(true);
    expect(sameRepo({ repoKey: null, remoteKey: null, wsKey: WS }, a)).toBe(true);
    expect(sameRepo({ repoKey: null, remoteKey: null, wsKey: 'ws:3333333333333333' }, a)).toBe(false);
    expect(sameRepo({ repoKey: 'ffffffffffffffff', remoteKey: null, wsKey: WS }, a)).toBe(false);
  });

  it('repoKey cache: written under coordination/repokeys/, validated by regex on read, malformed → null', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    expect(await readRepoKeyCache(nodeFs, t.root, '/ws')).toBeNull();
    await writeRepoKeyCache(nodeFs, t.root, '/ws', { repoKey: REPO, remoteKey: null, kind: 'roots', commonDir60: '/ws/.git', at: iso(T0) });
    expect(await readRepoKeyCache(nodeFs, t.root, '/ws')).toMatchObject({ v: 1, repoKey: REPO, kind: 'roots' });
    await nodeFs.writeAtomic(join(t.root, 'repokeys', `${(await import('../../../src/core/hash.js')).sha256Hex('/ws').slice(0, 16)}.json`), '{"v":1,"repoKey":"../../etc","kind":"roots","commonDir60":"x","at":"t"}\n', { fsync: false, mode: 0o600 });
    expect(await readRepoKeyCache(nodeFs, t.root, '/ws')).toBeNull();
  });
});

describe('labels and stamps', () => {
  it('§11 row 42: two devices with one label render as label#id4', () => {
    const devices = [
      { deviceId: DEV_A, label: 'MacBook-Pro.local' },
      { deviceId: DEV_B, label: 'MacBook-Pro.local' },
    ];
    expect(labelFor(DEV_A, 'MacBook-Pro.local', devices)).toBe(`MacBook-Pro.local#${DEV_A.slice(0, 4)}`);
    expect(labelFor(DEV_A, 'mbp', devices)).toBe('mbp');
  });

  it('W0: two processes on one device holding the same n are ordered by runId; the order is total', () => {
    const a = { n: 4, deviceId: DEV_A, runId: runId(1) };
    const b = { n: 4, deviceId: DEV_A, runId: runId(2) };
    expect(compareStamp(a, b)).toBe(runId(1) < runId(2) ? -1 : 1);
    expect(compareStamp(b, a)).toBe(-compareStamp(a, b));
    expect(compareStamp(a, { ...a })).toBe(0);
    expect(compareStamp({ n: 3, deviceId: DEV_B, runId: runId(9) }, a)).toBe(-1);
    expect(compareStamp({ n: 4, deviceId: 'aaaaaaaa', runId: runId(9) }, a)).toBe(-1);
  });

  it('the clock issues strictly above everything observed; a crash cannot re-issue a lower stamp', () => {
    const c = createStampClock(DEV_A, runId(1), 41);
    expect(c.issue().n).toBe(42);
    c.observe({ n: 100, deviceId: DEV_B, runId: runId(3) });
    expect(c.issue()).toEqual({ n: 101, deviceId: DEV_A, runId: runId(1) });
    c.observe(50); // lower: no effect
    expect(c.current().n).toBe(101);
    const fresh = createStampClock(DEV_A, runId(4), 101); // a new run seeds from the fold's max
    expect(fresh.issue().n).toBe(102);
  });
});

describe('case sensitivity probe (§11 row 23)', () => {
  it('a case-swapped .git that stats means the volume folds case; an external case-sensitive disk does not', () => {
    const insensitive = new Set(['/ws/.git', '/ws/.GIT']);
    expect(probeCaseInsensitive('/ws', (p) => insensitive.has(p))).toBe(true);
    const sensitive = new Set(['/ws/.git']);
    expect(probeCaseInsensitive('/ws', (p) => sensitive.has(p))).toBe(false);
    // no .git: the root's own last component is swapped
    expect(probeCaseInsensitive('/Users/p/Proj', (p) => p === '/Users/p/pROJ')).toBe(true);
    expect(probeCaseInsensitive('/Users/p/proj', () => false)).toBe(false);
  });
});

describe('device identity (§3.2, §11 row 27)', () => {
  const base = { hostname: 'mbp.local', username: 'p', jevcode: '0.3.0', nowIso: iso(T0) };

  it('creates once, then loads; both device.json files are written and checksummed', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const created = await deviceIdentity({ root: t.root, fs: nodeFs, ...base });
    expect(created.status).toBe('created');
    expect(created.device.deviceId).toMatch(DEVICE_ID_RE);
    expect(created.device.label).toBe('mbp.local');
    const loaded = await deviceIdentity({ root: t.root, fs: nodeFs, ...base });
    expect(loaded.status).toBe('loaded');
    expect(loaded.device.deviceId).toBe(created.device.deviceId);
    const copy = await nodeFs.readBounded(join(t.root, 'registry', created.device.deviceId, 'device.json'), 4096);
    expect(JSON.parse(copy.text)).toEqual(created.device);
  });

  it('re-adopts a registry subtree whose device.json names this host + user (a restored ~/.jevcode)', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const first = await deviceIdentity({ root: t.root, fs: nodeFs, ...base });
    await nodeFs.unlink(join(t.root, 'device.json'));
    const again = await deviceIdentity({ root: t.root, fs: nodeFs, ...base });
    expect(again.status).toBe('readopted');
    expect(again.device.deviceId).toBe(first.device.deviceId);
  });

  it('a wholesale copy to another Mac is foreign; adoptNewDevice mints a new id and leaves the old subtree', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const first = await deviceIdentity({ root: t.root, fs: nodeFs, ...base });
    const onNewMac = { ...base, hostname: 'studio.local' };
    const foreign = await deviceIdentity({ root: t.root, fs: nodeFs, ...onNewMac });
    expect(foreign.status).toBe('foreign');
    expect(foreign.device.host).toBe('mbp.local');
    const adopted = await adoptNewDevice({ root: t.root, fs: nodeFs, ...onNewMac });
    expect(adopted.status).toBe('created');
    expect(adopted.device.deviceId).not.toBe(first.device.deviceId);
    expect(adopted.device.host).toBe('studio.local');
    const dirs = await nodeFs.readdir(join(t.root, 'registry'));
    expect(dirs.sort()).toEqual([first.device.deviceId, adopted.device.deviceId].sort());
    expect((await deviceIdentity({ root: t.root, fs: nodeFs, ...onNewMac })).status).toBe('loaded');
  });

  it('a malformed device.json is treated as missing', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    await nodeFs.mkdir(t.root, 0o700);
    await nodeFs.writeAtomic(join(t.root, 'device.json'), '{"v":1,"deviceId":"nope"}\n', { fsync: false, mode: 0o600 });
    expect((await deviceIdentity({ root: t.root, fs: nodeFs, ...base })).status).toBe('created');
  });
});

describe('validators added for the review findings', () => {
  it('review #36: a branch name git would read as an option is refused; #37 bounds a laneDir', () => {
    for (const ok of ['main', 'feature/x', 'jevcode/fix-tests', 'a-b_c.d']) expect(isValidBranch(ok), ok).toBe(true);
    for (const bad of ['', '-x', '/x', 'x/', 'a..b', 'a@{1}', 'a//b', 'x.lock', 'x.', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '@', 'x'.repeat(201)]) expect(isValidBranch(bad), bad).toBe(false);
    expect(LANE_DIR_RE.test('tmp/synth/lane0')).toBe(true);
    expect(LANE_DIR_RE.test('tmp/synth/lane123')).toBe(true);
    for (const bad of ['tmp/synth/lane1234', 'tmp/synth/lane', '../tmp/synth/lane1', 'tmp/synth/lane1/x']) expect(LANE_DIR_RE.test(bad), bad).toBe(false);
  });
});

describe('the identity files (§3.1 / §10.3, review #42)', () => {
  it('they sit under coordination/ with the names the review asked for — never ~/.jevcode/trust.json', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const p = commonsPaths(t.root);
    expect(p.deviceFile).toBe(join(t.root, 'device.json'));
    expect(p.deviceKeyFile).toBe(join(t.root, DEVICE_KEY_FILE));
    expect(p.trustedFile).toBe(join(t.root, TRUSTED_FILE));
    expect(TRUSTED_FILE).toBe('trusted-devices.json');
    expect(p.ignoredFile).toBe(join(t.root, 'ignored-devices.json'));
    expect(p.repokeysDir).toBe(join(t.root, 'repokeys'));
    // the dedupe set moved under the inbox kind, where no deviceId regex can match it
    expect(p.seenDir).toBe(join(t.root, 'inbox', 'seen'));
    expect(DEVICE_ID_RE.test('seen')).toBe(false);
    for (const k of ['registry', 'leases', 'inbox', 'acks', 'runs'] as const) expect(p.deviceDir(k, DEV_A)).toBe(join(t.root, k, DEV_A));
  });

  it('§10.3: the commons key lives in its own 0600 file, so both device.json copies stay the PUBLIC subset', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const base = { hostname: 'mbp.local', username: 'p', jevcode: '0.3.0', nowIso: iso(T0) };
    const created = await deviceIdentity({ root: t.root, fs: nodeFs, ...base });
    const key = mintCommonsKey();
    expect(key).toMatch(COMMONS_KEY_RE);
    await writeCommonsKey(nodeFs, t.root, key);
    expect(await readCommonsKey(nodeFs, t.root)).toBe(key);
    for (const file of [join(t.root, 'device.json'), join(t.root, 'registry', created.device.deviceId, 'device.json')]) {
      const text = (await nodeFs.readBounded(file, 4096)).text;
      expect(text).not.toContain(key);
      expect(text).not.toContain('keyHex');
    }
    await expect(writeCommonsKey(nodeFs, t.root, 'nope')).rejects.toThrow(/64 hex/);
    expect(await readCommonsKey(nodeFs, join(t.root, 'missing'))).toBeNull();
  });

  it('a paired device\u2019s key verifies its records and nothing else does', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const key = mintCommonsKey();
    await trustDevice(nodeFs, t.root, { deviceId: DEV_B, label: 'studio', pairedAt: iso(T0), keyHex: key });
    const keys = await readTrustKeys(nodeFs, t.root);
    expect(keys.get(DEV_B)).toBe(key);
    const record = { v: 1 as const, kind: 'ack' as const, msgId: 'x' };
    const signed = { ...record, hmac: hmacOf(record, key, DEV_B) };
    expect(hmacValid(signed, keys.get(DEV_B), DEV_B)).toBe(true);
    expect(hmacValid(signed, mintCommonsKey(), DEV_B)).toBe(false);
    expect(hmacValid(signed, keys.get(DEV_A), DEV_A)).toBe(false);
    // + re-review (5): one GROUP key, two devices — DEV_A may not replay DEV_B's bytes as its own
    expect(hmacValid(signed, key, DEV_A)).toBe(false);
    // a malformed key in the file is simply not a key
    await writeTrusted(nodeFs, t.root, [{ deviceId: DEV_B, label: 'studio', pairedAt: iso(T0), keyHex: 'nope' }]);
    expect((await readTrustKeys(nodeFs, t.root)).size).toBe(0);
  });
});

describe('trusted / ignored device lists (§10.3, §4.6 row 4)', () => {
  it('round-trips, dedupes by id and skips malformed entries', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    expect(await readTrusted(nodeFs, t.root)).toEqual([]);
    await writeTrusted(nodeFs, t.root, [{ deviceId: DEV_B, label: 'studio', pairedAt: iso(T0) }]);
    expect(await readTrusted(nodeFs, t.root)).toEqual([{ deviceId: DEV_B, label: 'studio', pairedAt: iso(T0) }]);
    await ignoreDevice(nodeFs, t.root, { deviceId: DEV_B, label: 'old', at: iso(T0) });
    await ignoreDevice(nodeFs, t.root, { deviceId: DEV_B, label: 'old-mac', at: iso(T0 + 1) });
    expect(await readIgnoredDevices(nodeFs, t.root)).toEqual([{ deviceId: DEV_B, label: 'old-mac', at: iso(T0 + 1) }]);
    await nodeFs.writeAtomic(join(t.root, 'ignored-devices.json'), '{"v":1,"devices":[{"deviceId":"../x","label":"a","at":"t"},{"deviceId":"k3q7m2ab"}]}\n', { fsync: false, mode: 0o600 });
    expect(await readIgnoredDevices(nodeFs, t.root)).toEqual([]);
  });
});
