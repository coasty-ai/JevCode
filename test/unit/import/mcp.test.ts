/**
 * docs/IMPORT-DESIGN.md §3.10 / §2.7 / §4.7.4 step 5 / §4.8.3 / §8.2 R6 — the eight-dialect normaliser.
 *
 * Eight tools describe one server eight ways. The three rules with security weight are asserted
 * separately from the shape work: every server arrives `enabled: false`; a literal credential is
 * replaced by its variable name with the §4.8.3 note; and a credential-looking **variable** is never
 * expanded into a remote `url` or `headers`. R6 closes the loop: six dialects round-trip, and the two
 * documented losses (Gemini `httpUrl`, Codex `env_key`) are asserted as fixed notes so a silent loss
 * becomes a test failure.
 */
import { describe, expect, it } from 'vitest';

import { IMPORT_LIMITS } from '../../../src/core/limits.js';
import { mergeMcpFile, normaliseMcp, normaliseReference, parseMcpFile, renderBackTo, renderMcpFile } from '../../../src/import/mcp.js';
import type { McpDialect, NormaliseInput } from '../../../src/import/mcp.js';
import type { Json } from '../../../src/core/types.js';
import type { McpFile, McpServerRecord, SourceTool } from '../../../src/import/types.js';

const TOOL_OF: Readonly<Record<McpDialect, SourceTool>> = {
  'claude-code': 'claude-code',
  cursor: 'cursor',
  windsurf: 'windsurf',
  gemini: 'gemini',
  opencode: 'opencode',
  codex: 'codex',
  vscode: 'copilot',
  'claude-desktop': 'claude-desktop',
};

function input(dialect: McpDialect, raw: Json, over: Partial<NormaliseInput> = {}): NormaliseInput {
  return {
    dialect,
    tool: TOOL_OF[dialect],
    sourcePath: `~/.config/${dialect}/mcp.json`,
    sourceSha256: 'a'.repeat(64),
    importId: 'imp_20260921T120000Z_a1b2c3',
    raw,
    ...over,
  };
}

/** The same stdio server written the way each of the eight dialects writes it (§3.10). */
const DIALECT_SOURCES: Readonly<Record<McpDialect, Json>> = {
  'claude-code': { mcpServers: { github: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } } },
  cursor: { mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' } } } },
  windsurf: { mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' } } } },
  gemini: { mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '$GITHUB_TOKEN' } } } },
  opencode: { mcp: { github: { type: 'local', command: ['npx', '-y', 'server-github'], environment: { GITHUB_TOKEN: '{env:GITHUB_TOKEN}' } } } },
  codex: { mcp_servers: { github: { command: 'npx', args: ['-y', 'server-github'], env_key: 'GITHUB_TOKEN' } } },
  vscode: { servers: { github: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${input:github-token}' } } }, inputs: [{ id: 'github-token', description: 'your GitHub PAT' }] },
  'claude-desktop': { mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } } },
};

const DIALECTS = Object.keys(DIALECT_SOURCES) as readonly McpDialect[];

