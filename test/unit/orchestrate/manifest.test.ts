/**
 * §3.7: build → write → read round trip, the checksum re-check, the size refusal, corner row 12's
 * idempotence, and a hostile-input sweep over the defensive parser.
 *
 * The parser cases below are the point of the file: every one of them is a file the harness might actually
 * find in a run dir — truncated, hand-edited, from another build, or written by an older version — and none
 * of them may throw or come back as a `Manifest`. The hostile case the checksum CANNOT answer has its own
 * test: an edited manifest whose checksum was simply recomputed, which only the recomputed `manifestId`
 * catches.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MANIFEST_BYTES } from '../../../src/core/limits.js';
import { checksumOf, manifestIdOf } from '../../../src/orchestrate/canonical.js';
import { isJsonObject, parseJson } from '../../../src/core/json.js';
import {
  buildManifest,
  dockBranchOf,
  manifestPath,
  nodeManifestIo,
  readManifest,
  sameDelegation,
  writeManifest,
  type BuildManifestInput,
  type ManifestIo,
} from '../../../src/orchestrate/manifest.js';
import type { Json } from '../../../src/core/types.js';
import type { AgentSpec, Manifest, NormalizedSplit } from '../../../src/orchestrate/types.js';

// ---------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------

const BASE_SHA = 'a'.repeat(40);

function agent(slug: string, over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    slug,
    task: `do the ${slug} work`,
    own: [`src/${slug}/**`],
    role: 'code',
    verify: ['npm test'],
    dependsOn: [],
    capUsd: 0.3,
    maxSteps: 12,
    maxWallMs: 900_000,
    mode: 'jev-on',
    branch: `jevcode/${slug}`,
    ...over,
  };
}

const SPLIT: NormalizedSplit = {
  kind: 'by_directory',
  agents: [agent('tui-rows'), agent('cli-args', { dependsOn: ['tui-rows'] })],
  manifestId: '',
  secretHits: 0,
  clampReason: null,
};

function input(over: Partial<BuildManifestInput> = {}): BuildManifestInput {
  return {
    split: SPLIT,
    verdict: 'chosen',
    probability: 0.8,
    confidence: 0.42,
    runId: 'run-0123456789abcdef',
    sessionId: 'run-0123456789abcdef',
    step: 7,
    task: 'make the tests pass',
    remaining: ['one', 'two'],
    baseSha: BASE_SHA,
    repoKey: 'repo-1',
    syncedDirty: [{ path: 'src/x.ts', sha256: 'b'.repeat(64), mode: 0o644 }],
    dirtyOverlap: ['src/x.ts'],
    reserveUsd: 0.9,
    reserveFrom: 'session',
    rejected: [{ kind: 'by_layer', reason: 'no workspace manifest', probability: null }],
    demand: 'disjoint_directories',
    redact: (s) => s.replace(/sk-[A-Za-z0-9]+/g, '[REDACTED:pattern]'),
    now: () => Date.UTC(2026, 8, 21, 12, 0, 0),
    ...over,
  };
}

/** The §2.2 id inputs the manifest does not store, as `input()` sets them. */
const CTX = { task: 'make the tests pass', remaining: ['one', 'two'] } as const;

/** `buildManifest` for the cases that expect it to succeed. */
function built(over: Partial<BuildManifestInput> = {}): Manifest {
  const b = buildManifest(input(over));
  if (!b.ok) throw new Error(`fixture did not build: ${b.reason}`);
  return b.manifest;
}

/** An in-memory `ManifestIo`, so the parser cases need no temp directory. */
function memoryIo(): ManifestIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async write(rel, text) {
      files.set(rel, text);
    },
    async read(rel) {
      return files.get(rel) ?? null;
    },
  };
}

/** A plain-json agent row, so a parser case can set a field to something `AgentSpec` forbids. */
function agentJson(over: Record<string, Json> = {}): Json {
  return { slug: 'x', task: 'do x', own: ['src/x/**'], role: 'code', verify: ['npm test'], dependsOn: [], capUsd: 0.3, maxSteps: 12, maxWallMs: 900_000, mode: 'jev-on', branch: 'jevcode/x', ...over };
}

