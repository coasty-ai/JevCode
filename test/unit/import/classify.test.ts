/**
 * src/import/classify.ts (IMPORT-DESIGN §4.4.1 the 12 file rules, §4.4.2 the 9 key rules,
 * §6 group D rows 28, 29, 45, 47, 51, 53, 54).
 *
 * The rules are asserted **in order** — first match wins — each on its own fixture, plus a
 * precedence chain that removes one trigger at a time and watches the rule number climb, plus
 * totality (every input leaves with exactly one verdict) and the band being exactly rows 11–12.
 */
import { describe, expect, it } from 'vitest';
import { BAND_RULES, FILE_BAND, NON_SECRET_LEAF_NAMES, classifyConfig, classifyFile, classifyKey, formatOf, walkLeaves } from '../../../src/import/classify.js';
import type { FileInput } from '../../../src/import/classify.js';
import type { ConfigLeaf, Frontmatter, FrontmatterValue, MarkdownDoc, SourceItem, SourceSpec } from '../../../src/import/types.js';

// ---------------------------------------------------------------------------------------
// builders — every fact the classifier reads arrives as data
// ---------------------------------------------------------------------------------------

function item(realpath: string, over: Partial<SourceItem> = {}): SourceItem {
  const base: SourceItem = {
    id: 'aaaaaaaaaaaa',
    realpath,
    display: realpath,
    tools: ['claude-code'],
    artefact: 'fixture',
    format: formatOf(realpath),
    scope: 'user',
    bytes: 800,
    sha256: 'a'.repeat(64),
    mtime: '2026-09-21T12:00:00.000Z',
    parse: { ok: true },
    notices: [],
  };
  return { ...base, ...over };
}

function fm(values: Record<string, FrontmatterValue>): Frontmatter {
  return { keys: Object.keys(values), values, bodyOffset: 0, broken: false };
}

function doc(text: string, over: Partial<MarkdownDoc> = {}): MarkdownDoc {
  const base: MarkdownDoc = {
    text,
    controlsRemoved: 0,
    frontmatter: null,
    headings: [],
    lines: text.split('\n').length,
    fences: 0,
    executables: [],
    refs: [],
    tokens: text.toLowerCase().split(/\s+/).filter((t) => t.length > 0),
    normalisedSha256: 'b'.repeat(64),
    bands: [],
  };
  return { ...base, ...over };
}

const spec: SourceSpec = {
  id: 'claude.auto-memory.topic',
  tool: 'claude-code',
  artefact: 'topic file',
  roots: [],
  pattern: 'memory/*.md',
  format: 'md',
  class: 'memory',
  scope: 'user',
  destination: { kind: 'memory-topic', scope: 'user' },
};

function leaf(dotted: string, value: ConfigLeaf['value']): ConfigLeaf {
  return { path: dotted.split('.'), dotted, value };
}

// ---------------------------------------------------------------------------------------
// §4.4.1 — the 12 rules, each on its own fixture
// ---------------------------------------------------------------------------------------

