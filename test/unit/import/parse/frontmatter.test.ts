/** import/parse/frontmatter.ts (IMPORT-DESIGN §4.3; §6 rows 22–23): the tolerant YAML subset. */
import { describe, expect, it } from 'vitest';
import { fmBool, fmList, fmString, kindOf, parseFrontmatter } from '../../../../src/import/parse/frontmatter.js';

function fm(text: string) {
  const r = parseFrontmatter(text);
  return r.ok ? r.value : null;
}

describe('parseFrontmatter', () => {
  it('requires `---` on line 1; anything else is "no frontmatter" and never an exception', () => {
    expect(parseFrontmatter('# hello\n---\nname: x\n---\n')).toEqual({ ok: false, error: 'no frontmatter', warnings: [] });
    expect(parseFrontmatter('')).toEqual({ ok: false, error: 'no frontmatter', warnings: [] });
    expect(parseFrontmatter('\n---\nx: 1\n---\n').ok).toBe(false);
  });

  it('parses scalars, lists (block and flow) and exactly one nesting level, keeping key order', () => {
    const v = fm('---\nname: branch-state\ndescription: "what, and why"\ncount: 3\nenabled: true\npaths:\n  - "src/**/*.ts"\n  - docs/**\nglobs: [a.ts, "b, c.ts"]\nmetadata:\n  type: project\n  n: 2\n---\nbody\n');
    expect(v?.keys).toEqual(['name', 'description', 'count', 'enabled', 'paths', 'globs', 'metadata']);
    expect(v?.values['name']).toBe('branch-state');
    expect(v?.values['description']).toBe('what, and why');
    expect(v?.values['count']).toBe(3);
    expect(v?.values['enabled']).toBe(true);
    expect(v?.values['paths']).toEqual(['src/**/*.ts', 'docs/**']);
    expect(v?.values['globs']).toEqual(['a.ts', 'b, c.ts']);
    expect(v?.values['metadata']).toEqual({ type: 'project', n: 2 });
    expect(v?.broken).toBe(false);
  });

  it('bodyOffset points at the first byte after the closing fence', () => {
    const text = '---\nname: x\n---\nthe body\n';
    const v = fm(text);
    expect(text.slice(v?.bodyOffset ?? 0)).toBe('the body\n');
  });

  it('§6 row 19: a block that never closes is broken, keeps nothing, and the whole file is body', () => {
    const r = parseFrontmatter('---\nname: x\nno close here\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.broken).toBe(true);
    expect(r.value.bodyOffset).toBe(0);
    expect(r.warnings).toEqual(['frontmatter block not closed']);
  });

  it('a line that does not parse costs one warning naming the line, never its content', () => {
    const r = parseFrontmatter('---\nname: ok\nthis line is not a mapping\n---\nbody\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.broken).toBe(true);
    expect(r.value.values['name']).toBe('ok');
    expect(r.warnings).toEqual(['line 3 not parsed']);
    expect(r.warnings.join(' ')).not.toContain('not a mapping');
  });

  it('comments and a BOM survive', () => {
    const v = fm('﻿---\n# a comment\nname: x  # trailing\n---\nbody');
    expect(v?.values['name']).toBe('x');
  });
});

describe('kindOf — §6 row 23', () => {
  it('accepts a flat `type:` (the docs) and a nested `metadata.type:` (all 43 real files); neither ⇒ reference', () => {
    expect(kindOf(fm('---\ntype: project\n---\n'))).toBe('project');
    expect(kindOf(fm('---\nmetadata:\n  type: feedback\n---\n'))).toBe('feedback');
    expect(kindOf(fm('---\ntype: user\n---\n'))).toBe('preference');
    expect(kindOf(fm('---\ntype: rule\n---\n'))).toBe('rule');
    expect(kindOf(fm('---\nname: x\n---\n'))).toBe('reference');
    expect(kindOf(null)).toBe('reference');
    expect(kindOf(fm('---\ntype: something-else\n---\n'))).toBe('reference');
  });

  it('a flat type wins over a nested one', () => {
    expect(kindOf(fm('---\ntype: project\nmetadata:\n  type: feedback\n---\n'))).toBe('project');
  });
});

describe('fmBool — §6 row 22, the six spellings Claude skills accept', () => {
  const trues = ['true', 'yes', 'on', '1', '"true"', "'yes'", 'True', '"1"'];
  const falses = ['false', 'no', 'off', '0', '"false"', "'no'", 'OFF', '"0"'];
  it.each(trues)('%s is true', (raw) => {
    expect(fmBool(fm(`---\nalwaysApply: ${raw}\n---\n`), 'alwaysApply')).toBe(true);
  });
  it.each(falses)('%s is false', (raw) => {
    expect(fmBool(fm(`---\nalwaysApply: ${raw}\n---\n`), 'alwaysApply')).toBe(false);
  });
  it('anything else stays a string and fmBool is null', () => {
    expect(fmBool(fm('---\nalwaysApply: maybe\n---\n'), 'alwaysApply')).toBeNull();
    expect(fmString(fm('---\nalwaysApply: maybe\n---\n'), 'alwaysApply')).toBe('maybe');
    expect(fmBool(fm('---\nname: x\n---\n'), 'missing')).toBeNull();
  });
});

describe('fmString / fmList', () => {
  it('fmString reads dotted nested keys and renders scalars', () => {
    const v = fm('---\nmetadata:\n  type: project\n  n: 2\ncount: 7\n---\n');
    expect(fmString(v, 'metadata.type')).toBe('project');
    expect(fmString(v, 'metadata.n')).toBe('2');
    expect(fmString(v, 'count')).toBe('7');
    expect(fmString(v, 'metadata.missing')).toBeNull();
    expect(fmString(null, 'x')).toBeNull();
  });

  it('§3.5 / §3.9: `globs:` and `applyTo:` are accepted as a string or a list', () => {
    expect(fmList(fm('---\nglobs: "*.ts,*.tsx"\n---\n'), 'globs')).toEqual(['*.ts', '*.tsx']);
    expect(fmList(fm('---\nglobs:\n  - "*.ts"\n  - "*.tsx"\n---\n'), 'globs')).toEqual(['*.ts', '*.tsx']);
    expect(fmList(fm('---\nglobs: [*.ts, *.tsx]\n---\n'), 'globs')).toEqual(['*.ts', '*.tsx']);
    expect(fmList(fm('---\napplyTo: "**/*.ts, **/*.tsx"\n---\n'), 'applyTo')).toEqual(['**/*.ts', '**/*.tsx']);
    expect(fmList(fm('---\nname: x\n---\n'), 'globs')).toBeNull();
  });
});