describe('normaliseMcp — all eight dialects (§3.10)', () => {
  it('normalise to one record: same transport, command, args and ${VAR} env', () => {
    expect(DIALECTS).toHaveLength(8);
    for (const dialect of DIALECTS) {
      const r = normaliseMcp(input(dialect, DIALECT_SOURCES[dialect]));
      const rec = r.servers['github'];
      expect(rec, dialect).toBeDefined();
      if (rec === undefined) continue;
      expect(rec.transport, dialect).toBe('stdio');
      expect(rec.command, dialect).toBe('npx');
      expect(rec.args, dialect).toEqual(['-y', 'server-github']);
      expect(rec.env, dialect).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' });
      expect(rec.enabled, dialect).toBe(false);
      expect(rec.source, dialect).toEqual({ tool: TOOL_OF[dialect], path: `~/.config/${dialect}/mcp.json`, sha256: 'a'.repeat(64), importId: 'imp_20260921T120000Z_a1b2c3' });
      expect(r.dropped, dialect).toEqual([]);
    }
  });

  it('the VS Code `${input:id}` note names the original prompt', () => {
    const r = normaliseMcp(input('vscode', DIALECT_SOURCES['vscode']));
    expect(r.notes).toContain('github: ${GITHUB_TOKEN} came from the VS Code input "your GitHub PAT"');
  });

  it('infers the transport: command → stdio, httpUrl → http, /sse → sse, otherwise http', () => {
    const t = (dialect: McpDialect, raw: Json): string | undefined => Object.values(normaliseMcp(input(dialect, raw)).servers)[0]?.transport;
    expect(t('claude-desktop', { mcpServers: { a: { command: 'x' } } })).toBe('stdio');
    expect(t('gemini', { mcpServers: { a: { httpUrl: 'https://x.example/mcp' } } })).toBe('http');
    expect(t('gemini', { mcpServers: { a: { url: 'https://x.example/sse' } } })).toBe('sse');
    expect(t('cursor', { mcpServers: { a: { url: 'https://x.example/sse?k=1' } } })).toBe('sse');
    expect(t('cursor', { mcpServers: { a: { url: 'https://x.example/mcp' } } })).toBe('http');
    expect(t('windsurf', { mcpServers: { a: { serverUrl: 'https://x.example/sse' } } })).toBe('sse');
    // a declared type wins over the url shape
    expect(t('claude-code', { mcpServers: { a: { type: 'http', url: 'https://x.example/sse' } } })).toBe('http');
    expect(t('opencode', { mcp: { a: { type: 'remote', url: 'https://x.example/mcp' } } })).toBe('http');
    expect(t('claude-code', { mcpServers: { a: { type: 'sse', url: 'https://x.example/mcp' } } })).toBe('sse');
    // a `command` that is also given a url is still stdio
    expect(t('claude-code', { mcpServers: { a: { command: 'x', url: 'https://x.example/mcp' } } })).toBe('stdio');
  });

  it('the url is kept only for a remote transport, and `serverUrl` / `httpUrl` land on the one `url` field', () => {
    const w = normaliseMcp(input('windsurf', { mcpServers: { a: { serverUrl: 'https://x.example/mcp' } } })).servers['a'];
    expect(w?.url).toBe('https://x.example/mcp');
    const stdio = normaliseMcp(input('claude-code', { mcpServers: { a: { command: 'x', url: 'https://x.example/mcp' } } })).servers['a'];
    expect(stdio?.url).toBeUndefined();
  });
});

describe('normaliseReference (§3.10)', () => {
  it('every env-reference form becomes ${VAR}, and a literal is null', () => {
    expect(normaliseReference('${GITHUB_TOKEN}', 'claude-code')).toBe('${GITHUB_TOKEN}');
    expect(normaliseReference('${GITHUB_TOKEN:-none}', 'claude-code')).toBe('${GITHUB_TOKEN}');
    expect(normaliseReference('${env:GITHUB_TOKEN}', 'cursor')).toBe('${GITHUB_TOKEN}');
    expect(normaliseReference('${env:GITHUB_TOKEN}', 'windsurf')).toBe('${GITHUB_TOKEN}');
    expect(normaliseReference('{env:GITHUB_TOKEN}', 'opencode')).toBe('${GITHUB_TOKEN}');
    expect(normaliseReference('$GITHUB_TOKEN', 'gemini')).toBe('${GITHUB_TOKEN}');
    expect(normaliseReference('%GITHUB_TOKEN%', 'gemini')).toBe('${GITHUB_TOKEN}');
    expect(normaliseReference('${input:github-token}', 'vscode')).toBe('${GITHUB_TOKEN}');
    expect(normaliseReference('ghp_literalvaluenotareference', 'claude-desktop')).toBeNull();
    expect(normaliseReference('', 'cursor')).toBeNull();

    // the four substitutions §3.10 names by hand
    expect(normaliseReference('${workspaceFolder}', 'cursor')).toBe('${JEVCODE_WORKSPACE}');
    expect(normaliseReference('${userHome}', 'cursor')).toBe('${HOME}');
    expect(normaliseReference('${pathSeparator}', 'cursor')).toBe('/');
    expect(normaliseReference('${workspaceFolder}${pathSeparator}bin', 'cursor')).toBe('${JEVCODE_WORKSPACE}/bin');

    // a dialect's own syntax is only read for that dialect: a Windows `%PATH%` literal survives elsewhere
    expect(normaliseReference('%PATH%', 'cursor')).toBeNull();
    expect(normaliseReference('{env:X}', 'cursor')).toBeNull();
    expect(normaliseReference('$HOME/bin', 'cursor')).toBeNull();
    // a `${file:…}` reference is not an env reference; nothing here ever reads a referenced file
    expect(normaliseReference('${file:/etc/token}', 'windsurf')).toBeNull();
  });
});