describe('§4.4.1 the 12 file rules, in order', () => {
  it('rule 1 — a realpath that is one of our destinations is skip:self (§6 row 9)', () => {
    const v = classifyFile({ item: item('/ws/.jevcode/memory/project-notes.md'), isDestination: true });
    expect(v).toMatchObject({ rule: 1, skip: 'skip:self' });
    expect(v.why).toBe('rule 1 (realpath is a destination)');
  });

  it('rule 1 — a bundled artefact is skip:third-party (§6 row 54)', () => {
    expect(classifyFile({ item: item('/h/.codex/skills/.system/review-agent/SKILL.md') })).toMatchObject({ rule: 1, skip: 'skip:third-party' });
    expect(classifyFile({ item: item('/h/.codex/skills/mine/SKILL.md'), doc: doc('# mine\n\nnotes'), frontmatter: null }).skip).not.toBe('skip:third-party');
  });

  it('rule 1 — a tool-managed file is skip:tool-managed', () => {
    expect(classifyFile({ item: item('/h/.claude/statsig/cache.md') })).toMatchObject({ rule: 1, skip: 'skip:tool-managed' });
  });

  it('rule 2 — a secret basename is named, never read', () => {
    for (const p of ['/ws/.env', '/h/.ssh/id_rsa', '/h/keys/server.pem', '/h/x/api.key']) {
      const v = classifyFile({ item: item(p) });
      expect(v, p).toMatchObject({ rule: 2, skip: 'skip:secret', class: 'secret', p: 1 });
    }
    expect(classifyFile({ item: item('/ws/.env.example') }).rule).not.toBe(2);
  });

  it('rule 3 — oversize (§6 row 29)', () => {
    const v = classifyFile({ item: item('/h/.claude/CLAUDE.md', { bytes: 4_299_161 }) });
    expect(v).toMatchObject({ rule: 3, skip: 'skip:oversize' });
    expect(v.why).toBe('rule 3 (4,299,161 bytes; larger than 4 MiB)');
  });

  it('rule 4 — a NUL in the first 8 KiB, or a decode failure, is skip:not-text (§6 rows 24–25)', () => {
    expect(classifyFile({ item: item('/ws/notes.md'), doc: doc('PNG\u0000\u0000ihdr') })).toMatchObject({ rule: 4, skip: 'skip:not-text' });
    expect(classifyFile({ item: item('/ws/notes.md', { parse: { ok: false, error: 'not valid UTF-8' } }) })).toMatchObject({ rule: 4, skip: 'skip:not-text' });
  });

  it('rule 5 — js, sh and sqlite have no parser (§6 rows 27, 53)', () => {
    expect(classifyFile({ item: item('/h/.claude/workflows/deploy.js') })).toMatchObject({ rule: 5, skip: 'skip:unsupported', class: 'command', why: 'rule 5 (format js)' });
    expect(classifyFile({ item: item('/h/.opencode/state_5.sqlite') })).toMatchObject({ rule: 5, skip: 'skip:unsupported' });
    expect(classifyFile({ item: item('/h/.claude/hook.sh') })).toMatchObject({ rule: 5, skip: 'skip:unsupported' });
  });

  it('rule 6 — the atlas row declares a class and the parse succeeded', () => {
    const v = classifyFile({ item: item('/h/.claude/memory/a.md'), spec });
    expect(v).toMatchObject({ rule: 6, class: 'memory', skip: null, p: 1, band: false });
    expect(v.why).toBe('rule 6 (atlas claude.auto-memory.topic)');
  });

  it('rule 6 — the atlas row declares a class and the parse FAILED ⇒ skip:parse-error (§6 row 28)', () => {
    const v = classifyFile({ item: item('/h/.claude/memory/a.md', { parse: { ok: false, error: 'unterminated frontmatter' } }), spec });
    expect(v).toMatchObject({ rule: 6, skip: 'skip:parse-error', class: 'memory' });
    expect(v.why).toContain('unterminated frontmatter');
  });

  it('rule 2 — a transcript and a secret atlas class become their named skips', () => {
    // hoisted from rule 6 to rule 2 when the always-skip classes moved above oversize/not-text/
    // unsupported (ratified 2026-09-22): a file we never read cannot have its verdict changed by
    // its size, its encoding or whether a parser claims its format.
    expect(classifyFile({ item: item('/h/.claude/projects/x/s.jsonl'), spec: { ...spec, id: 'claude.transcripts', class: 'transcript' } })).toMatchObject({ rule: 2, skip: 'skip:transcript', class: 'transcript' });
    expect(classifyFile({ item: item('/h/.codex/auth.json'), spec: { ...spec, id: 'codex.auth', class: 'secret' } })).toMatchObject({ rule: 2, skip: 'skip:secret', class: 'secret' });
    // …and a secret *basename* reaches the same verdict one rule earlier, without the atlas row
    expect(classifyFile({ item: item('/h/.claude/sessions/a.key'), spec: { ...spec, id: 'claude.session-key', class: 'secret' } })).toMatchObject({ rule: 2, skip: 'skip:secret', class: 'secret' });
  });

  it('rule 7 — a path-scoped rule, p = 0.95', () => {
    for (const key of ['paths', 'globs', 'applyTo', 'trigger', 'alwaysApply']) {
      const v = classifyFile({ item: item('/ws/.cursor/rules/style.mdc'), frontmatter: fm({ [key]: 'src/**' }), doc: doc('# style') });
      expect(v, key).toMatchObject({ rule: 7, class: 'rule', skip: null, p: 0.95, band: false });
    }
  });

  it('rule 8 — a workflow, by frontmatter key or by $ARGUMENTS/$1 in the body', () => {
    expect(classifyFile({ item: item('/h/.claude/commands/ft.md'), frontmatter: fm({ 'argument-hint': '<test path>' }), doc: doc('run it') })).toMatchObject({ rule: 8, class: 'command', p: 0.9 });
    const byBody = classifyFile({ item: item('/h/.claude/commands/ft.md'), frontmatter: fm({ description: 'run a test' }), doc: doc('Run $1 and explain the first failure.') });
    expect(byBody).toMatchObject({ rule: 8, class: 'command' });
    expect(byBody.why).toBe('rule 8 (body contains $ARGUMENTS or $1)');
  });

  it('rule 9 — a learned note, flat `type:` or nested `metadata.type:` (§6 row 23)', () => {
    const flat = classifyFile({ item: item('/h/.claude/memory/a.md'), frontmatter: fm({ name: 'a', description: 'b', type: 'project' }), doc: doc('# a') });
    expect(flat).toMatchObject({ rule: 9, class: 'memory', p: 0.9 });
    expect(flat.why).toBe('rule 9 (frontmatter name+description+metadata.type)');
    const nested = classifyFile({ item: item('/h/.claude/memory/a.md'), frontmatter: fm({ name: 'a', description: 'b', metadata: { type: 'project' } }), doc: doc('# a') });
    expect(nested).toMatchObject({ rule: 9, class: 'memory' });
  });

  it('rule 10 — markdown with structure, p = 0.75', () => {
    const v = classifyFile({ item: item('/ws/AGENTS.md'), doc: doc('# a\ntext'.padEnd(200, '\n'), { headings: ['a'], lines: 340 }) });
    expect(v).toMatchObject({ rule: 10, class: 'memory', skip: null, p: 0.75, band: false });
  });

  it('rule 11 — a short headingless note, p = 0.55, in the band', () => {
    const v = classifyFile({ item: item('/ws/notes.md'), doc: doc('a short note', { headings: [], lines: 40 }) });
    expect(v).toMatchObject({ rule: 11, class: 'memory', skip: null, p: 0.55, band: true });
  });

  it('rule 12 — everything else, skip:unrelated, in the band', () => {
    const v = classifyFile({ item: item('/ws/data.csv') });
    expect(v).toMatchObject({ rule: 12, skip: 'skip:unrelated', p: 0.45, band: true });
  });
});