/** Round-trip a built manifest through json, mutate one field, and write it back as the file's text. */
function tampered(mutate: (o: Record<string, Json>) => void): string {
  const parsed = parseJson(JSON.stringify(built()));
  if (!parsed.ok || !isJsonObject(parsed.value)) throw new Error('fixture is not an object');
  mutate(parsed.value);
  return JSON.stringify(parsed.value);
}

// ---------------------------------------------------------------------------------------

describe('§3.7 buildManifest', () => {
  it('fills createdAt from the injected clock, the dock branch from runId8, and redacts every task', () => {
    const m = built({ split: { ...SPLIT, agents: [agent('tui-rows', { task: 'use sk-ABC123456 to call it' }), agent('cli-args')] } });
    expect(m.createdAt).toBe('2026-09-21T12:00:00.000Z');
    expect(m.dockBranch).toBe('jevcode/dock-run-0123');
    expect(m.dockBranch).toBe(dockBranchOf('run-0123456789abcdef'));
    expect(m.agents[0]?.task).toBe('use [REDACTED:pattern] to call it');
    expect(m.v).toBe(1);
    expect(m.manifestId).toMatch(/^[0-9a-f]{64}$/);
    expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('clips an over-long task to AGENT_TASK_CHARS', () => {
    const m = built({ split: { ...SPLIT, agents: [agent('tui-rows', { task: 'T'.repeat(5_000) }), agent('cli-args')] } });
    expect(m.agents[0]?.task.length).toBe(2_000);
  });

  it('manifestPath is orchestrate/manifest-<step>.json and refuses a nonsense step', () => {
    expect(manifestPath(7)).toBe('orchestrate/manifest-7.json');
    expect(manifestPath(-1)).toBe('orchestrate/manifest-0.json');
    expect(manifestPath(Number.NaN)).toBe('orchestrate/manifest-0.json');
  });

  it('§2.2 dockBranchOf refuses a runId that would make a malformed or dangerous branch name', () => {
    expect(dockBranchOf('run-0123456789abcdef')).toBe('jevcode/dock-run-0123');
    expect(dockBranchOf('20260921-120000-ab2c4e6g')).toBe('jevcode/dock-20260921');
    // '' is the one that produced the bare `jevcode/dock-`; the rest are not a single ref path segment
    for (const bad of ['', 'a/b', 'a b', '../etc', '-lead', '.hidden', 'refs/heads/x', 'a'.repeat(201), 'a\u0000b']) {
      expect(dockBranchOf(bad)).toBeNull();
    }
  });

  it('refuses to build a manifest whose runId cannot name a dock branch, rather than naming one anyway', () => {
    for (const bad of ['', 'jev/../../etc', 'run 1']) {
      const b = buildManifest(input({ runId: bad }));
      expect(b.ok).toBe(false);
      if (b.ok) throw new Error(`built ${b.manifest.dockBranch}`);
      expect(b.reason).toContain('cannot name a dock branch');
    }
  });
});

describe('§3.7 write → read round trip', () => {
  it('writes atomically under the run dir and reads back an identical manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-manifest-'));
    try {
      const io = nodeManifestIo(dir);
      const m = built();
      const w = await writeManifest(io, m);
      expect(w).toMatchObject({ ok: true });
      expect(readFileSync(join(dir, manifestPath(7)), 'utf8')).toBe(JSON.stringify(m));
      const r = await readManifest(io, 7, CTX);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.reason);
      expect(r.manifest).toEqual(m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing file is a reason, not a throw', async () => {
    const io = memoryIo();
    const r = await readManifest(io, 7, CTX);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.reason).toContain('no manifest at orchestrate/manifest-7.json');
  });

  it('refuses a manifest over 32 KiB rather than truncating it', async () => {
    const io = memoryIo();
    const fat = Array.from({ length: 16 }, (_, i) => agent(`a-${i}`, { task: 'T'.repeat(2_500) }));
    const m = built({ split: { ...SPLIT, agents: fat } });
    const w = await writeManifest(io, m);
    expect(w.ok).toBe(false);
    if (w.ok) throw new Error('expected a refusal');
    expect(w.reason).toContain(`the limit is ${MANIFEST_BYTES}`);
    expect(io.files.size).toBe(0);
  });

  it('refuses to write a manifest whose checksum was mutated after buildManifest', async () => {
    const io = memoryIo();
    const m = { ...built(), reserveUsd: 99 };
    const w = await writeManifest(io, m);
    expect(w).toMatchObject({ ok: false });
    if (w.ok) throw new Error('expected a refusal');
    expect(w.reason).toContain('checksum does not match');
  });

  it('a write failure is a reason, not a throw', async () => {
    const io: ManifestIo = {
      async write() {
        throw new Error('ENOSPC: no space left on device');
      },
      async read() {
        return null;
      },
    };
    const w = await writeManifest(io, built());
    expect(w).toMatchObject({ ok: false });
    if (w.ok) throw new Error('expected a refusal');
    expect(w.reason).toContain('ENOSPC');
  });
});

