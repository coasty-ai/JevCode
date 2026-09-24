/** import/parse/toml.ts (IMPORT-DESIGN §4.3; §6 row 21): dotted leaves, quoted table keys as one segment. */
import { describe, expect, it } from 'vitest';
import { dottedPath, parseToml } from '../../../../src/import/parse/toml.js';
import type { ConfigLeaf } from '../../../../src/import/types.js';

function leaves(text: string): readonly ConfigLeaf[] {
  const r = parseToml(text);
  expect(r.ok).toBe(true);
  return r.ok ? r.value : [];
}

function byDotted(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const l of leaves(text)) out[l.dotted] = l.value;
  return out;
}

describe('parseToml — the real ~/.codex/config.toml key set', () => {
  it('§6 row 21: a quoted table key stays ONE path segment', () => {
    const l = leaves('[projects."/Users/x/y-z"]\ntrust_level = "trusted"\n');
    expect(l).toHaveLength(1);
    expect(l[0]?.path).toEqual(['projects', '/Users/x/y-z', 'trust_level']);
    expect(l[0]?.dotted).toBe('projects."/Users/x/y-z".trust_level');
    expect(l[0]?.value).toBe('trusted');
  });

  it('tables, dotted keys, arrays, inline tables and booleans', () => {
    const text = [
      '# codex',
      'model = "gpt-5"',
      '',
      '[features]',
      'memories = true',
      '',
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-github"]',
      'env = { GITHUB_TOKEN = "${GITHUB_TOKEN}" }',
      '',
      '[profiles.fast]',
      'reasoning.effort = "low"',
      'max_tokens = 1_000',
    ].join('\n');
    expect(byDotted(text)).toEqual({
      model: 'gpt-5',
      'features.memories': true,
      'mcp_servers.github.command': 'npx',
      'mcp_servers.github.args': ['-y', '@modelcontextprotocol/server-github'],
      'mcp_servers.github.env.GITHUB_TOKEN': '${GITHUB_TOKEN}',
      'profiles.fast.reasoning.effort': 'low',
      'profiles.fast.max_tokens': 1000,
    });
  });

  it('array-of-tables keeps its index as a segment, and multi-line arrays parse', () => {
    const l = leaves('[[rule]]\nname = "a"\n\n[[rule]]\nname = "b"\npaths = [\n  "x",\n  "y",\n]\n');
    expect(l.map((x) => x.dotted)).toEqual(['rule.0.name', 'rule.1.name', 'rule.1.paths']);
    expect(l[2]?.value).toEqual(['x', 'y']);
  });

  it('literal, multi-line and escaped strings, floats and dates', () => {
    const v = byDotted(['a = \'raw \\n not escaped\'', 'b = """', 'two', 'lines', '"""', 'c = 1.5', 'd = 2026-09-21T12:00:00Z'].join('\n'));
    expect(v['a']).toBe('raw \\n not escaped');
    expect(v['b']).toBe('two\nlines\n');
    expect(v['c']).toBe(1.5);
    expect(v['d']).toBe('2026-09-21T12:00:00Z');
  });

  it('a malformed line costs a warning, not the document; a hopeless document is {ok:false}', () => {
    const r = parseToml('good = 1\nthis is not toml\nalso_good = 2\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((l) => l.dotted)).toEqual(['good', 'also_good']);
    expect(r.warnings).toEqual(['line 2 not parsed']);
    expect(parseToml('!!!! nonsense\n???').ok).toBe(false);
  });

  it('never throws', () => {
    expect(() => parseToml('[unclosed\nx = "y')).not.toThrow();
    expect(() => parseToml('')).not.toThrow();
  });
});

describe('dottedPath', () => {
  it('quotes only the segments that need it', () => {
    expect(dottedPath(['a', 'b-c', 'd'])).toBe('a.b-c.d');
    expect(dottedPath(['projects', '/Users/x/y'])).toBe('projects."/Users/x/y"');
  });
});