describe('§4.4.1 amended 2026-09-22 — the identity rules run before the atlas class (review defect 11)', () => {
  // Every discovered artefact carries an atlas row, so with the atlas class first these seven
  // verdicts were unreachable and the repo’s own AGENTS.md would append to itself on every run.
  it('rule 1 — a source that is one of our own destinations is skip:self, atlas row or not (§6 row 9)', () => {
    expect(classifyFile({ item: item('/ws/AGENTS.md'), spec, isDestination: true })).toMatchObject({ rule: 1, skip: 'skip:self' });
  });

  it('rule 1 — a bundled artefact with an atlas row is still skip:third-party (§6 row 54)', () => {
    expect(classifyFile({ item: item('/h/.codex/skills/.system/review-agent/SKILL.md'), spec })).toMatchObject({ rule: 1, skip: 'skip:third-party' });
  });

  it('rule 1 — a tool-managed file with an atlas row is still skip:tool-managed', () => {
    expect(classifyFile({ item: item('/h/.claude/statsig/cache.md'), spec })).toMatchObject({ rule: 1, skip: 'skip:tool-managed' });
  });

  it('rule 2 — a secret basename under a non-secret atlas row is still named, not read (§6 row 39)', () => {
    expect(classifyFile({ item: item('/ws/.env'), spec })).toMatchObject({ rule: 2, skip: 'skip:secret', class: 'secret' });
  });

  it('rule 3 — an oversize file with an atlas row is still skip:oversize (§6 row 29)', () => {
    expect(classifyFile({ item: item('/h/.claude/CLAUDE.md', { bytes: 4_299_161 }), spec })).toMatchObject({ rule: 3, skip: 'skip:oversize' });
  });

  it('rule 4 — a binary with an atlas row is still skip:not-text (§6 rows 24–25)', () => {
    expect(classifyFile({ item: item('/h/.claude/memory/a.md'), spec, doc: doc('PNG\u0000\u0000ihdr') })).toMatchObject({ rule: 4, skip: 'skip:not-text' });
  });

  it('rule 5 — an unsupported format with an atlas row is still skip:unsupported (§6 rows 27, 53)', () => {
    expect(classifyFile({ item: item('/h/.claude/workflows/deploy.js'), spec: { ...spec, id: 'claude.workflows', class: 'command' } })).toMatchObject({ rule: 5, skip: 'skip:unsupported' });
  });

  // Ratified 2026-09-22 with the hoist: the atlas's never-import classes (`transcript`, `secret`,
  // `skip`) sit at rule 2, ABOVE oversize/not-text/unsupported. An oversize transcript therefore
  // reports `skip:transcript` — the reason the human can act on (`--source claude-transcripts`)
  // rather than the cap. ~20 of the author's 3,371 real transcripts are over the 4 MiB cap
  // (§3.12), so this is the common case, not a corner.
  it('rule 2 — a transcript over the read cap still reports the transcript reason, not the cap', () => {
    const big = item('/h/.claude/projects/x/s.jsonl', { bytes: 151_000_000 });
    expect(classifyFile({ item: big, spec: { ...spec, id: 'claude.transcripts', class: 'transcript' } })).toMatchObject({ rule: 2, skip: 'skip:transcript' });
  });

  it('rule 2 — never-imported outranks not-text and unsupported too, and needs no successful parse', () => {
    const binary = item('/h/.claude/projects/x/s.jsonl', { parse: { ok: false, error: 'not utf-8' } });
    expect(classifyFile({ item: binary, spec: { ...spec, id: 'claude.transcripts', class: 'transcript' } })).toMatchObject({ rule: 2, skip: 'skip:transcript' });
    // …but a secret BASENAME is still answered by name first, so a credential store reads as one
    const cred = item('/h/.claude/.credentials.json', { bytes: 151_000_000 });
    expect(classifyFile({ item: cred, spec: { ...spec, id: 'claude.credentials', class: 'secret' } })).toMatchObject({ rule: 2, skip: 'skip:secret' });
  });

  it('rule 6 — past the identity rules the atlas class still wins over every content rule', () => {
    const v = classifyFile({ item: item('/h/.claude/memory/a.md'), spec, frontmatter: fm({ globs: 'src/**', 'argument-hint': 'x' }), doc: doc('# a\n$ARGUMENTS') });
    expect(v).toMatchObject({ rule: 6, class: 'memory', skip: null, p: 1, band: false });
    expect(v.why).toBe('rule 6 (atlas claude.auto-memory.topic)');
  });
});