describe('§3.7 the defensive parser', () => {
  it('refuses a file whose body was edited but whose checksum was left alone', async () => {
    const io = memoryIo();
    io.files.set(manifestPath(7), tampered((o) => {
      o['reserveUsd'] = 99;
    }));
    const r = await readManifest(io, 7, CTX);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.reason).toContain('fails its checksum');
  });

  const cases: readonly { name: string; text: string; reason: string }[] = [
    { name: 'not json at all', text: '{ this is not json', reason: 'is not json' },
    { name: 'a json array', text: '[]', reason: 'not a json object' },
    { name: 'json null', text: 'null', reason: 'not a json object' },
    { name: 'a future version', text: tampered((o) => { o['v'] = 2; }), reason: 'v is not 1' },
    { name: 'a truncated manifestId', text: tampered((o) => { o['manifestId'] = 'abc'; }), reason: 'manifestId is not a sha256' },
    { name: 'an empty runId', text: tampered((o) => { o['runId'] = ''; }), reason: 'runId is missing' },
    { name: 'a runId that is not branch-safe', text: tampered((o) => { o['runId'] = 'a/../b'; }), reason: 'is not branch-safe' },
    { name: 'a dock branch the runId does not derive', text: tampered((o) => { o['dockBranch'] = 'jevcode/dock-other'; }), reason: 'is not the one runId' },
    { name: 'a step that disagrees with the file name', text: tampered((o) => { o['step'] = 9; }), reason: 'does not match the file name' },
    { name: 'an unknown split kind', text: tampered((o) => { o['splitKind'] = 'by_vibes'; }), reason: 'splitKind is not a split kind' },
    { name: 'an unknown verdict', text: tampered((o) => { o['verdict'] = 'approved'; }), reason: 'verdict is not a choice verdict' },
    { name: 'a probability above 1', text: tampered((o) => { o['probability'] = 1.5; }), reason: 'probability is not a number in 0..1' },
    { name: 'a base sha that is not hex', text: tampered((o) => { o['baseSha'] = 'HEAD~1'; }), reason: 'baseSha is not a commit sha' },
    { name: 'a dock branch outside the jevcode namespace', text: tampered((o) => { o['dockBranch'] = 'dock'; }), reason: 'dockBranch is not' },
    { name: 'syncedDirty holding a non-object', text: tampered((o) => { o['syncedDirty'] = ['src/x.ts']; }), reason: 'syncedDirty[0] is not an object' },
    { name: 'syncedDirty with an impossible mode', text: tampered((o) => { o['syncedDirty'] = [{ path: 'a', sha256: 'b'.repeat(64), mode: 1_000_000 }]; }), reason: 'is not a file mode' },
    { name: 'dirtyOverlap holding a number', text: tampered((o) => { o['dirtyOverlap'] = [1]; }), reason: 'dirtyOverlap is not' },
    { name: 'agents that is not an array', text: tampered((o) => { o['agents'] = {}; }), reason: 'agents is not an array' },
    { name: 'an agent with an illegal slug', text: tampered((o) => { o['agents'] = [agentJson({ slug: '../../etc' })]; }), reason: 'slug is not a slug' },
    { name: 'an agent claiming the dock slug', text: tampered((o) => { o['agents'] = [agentJson({ slug: 'dock-1', branch: 'jevcode/dock-1' })]; }), reason: 'reserved for the dock' },
    { name: 'an agent owning nothing', text: tampered((o) => { o['agents'] = [agentJson({ own: [] })]; }), reason: 'own is not 1..' },
    { name: 'an agent owning 40 globs', text: tampered((o) => { o['agents'] = [agentJson({ own: Array.from({ length: 40 }, (_, i) => `src/a${i}/**`) })]; }), reason: 'own is not 1..' },
    { name: 'an agent owning a path outside the repo', text: tampered((o) => { o['agents'] = [agentJson({ own: ['../../etc'] })]; }), reason: 'is not allowed in an own glob' },
    { name: 'an agent owning an absolute path', text: tampered((o) => { o['agents'] = [agentJson({ own: ['/etc/passwd'] })]; }), reason: 'is absolute' },
    { name: 'an agent owning a glob the sub-language does not have', text: tampered((o) => { o['agents'] = [agentJson({ own: ['src/**/*.ts'] })]; }), reason: 'the own sub-language does not allow' },
    { name: 'an agent owning a bare directory name', text: tampered((o) => { o['agents'] = [agentJson({ own: ['src/tui'] })]; }), reason: 'names no file extension and no directory' },
    { name: 'an agent owning a negation', text: tampered((o) => { o['agents'] = [agentJson({ own: ['src/a/**', '!src/a/keys.ts'] })]; }), reason: 'is a negation' },
    { name: 'an agent with an unknown role', text: tampered((o) => { o['agents'] = [agentJson({ role: 'admin' })]; }), reason: 'role is not one of' },
    { name: 'a code agent with no verify', text: tampered((o) => { o['agents'] = [agentJson({ verify: [] })]; }), reason: 'no verify command' },
    { name: 'an agent depending on itself', text: tampered((o) => { o['agents'] = [agentJson({ dependsOn: ['x'] })]; }), reason: 'dependsOn is not a list of other slugs' },
    { name: 'an agent with a negative cap', text: tampered((o) => { o['agents'] = [agentJson({ capUsd: -1 })]; }), reason: 'capUsd is not a non-negative number' },
    { name: 'an agent with a fractional step cap', text: tampered((o) => { o['agents'] = [agentJson({ maxSteps: 2.5 })]; }), reason: 'maxSteps is not a non-negative integer' },
    { name: 'an agent with an unknown mode', text: tampered((o) => { o['agents'] = [agentJson({ mode: 'turbo' })]; }), reason: 'mode is not an engine mode' },
    { name: 'a branch that is not jevcode/<slug>', text: tampered((o) => { o['agents'] = [agentJson({ branch: 'jevcode/other' })]; }), reason: 'branch is not "jevcode/x"' },
    { name: 'a research agent with a branch', text: tampered((o) => { o['agents'] = [agentJson({ role: 'research', verify: [] })]; }), reason: 'must have no branch' },
    { name: 'two agents sharing a slug', text: tampered((o) => { o['agents'] = [agentJson(), agentJson()]; }), reason: 'share a slug' },
    { name: 'a negative reserve', text: tampered((o) => { o['reserveUsd'] = -0.5; }), reason: 'reserveUsd is not a non-negative number' },
    { name: 'a reserve from nowhere', text: tampered((o) => { o['reserveFrom'] = 'thin air'; }), reason: 'reserveFrom is not session or run' },
    { name: 'a rejected entry with a bad probability', text: tampered((o) => { o['rejected'] = [{ kind: 'by_layer', reason: 'x', probability: 7 }]; }), reason: 'is not a probability or null' },
    { name: 'an unknown demand', text: tampered((o) => { o['demand'] = 'boredom'; }), reason: 'demand is not a demand reason' },
    { name: 'a createdAt that is not a time', text: tampered((o) => { o['createdAt'] = 'yesterday'; }), reason: 'createdAt is not a timestamp' },
    { name: 'a checksum that is not a sha', text: tampered((o) => { o['checksum'] = 'nope'; }), reason: 'checksum is not a sha256' },
    { name: 'every field missing', text: '{}', reason: 'v is not 1' },
  ];

  it.each(cases)('refuses $name without throwing', async ({ text, reason }) => {
    const io = memoryIo();
    io.files.set(manifestPath(7), text);
    const r = await readManifest(io, 7, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected a refusal');
    expect(r.reason).toContain(reason);
  });

  it('a read that throws is a reason, not a throw', async () => {
    const io: ManifestIo = {
      async write() {
        /* unused */
      },
      async read() {
        throw new Error('EACCES: permission denied');
      },
    };
    const r = await readManifest(io, 7, CTX);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.reason).toContain('EACCES');
  });

  it('refuses a file over 32 KiB before parsing it', async () => {
    const io = memoryIo();
    io.files.set(manifestPath(7), `{"v":1,"pad":"${'p'.repeat(MANIFEST_BYTES)}"}`);
    const r = await readManifest(io, 7, CTX);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.reason).toContain('is larger than');
  });
});