describe('credentials never leave their file (§4.8.3, §4.8.1)', () => {
  it('a literal credential is replaced by its variable name, with the note', () => {
    const r = normaliseMcp(input('claude-desktop', { mcpServers: { github: { command: 'x', env: { GITHUB_TOKEN: 'ghp_0123456789012345678901234567890123456789' } } } }));
    const rec = r.servers['github'];
    expect(rec?.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' });
    expect(rec?.notes).toContain('env GITHUB_TOKEN held a literal value in the source; only the name was imported');
    // the value itself is nowhere in the result
    expect(JSON.stringify(r)).not.toContain('ghp_0123456789');
  });

  it('a value that a family recognises is substituted even when the key name is innocent', () => {
    const r = normaliseMcp(input('claude-desktop', { mcpServers: { a: { command: 'x', env: { SETTING: 'sk-ant-api03-0123456789012345678901234567890123456789' } } } }));
    expect(r.servers['a']?.env).toEqual({ SETTING: '${SETTING}' });
    expect(JSON.stringify(r)).not.toContain('sk-ant-api03');
  });

  it('an ordinary literal survives: not everything in `env` is a credential', () => {
    const r = normaliseMcp(input('claude-desktop', { mcpServers: { a: { command: 'x', env: { NODE_ENV: 'production' } } } }));
    expect(r.servers['a']?.env).toEqual({ NODE_ENV: 'production' });
  });

  it('a literal Authorization header becomes ${MCP_<SERVER>_AUTH} with the note', () => {
    const r = normaliseMcp(input('claude-code', { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer sk-live_0123456789012345678901234567890' } } } }));
    const rec = r.servers['linear'];
    expect(rec?.headers).toEqual({ Authorization: '${MCP_LINEAR_AUTH}' });
    expect(rec?.notes).toContain('header Authorization held a literal value in the source; only the name was imported (${MCP_LINEAR_AUTH})');
    expect(JSON.stringify(r)).not.toContain('sk-live_');
  });

  it('NEVER-EXPAND: a credential-looking variable in a remote url or headers stays a reference and is reported', () => {
    const r = normaliseMcp(
      input('claude-code', { mcpServers: { remote: { url: 'https://x.example/mcp?key=${API_KEY}', headers: { 'X-Api-Key': '${SERVICE_TOKEN}' } } } }),
    );
    const rec = r.servers['remote'];
    expect(rec?.transport).toBe('http');
    expect(rec?.url).toBe('https://x.example/mcp?key=${API_KEY}');
    expect(rec?.headers).toEqual({ 'X-Api-Key': '${SERVICE_TOKEN}' });
    expect(rec?.notes).toContain('url holds the reference ${API_KEY}; it is never expanded (§3.10)');
    expect(rec?.notes).toContain('header X-Api-Key holds the reference ${SERVICE_TOKEN}; it is never expanded (§3.10)');
    // and a remote server's credential-looking env reference is reported too
    const e = normaliseMcp(input('claude-code', { mcpServers: { remote: { url: 'https://x.example/mcp', env: { API_SECRET: '${API_SECRET}' } } } })).servers['remote'];
    expect(e?.notes).toContain('env holds the reference ${API_SECRET} for a remote server; it is never expanded (§3.10)');
  });

  // review defect 4 — three paths wrote a literal credential into `.jevcode/mcp.json`
  describe('the three paths a literal used to escape by (review defect 4)', () => {
    it('(a) a *mixed* value — one reference beside a literal — is not waved through as a reference', () => {
      const r = normaliseMcp(
        input('claude-code', {
          mcpServers: { a: { command: 'x', env: { AUTH: 'Bearer sk-ant-api03-0123456789012345678901234567890123456789 ${SUFFIX}' } } },
        }),
      );
      expect(JSON.stringify(r), 'the literal must not reach mcp.json').not.toContain('sk-ant-api03');
      expect(r.servers['a']?.env).toEqual({ AUTH: '${AUTH}' });
      expect(r.servers['a']?.notes).toContain('env AUTH held a literal value in the source; only the name was imported');
    });

    it('(a) the same hole in `headers` — a mixed Authorization value', () => {
      const r = normaliseMcp(
        input('claude-code', {
          mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer sk-ant-api03-0123456789012345678901234567890123456789 ${SUFFIX}' } } },
        }),
      );
      expect(JSON.stringify(r)).not.toContain('sk-ant-api03');
      expect(r.servers['linear']?.headers).toEqual({ Authorization: '${MCP_LINEAR_AUTH}' });
    });

    it('(b) `url` never saw detectSecrets — a credential in the userinfo was written verbatim', () => {
      const r = normaliseMcp(
        input('claude-code', { mcpServers: { remote: { type: 'http', url: 'https://user:sk-ant-api03-0123456789012345678901234567890123456789@mcp.example.com/v1' } } }),
      );
      expect(JSON.stringify(r), 'the credential must not reach mcp.json').not.toContain('sk-ant-api03');
      expect(r.servers['remote']?.url).toBe('${MCP_REMOTE_URL}');
      expect(r.servers['remote']?.notes).toContain('url held a literal credential in the source; only the name was imported (${MCP_REMOTE_URL})');
    });

    it('(b) an ordinary url is untouched', () => {
      const r = normaliseMcp(input('claude-code', { mcpServers: { remote: { type: 'http', url: 'https://mcp.example.com/v1' } } }));
      expect(r.servers['remote']?.url).toBe('https://mcp.example.com/v1');
    });

    it('(c) a high-entropy literal under an innocent key is in rule 8’s band, and a band item with no Jev is a secret', () => {
      const r = normaliseMcp(input('claude-desktop', { mcpServers: { a: { command: 'x', env: { CLIENT: 'Zt4Qx9Lm2Vb7Nk1Pr6Ws3Yd8Hc5Jf0Ga' } } } }));
      expect(JSON.stringify(r)).not.toContain('Zt4Qx9Lm');
      expect(r.servers['a']?.env).toEqual({ CLIENT: '${CLIENT}' });
      expect(r.servers['a']?.notes).toContain('env CLIENT held a literal value in the source; only the name was imported');
    });

    it('(c) the band’s own floors still let ordinary settings through', () => {
      const r = normaliseMcp(
        input('claude-desktop', {
          // `production` is under the 20-char floor; the model name is not a band charset;
          // `abcdefgh`×3 is 24 alnum chars at exactly 3.0 b/c, under the 3.2 entropy floor
          mcpServers: { a: { command: 'x', env: { NODE_ENV: 'production', MODEL: 'z-ai/glm-5.3-flash', PROFILE: 'abcdefghabcdefghabcdefgh' } } },
        }),
      );
      expect(r.servers['a']?.env).toEqual({ NODE_ENV: 'production', MODEL: 'z-ai/glm-5.3-flash', PROFILE: 'abcdefghabcdefghabcdefgh' });
      expect(r.servers['a']?.notes).toBeUndefined();
    });

    it('a pure reference is still a pure reference — no substitution, no note', () => {
      const r = normaliseMcp(input('claude-code', { mcpServers: { a: { command: 'x', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', OTHER: '${VAR:-fallback}' } } } }));
      expect(r.servers['a']?.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}', OTHER: '${VAR}' });
      expect(r.servers['a']?.notes ?? []).not.toContain('env GITHUB_TOKEN held a literal value in the source; only the name was imported');
    });

    it('a `${VAR:-<literal credential>}` default never travels', () => {
      const r = normaliseMcp(
        input('claude-code', { mcpServers: { a: { command: 'x', env: { TOKEN: '${TOKEN:-sk-ant-api03-0123456789012345678901234567890123456789}' } } } }),
      );
      expect(JSON.stringify(r)).not.toContain('sk-ant-api03');
      expect(r.servers['a']?.env).toEqual({ TOKEN: '${TOKEN}' });
    });
  });

  it('a `${file:…}` env value is dropped, never read', () => {
    const r = normaliseMcp(input('windsurf', { mcpServers: { a: { command: 'x', env: { TOKEN: '${file:/etc/secrets/token}' } } } }));
    expect(r.servers['a']?.env).toBeUndefined();
    expect(r.dropped).toContain('a.env.TOKEN (file reference)');
    expect(r.notes).toContain('a: env TOKEN used a file reference; it was dropped — the importer never reads a referenced file');
  });
});

describe('extras (§3.10 column 5) — nothing is dropped silently', () => {
  it('names every dropped and every recorded extra', () => {
    const cc = normaliseMcp(input('claude-code', { mcpServers: { a: { command: 'x', headersHelper: 'gh auth token', oauth: { clientId: 'x' }, alwaysLoad: true } } }));
    expect(cc.dropped).toEqual(['a.headersHelper', 'a.oauth', 'a.alwaysLoad']);
    expect(cc.notes).toContain('a: headersHelper dropped: it runs a command to build a header');

    // §4.8.4: a Gemini `trust` is a permission decision and `oauth.clientSecret` is a credential
    const g = normaliseMcp(input('gemini', { mcpServers: { a: { command: 'x', trust: true, oauth: { clientSecret: 'shhh-not-a-real-secret' }, includeTools: ['a', 'b'] } } }));
    expect(g.dropped).toEqual(['a.oauth', 'a.trust']);
    expect(g.notes).toContain('a: trust dropped: a permission decision is never imported (§4.8.4)');
    expect(g.notes).toContain('a: includeTools is recorded in the report, not applied');
    expect(JSON.stringify(g)).not.toContain('shhh-not-a-real-secret');

    const cx = normaliseMcp(input('codex', { mcp_servers: { a: { command: 'x', enabled_tools: ['q'] } } }));
    expect(cx.notes).toContain('a: enabled_tools is recorded in the report, not applied');

    // an extra nobody declared is still named
    const unknown = normaliseMcp(input('cursor', { mcpServers: { a: { command: 'x', somethingNew: 1 } } }));
    expect(unknown.dropped).toContain('a.somethingNew');
    expect(unknown.notes).toContain('a: somethingNew is not part of the normalised record; it was dropped');
  });

  it('a malformed document is a note, never a throw', () => {
    expect(normaliseMcp(input('cursor', 'not an object')).servers).toEqual({});
    expect(normaliseMcp(input('cursor', { other: 1 })).notes).toEqual(['the source held no MCP server map']);
    expect(normaliseMcp(input('cursor', { mcpServers: { a: 'nope' } })).dropped).toEqual(['a (not an object)']);
  });
});

describe('mergeMcpFile (§4.7.4 step 5)', () => {
  function rec(tool: SourceTool, command = 'x'): McpServerRecord {
    return { transport: 'stdio', command, enabled: false, source: { tool, path: `~/${tool}.json`, sha256: 'b'.repeat(64), importId: 'imp_1' } };
  }

  it('leaves existing servers untouched, adds new ones disabled, and suffixes a collision with the tool', () => {
    const existing: McpFile = { v: 1, servers: { github: rec('cursor', 'existing-one') } };
    const m = mergeMcpFile(existing, { github: rec('codex'), linear: rec('codex') });
    expect(m.file.servers['github']?.command).toBe('existing-one');
    expect(m.file.servers['github-codex']?.command).toBe('x');
    expect([...m.added].sort()).toEqual(['github-codex', 'linear']);
    expect(m.renamed).toEqual(['github-codex']);
    expect(Object.values(m.file.servers).every((s) => s.enabled === false)).toBe(true);
  });

  it('a second collision on the suffixed name gets a counter', () => {
    const existing: McpFile = { v: 1, servers: { github: rec('cursor'), 'github-codex': rec('codex') } };
    const m = mergeMcpFile(existing, { github: rec('codex') });
    expect(m.renamed).toEqual(['github-codex-2']);
  });

  it('re-asserts enabled: false on whatever was on disk (§1 property 16)', () => {
    const tampered = { v: 1, servers: { a: { ...rec('cursor'), enabled: true } } } as unknown as McpFile;
    expect(mergeMcpFile(tampered, {}).file.servers['a']?.enabled).toBe(false);
  });

  it('stops at the mcpServers cap and names what it dropped', () => {
    const incoming: Record<string, McpServerRecord> = {};
    for (let i = 0; i < IMPORT_LIMITS.mcpServers + 3; i++) incoming[`s${i}`] = rec('codex');
    const m = mergeMcpFile(null, incoming);
    expect(Object.keys(m.file.servers)).toHaveLength(IMPORT_LIMITS.mcpServers);
    expect(m.dropped).toHaveLength(3);
    expect(m.dropped[0]).toContain(`over the ${IMPORT_LIMITS.mcpServers}-server cap`);
    expect(mergeMcpFile(null, incoming, { maxServers: 2 }).added).toHaveLength(2);
  });
});

describe('renderMcpFile / parseMcpFile (§2.7)', () => {
  it('round-trips through the file, stable in server-name order, always disabled', () => {
    const file: McpFile = {
      v: 1,
      servers: {
        zeta: { transport: 'http', url: 'https://z.example/mcp', headers: { 'X-Api-Key': '${K}' }, enabled: false, source: { tool: 'cursor', path: '~/c.json', sha256: 'c'.repeat(64), importId: 'imp_1' }, notes: ['n'] },
        alpha: { transport: 'stdio', command: 'npx', args: ['-y', 'a'], env: { A: '${A}' }, enabled: false, source: { tool: 'codex', path: '~/x.toml', sha256: 'd'.repeat(64), importId: 'imp_1' } },
      },
    };
    const text = renderMcpFile(file);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
    const back = parseMcpFile(text);
    expect(back).toEqual(file);
    expect(renderMcpFile(back!)).toBe(text);
    // a tampered `enabled: true` on disk comes back false
    expect(parseMcpFile(text.replace('"enabled": false', '"enabled": true'))?.servers['alpha']?.enabled).toBe(false);
  });

  it('is tolerant: a malformed or foreign file is null, never a throw', () => {
    expect(parseMcpFile('{')).toBeNull();
    expect(parseMcpFile('[]')).toBeNull();
    expect(parseMcpFile('{"v":2,"servers":{}}')).toBeNull();
    expect(parseMcpFile('{"v":1}')).toBeNull();
    expect(parseMcpFile('{"v":1,"servers":{"a":{"transport":"telepathy"}}}')).toEqual({ v: 1, servers: {} });
  });
});

describe('R6 — source dialect → record → back (§8.2)', () => {
  const LOSSLESS: readonly McpDialect[] = ['claude-code', 'cursor', 'windsurf', 'opencode', 'vscode', 'claude-desktop'];
  /** `notes` is report prose about the *source document*, not configuration; the round trip is over the record. */
  const config = (r: McpServerRecord): Omit<McpServerRecord, 'notes'> => {
    const { notes: _notes, ...rest } = r;
    return rest;
  };

  it('the six lossless dialects round-trip byte-stable modulo key order', () => {
    for (const dialect of LOSSLESS) {
      const source = DIALECT_SOURCES[dialect];
      const first = normaliseMcp(input(dialect, source));
      const rec = first.servers['github'];
      expect(rec, dialect).toBeDefined();
      if (rec === undefined) continue;
      const back = renderBackTo(dialect, 'github', rec);
      // re-parsing the rendered form yields the same record, field for field
      const key = dialect === 'opencode' ? 'mcp' : dialect === 'vscode' ? 'servers' : 'mcpServers';
      const second = normaliseMcp(input(dialect, { [key]: { github: back } })).servers['github'];
      expect(second, dialect).toBeDefined();
      if (second === undefined) continue;
      expect(config(second), dialect).toEqual(config(rec));
      expect(first.dropped, dialect).toEqual([]);
      // and rendering the re-parsed record produces the identical document fragment
      expect(renderBackTo(dialect, 'github', second), dialect).toEqual(back);
    }
  });

  it('VS Code re-renders `${input:id}` as `${env:VAR}`: the binding is the only thing that moves', () => {
    const rec = normaliseMcp(input('vscode', DIALECT_SOURCES['vscode'])).servers['github']!;
    expect(renderBackTo('vscode', 'github', rec)).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' } });
  });

  it('Gemini `httpUrl`: the record carries one url, so a source that set BOTH loses `url` — as a fixed note', () => {
    const both = { mcpServers: { api: { url: 'https://api.example/sse', httpUrl: 'https://api.example/mcp' } } };
    const r = normaliseMcp(input('gemini', both));
    const rec = r.servers['api']!;
    expect(rec.transport).toBe('http');
    expect(rec.url).toBe('https://api.example/mcp');
    expect(rec.notes).toContain('gemini httpUrl and url were both set; the record keeps httpUrl — url is a fixed, reported loss (§8.2 R6)');
    expect(r.dropped).toContain('api.url (the record carries one url; httpUrl wins)');
    // the half that does survive renders back as `httpUrl`, not `url`
    expect(renderBackTo('gemini', 'api', rec)).toEqual({ httpUrl: 'https://api.example/mcp' });
    // and an SSE Gemini server comes back as `url`
    const sse = normaliseMcp(input('gemini', { mcpServers: { api: { url: 'https://api.example/sse' } } })).servers['api']!;
    expect(renderBackTo('gemini', 'api', sse)).toEqual({ url: 'https://api.example/sse' });
  });

  it('Codex `env_key`: a variable NAME becomes an ordinary env entry and renders back as `env` — the fixed note says so', () => {
    const rec = normaliseMcp(input('codex', DIALECT_SOURCES['codex'])).servers['github']!;
    expect(rec.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' });
    expect(rec.notes).toContain('codex env_key GITHUB_TOKEN imported as the variable reference ${GITHUB_TOKEN}; it renders back as env, not env_key');
    const back = renderBackTo('codex', 'github', rec);
    expect(back).toEqual({ command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } });
    expect(JSON.stringify(back)).not.toContain('env_key');
    // `bearer_token_env_var` is the same shape of loss, and it is never expanded
    const bearer = normaliseMcp(input('codex', { mcp_servers: { a: { url: 'https://a.example/mcp', bearer_token_env_var: 'A_TOKEN' } } })).servers['a']!;
    expect(bearer.headers).toEqual({ Authorization: '${A_TOKEN}' });
    expect(bearer.notes).toContain('codex bearer_token_env_var A_TOKEN imported as the reference ${A_TOKEN}; it is never expanded');
  });
});