describe('§4.4.1 first match wins', () => {
  it('the rule number climbs as each earlier trigger is removed', () => {
    const md = doc('# heading\n\nbody', { headings: ['heading'], lines: 12 });
    const steps: { rule: number; input: FileInput }[] = [
      { rule: 1, input: { item: item('/h/.claude/memory/.env', { bytes: 9_000_000 }), spec, isDestination: true, frontmatter: fm({ globs: 's/**' }), doc: md } },
      { rule: 2, input: { item: item('/h/.claude/memory/.env', { bytes: 9_000_000 }), spec, frontmatter: fm({ globs: 's/**' }), doc: md } },
      { rule: 3, input: { item: item('/h/.claude/memory/a.md', { bytes: 9_000_000 }), spec, frontmatter: fm({ globs: 's/**' }), doc: md } },
      { rule: 4, input: { item: item('/h/.claude/memory/a.md'), spec, frontmatter: fm({ globs: 's/**' }), doc: doc('x\u0000y') } },
      { rule: 5, input: { item: item('/h/.claude/memory/a.js'), spec, frontmatter: fm({ globs: 's/**' }), doc: md } },
      { rule: 6, input: { item: item('/h/.claude/memory/a.md'), spec, frontmatter: fm({ globs: 's/**' }), doc: md } },
      { rule: 7, input: { item: item('/h/.claude/memory/a.md'), frontmatter: fm({ globs: 's/**', 'argument-hint': 'x', name: 'n', description: 'd', type: 'project' }), doc: md } },
      { rule: 8, input: { item: item('/h/.claude/memory/a.md'), frontmatter: fm({ 'argument-hint': 'x', name: 'n', description: 'd', type: 'project' }), doc: md } },
      { rule: 9, input: { item: item('/h/.claude/memory/a.md'), frontmatter: fm({ name: 'n', description: 'd', type: 'project' }), doc: md } },
      { rule: 10, input: { item: item('/h/.claude/memory/a.md'), frontmatter: fm({ description: 'd' }), doc: md } },
      { rule: 11, input: { item: item('/h/.claude/memory/a.md'), doc: doc('plain', { headings: [], lines: 4 }) } },
      { rule: 12, input: { item: item('/h/.claude/memory/a.csv') } },
    ];
    expect(steps.map((s) => classifyFile(s.input).rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('§4.4.1 totality and the band', () => {
  const inputs: FileInput[] = [
    { item: item('/ws/a.md') },
    { item: item('/ws/a.md'), doc: doc('') },
    { item: item('/ws/a.bin', { bytes: 0 }) },
    { item: item('/ws/.env') },
    { item: item('/ws/a.mdc'), frontmatter: fm({}) },
    { item: item('/ws/a.json') },
    { item: item('/ws/a.jsonl') },
    { item: item('/ws/a.toml'), spec: { ...spec, class: 'config' } },
    { item: item('/ws/a.md'), doc: doc('x'.repeat(50), { lines: 5000 }) },
    { item: item('/ws/a'), isDestination: true },
  ];

  it('every input leaves with exactly one verdict, and no rule outside 1..12', () => {
    for (const i of inputs) {
      const v = classifyFile(i);
      expect(v.rule, i.item.realpath).toBeGreaterThanOrEqual(1);
      expect(v.rule, i.item.realpath).toBeLessThanOrEqual(12);
      expect(typeof v.why).toBe('string');
      expect(v.why.length).toBeGreaterThan(0);
      // a verdict is either a class to import, or a *named* skip — never a silent bucket
      expect(v.skip === null || v.skip.startsWith('skip:')).toBe(true);
    }
  });

  it('the band is exactly rows 11 and 12 (§4.4.1)', () => {
    expect(FILE_BAND).toEqual({ lo: 0.5, hi: 0.7 });
    expect([...BAND_RULES]).toEqual([11, 12]);
    const banded = new Set<number>();
    for (const i of [...inputs, { item: item('/ws/n.md'), doc: doc('n', { lines: 3 }) }, { item: item('/ws/x.csv') }]) {
      const v = classifyFile(i);
      if (v.band) banded.add(v.rule);
      else expect(BAND_RULES.includes(v.rule) || v.rule < 11).toBe(true);
    }
    for (const r of banded) expect(BAND_RULES).toContain(r);
  });
});

// ---------------------------------------------------------------------------------------
// §4.4.2 — the 9 key rules
// ---------------------------------------------------------------------------------------

describe('§4.4.2 the 9 key rules', () => {
  it('rule 1 — the known-secret set (§6 row 38)', () => {
    const v = classifyKey(leaf('env.ANTHROPIC_API_KEY', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK'));
    expect(v).toMatchObject({ rule: 1, class: 'secret', kind: 'secret', band: false });
    expect(v.why).toContain('known-secret set');
    expect(classifyKey(leaf('apiKeyHelper', '/bin/echo hi')).rule).toBe(1);
    expect(classifyKey(leaf('provider.openrouter.options.apiKey', 'literalvalue1234')).rule).toBe(1);
    expect(classifyKey(leaf('servers.x.oauth.clientSecret', 'literalvalue1234')).rule).toBe(1);
  });

  it('rule 2 — a secret-looking leaf name with a value ≥ 8 chars', () => {
    expect(classifyKey(leaf('deploy.myToken', 'abcdefghij'))).toMatchObject({ rule: 2, class: 'secret' });
    // shorter than MIN_SECRET_LENGTH ⇒ not rule 2
    expect(classifyKey(leaf('deploy.myToken', 'short')).rule).not.toBe(2);
  });

  it('rule 3 — a detectSecrets family, and it runs BEFORE the band', () => {
    const ghp = `ghp_${'A'.repeat(36)}`;
    const v = classifyKey(leaf('integration.clientCode', ghp));
    expect(v).toMatchObject({ rule: 3, class: 'secret', band: false });
    expect(v.why).toContain('github');
    // the same shape without a family lands in the band instead
    expect(classifyKey(leaf('integration.clientCode', 'a7f3b2c1d4e5f60718293a4b5c6d7e8f')).rule).toBe(8);
  });

  it('rule 4 — a pure env reference is CONFIG, not a secret (§4.8.3, §6 row 42)', () => {
    for (const ref of ['${GITHUB_TOKEN}', '${env:GITHUB_TOKEN}', '{env:GITHUB_TOKEN}', '$GITHUB_TOKEN', '%GITHUB_TOKEN%']) {
      const v = classifyKey(leaf('mcpServers.github.env.GITHUB_TOKEN', ref));
      expect(v, ref).toMatchObject({ rule: 4, class: 'config', kind: 'reference', band: false });
    }
    // …but `${VAR:-default}` carries a literal, so it does not get rule 4's free pass over rules
    // 1–3 and the band. (`mcp.ts` still normalises the form to `${VAR}` per §3.10 / §6 row 42 —
    // it drops the default rather than importing it.)
    expect(classifyKey(leaf('mcpServers.github.env.GITHUB_TOKEN', '${GITHUB_TOKEN:-none}'))).toMatchObject({ rule: 2, class: 'secret', kind: 'secret' });
  });

  it('rule 5 — the permission set is suggestion-only (§6 row 51)', () => {
    for (const p of ['permissions.allow.0', 'allowedTools.0', 'sandbox.mode', 'approval_policy', 'sandbox_mode', 'projects./Users/x.trust_level', 'trust', 'hasTrustDialogAccepted', 'rules.prefix_rule.0']) {
      expect(classifyKey(leaf(p, 'allow')), p).toMatchObject({ rule: 5, kind: 'permission', class: 'config' });
    }
  });

  it('rule 6 — the hook/exec set is report-only, and `*.command` inside an MCP block is not its business (§6 row 53)', () => {
    expect(classifyKey(leaf('hooks.PreToolUse.0.command', 'echo hi'))).toMatchObject({ rule: 6, kind: 'exec', class: 'command' });
    expect(classifyKey(leaf('statusLine.command', 'echo hi'))).toMatchObject({ rule: 6, kind: 'exec' });
    expect(classifyKey(leaf('notify.0', 'say done'))).toMatchObject({ rule: 6, kind: 'exec' });
    expect(classifyKey(leaf('mcpServers.github.command', 'npx'))).toMatchObject({ rule: 7, kind: 'mcp', class: 'mcp' });
  });

  it('rule 7 — the five mcp spellings', () => {
    for (const p of ['mcpServers.github.args.0', 'mcp.servers.x.url', 'mcp_servers.chrome.command', 'servers.x.transport', 'context_servers.y.command']) {
      expect(classifyKey(leaf(p, 'npx')), p).toMatchObject({ rule: 7, kind: 'mcp', class: 'mcp' });
    }
  });

  it('rule 8 — the band, and the allowlist that keeps a 64-hex sha256 out of it (§6 rows 45, 47)', () => {
    const v = classifyKey(leaf('integration.clientId', 'a7f3b2c1d4e5f60718293a4b5c6d7e8f'));
    expect(v).toMatchObject({ rule: 8, band: true, class: 'config', kind: 'config' });
    expect(v.shape?.length).toBe(32);
    expect(v.shape?.charset).toBe('hex');
    for (const name of NON_SECRET_LEAF_NAMES) {
      const k = classifyKey(leaf(`instructions.0.${name}`, '9f8e7d6c5b4a39281706f5e4d3c2b1a0998877665544332211ffeeddccbbaa99'));
      expect(k.band, name).toBe(false);
      expect(k.rule, name).toBe(9);
    }
  });

  it('rule 9 — otherwise CONFIG', () => {
    expect(classifyKey(leaf('model', 'z-ai/glm-5.3-flash'))).toMatchObject({ rule: 9, class: 'config', kind: 'config', band: false });
    expect(classifyKey(leaf('effortLevel', 3))).toMatchObject({ rule: 9, class: 'config' });
  });

  it('no key verdict ever carries a value', () => {
    const value = 'a7f3b2c1d4e5f60718293a4b5c6d7e8f';
    const v = classifyKey(leaf('integration.clientId', value));
    const serialised = JSON.stringify({ class: v.class, kind: v.kind, rule: v.rule, band: v.band, why: v.why, shape: v.shape });
    expect(serialised).not.toContain(value);
    expect(serialised).not.toContain(value.slice(0, 6));
  });

  it('classifyConfig maps every leaf, in walk order', () => {
    const leaves = walkLeaves({ env: { ANTHROPIC_API_KEY: 'x'.repeat(40) }, permissions: { allow: ['Bash(ls)'] }, model: 'glm' });
    const verdicts = classifyConfig(leaves);
    expect(verdicts).toHaveLength(leaves.length);
    expect(verdicts.map((v) => v.kind)).toEqual(['secret', 'permission', 'config']);
  });
});

// ---------------------------------------------------------------------------------------
// walkLeaves and formatOf
// ---------------------------------------------------------------------------------------

describe('walkLeaves', () => {
  it('addresses every leaf by its dotted path, arrays by index', () => {
    const leaves = walkLeaves({ a: { b: 1 }, c: ['x', 'y'], d: true });
    expect(leaves.map((l) => l.dotted)).toEqual(['a.b', 'c.0', 'c.1', 'd']);
    expect(leaves[1]?.path).toEqual(['c', '0']);
  });

  it('keeps an empty object or array as a leaf, so it still appears in the report', () => {
    expect(walkLeaves({ permissions: {}, deny: [] }).map((l) => l.dotted)).toEqual(['permissions', 'deny']);
  });

  it('is bounded by maxLeaves', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 100; i++) big[`k${i}`] = i;
    expect(walkLeaves(big, { maxLeaves: 10 })).toHaveLength(10);
  });
});

describe('formatOf', () => {
  it('maps the basenames the atlas produces', () => {
    const table: [string, string][] = [
      ['AGENTS.md', 'md'],
      ['style.mdc', 'mdc'],
      ['settings.json', 'json'],
      ['opencode.jsonc', 'jsonc'],
      ['config.toml', 'toml'],
      ['a.yaml', 'yaml'],
      ['session.jsonl', 'jsonl'],
      ['state_5.sqlite', 'sqlite'],
      ['deploy.js', 'js'],
      ['hook.sh', 'sh'],
      ['default.rules', 'text'],
      ['.cursorrules', 'md'],
      ['LICENSE', 'text'],
    ];
    for (const [name, want] of table) expect(formatOf(name), name).toBe(want);
  });
});