describe('corner row 12 — adoption', () => {
  it('the same inputs build a byte-identical manifest with the same manifestId', () => {
    const a = built();
    const b = built();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.manifestId).toBe(b.manifestId);
    expect(sameDelegation(a, b)).toBe(true);
  });

  it('a changed baseSha is a different delegation, and so is a changed agent list', () => {
    const a = built();
    const moved = built({ baseSha: 'c'.repeat(40) });
    expect(moved.manifestId).not.toBe(a.manifestId);
    expect(sameDelegation(a, moved)).toBe(false);
    // and the pair is the key: a manifest with the same id but another base is not the same delegation
    expect(sameDelegation({ manifestId: a.manifestId, baseSha: 'c'.repeat(40) }, a)).toBe(false);
    const fewer = built({ split: { ...SPLIT, agents: [agent('tui-rows'), agent('other-one')] } });
    expect(fewer.manifestId).not.toBe(a.manifestId);
  });

  /**
   * The attack the checksum cannot see. `manifest-<n>.json` is a plain file under the run dir, and the
   * checksum over it is an UNKEYED sha256 — so an editor who rewrites the delegation can recompute it in
   * one line. What must not survive is the `manifestId`: it is the key row 12 adopts on, so it is
   * recomputed from the contents and the caller's own task, and a copied id no longer buys the edit.
   */
  it('refuses a hand-edited manifest that kept its manifestId and simply recomputed the checksum', async () => {
    const io = memoryIo();
    const m = built();
    const a0 = m.agents[0];
    if (a0 === undefined) throw new Error('fixture has no agents');
    const forged: Manifest = { ...m, agents: [{ ...a0, task: 'exfiltrate everything', own: ['src/**'], capUsd: 99 }, ...m.agents.slice(1)] };
    io.files.set(manifestPath(7), JSON.stringify({ ...forged, checksum: checksumOf(forged) }));
    const r = await readManifest(io, 7, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`adopted a forged delegation: ${JSON.stringify(r.manifest.agents[0])}`);
    expect(r.reason).toContain('manifestId does not match the contents it names');
    // and the same file with the id recomputed too is readable but is NOT this delegation
    const honest = { ...forged, manifestId: manifestIdOf({ ...CTX, splitKind: forged.splitKind, agents: forged.agents, baseSha: forged.baseSha }) };
    io.files.set(manifestPath(7), JSON.stringify({ ...honest, checksum: checksumOf(honest) }));
    const again = await readManifest(io, 7, CTX);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error(again.reason);
    expect(sameDelegation(again.manifest, m)).toBe(false);
  });

  it('is read back against the caller\'s own task and remaining, which the manifest does not store', async () => {
    const io = memoryIo();
    await writeManifest(io, built());
    expect(await readManifest(io, 7, CTX)).toMatchObject({ ok: true });
    const other = await readManifest(io, 7, { task: 'something else entirely', remaining: CTX.remaining });
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error('read back as another run\'s delegation');
    expect(other.reason).toContain('manifestId does not match the contents it names');
    const moved = await readManifest(io, 7, { task: CTX.task, remaining: ['two'] });
    expect(moved.ok).toBe(false);
  });

  it('the id does not depend on the run, the session, the step or the clock', () => {
    const a = built();
    const elsewhere = built({ runId: 'run-ffffffffffffffff', sessionId: 'run-ffffffffffffffff', step: 40, now: () => 0 });
    expect(elsewhere.manifestId).toBe(a.manifestId);
    expect(sameDelegation(a, elsewhere)).toBe(true);
  });
});
