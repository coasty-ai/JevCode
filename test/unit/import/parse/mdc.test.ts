/** import/parse/mdc.ts (IMPORT-DESIGN §4.3, §2.5; §6 row 19): Cursor .mdc and the trigger table. */
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../../../src/import/parse/frontmatter.js';
import { mdcTrigger, parseMdc } from '../../../../src/import/parse/mdc.js';

function fm(text: string) {
  const r = parseFrontmatter(text);
  return r.ok ? r.value : null;
}

describe('parseMdc', () => {
  it('parses frontmatter plus body', () => {
    const r = parseMdc('---\ndescription: use pnpm\nglobs: "*.ts"\nalwaysApply: false\n---\n# Rule\n\nUse pnpm.\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.frontmatter?.keys).toEqual(['description', 'globs', 'alwaysApply']);
    expect(r.value.doc.headings).toEqual(['Rule']);
    expect(r.warnings).toEqual([]);
  });

  it('§6 row 19: no frontmatter — body still imported, trigger manual, one warning, never a throw', () => {
    const r = parseMdc('# Just a body\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual(['frontmatter unparsable: no frontmatter']);
    expect(r.value.doc.headings).toEqual(['Just a body']);
    expect(mdcTrigger(r.value.frontmatter)).toEqual({ trigger: 'manual', paths: [] });
  });

  it('§6 row 19: a broken frontmatter block — body still imported with the warning', () => {
    const r = parseMdc('---\ndescription: x\nthis is not a mapping\n---\nbody\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings[0]).toBe('frontmatter unparsable: line 3 not parsed');
    expect(r.value.doc.text).toContain('body');
  });

  it('an unterminated block does not lose the body', () => {
    const r = parseMdc('---\ndescription: x\n# body with no close\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.doc.text).toContain('# body with no close');
  });
});

describe('mdcTrigger — the §2.5 table', () => {
  it('Cursor: alwaysApply: true ⇒ always; the string "true" counts', () => {
    expect(mdcTrigger(fm('---\nalwaysApply: true\n---\n'))).toEqual({ trigger: 'always', paths: [] });
    expect(mdcTrigger(fm('---\nalwaysApply: "true"\n---\n'))).toEqual({ trigger: 'always', paths: [] });
  });

  it('Cursor: globs ⇒ paths, as a string or a list; description only ⇒ manual', () => {
    expect(mdcTrigger(fm('---\nglobs: "*.ts,*.tsx"\nalwaysApply: false\n---\n'))).toEqual({ trigger: 'paths', paths: ['*.ts', '*.tsx'] });
    expect(mdcTrigger(fm('---\nglobs:\n  - "src/**"\n---\n'))).toEqual({ trigger: 'paths', paths: ['src/**'] });
    expect(mdcTrigger(fm('---\ndescription: pick me when relevant\n---\n'))).toEqual({ trigger: 'manual', paths: [] });
  });

  it('Claude rules: paths: present ⇒ paths', () => {
    expect(mdcTrigger(fm('---\npaths:\n  - "src/loop/**/*.ts"\n---\n'))).toEqual({ trigger: 'paths', paths: ['src/loop/**/*.ts'] });
  });

  it('Windsurf: always_on / glob+globs / model_decision', () => {
    expect(mdcTrigger(fm('---\ntrigger: always_on\n---\n'))).toEqual({ trigger: 'always', paths: [] });
    expect(mdcTrigger(fm('---\ntrigger: glob\nglobs: "*.py"\n---\n'))).toEqual({ trigger: 'paths', paths: ['*.py'] });
    expect(mdcTrigger(fm('---\ntrigger: model_decision\ndescription: when testing\n---\n'))).toEqual({ trigger: 'manual', paths: [] });
    expect(mdcTrigger(fm('---\ntrigger: glob\n---\n'))).toEqual({ trigger: 'manual', paths: [] });
  });

  it('Copilot: applyTo is comma-separated globs', () => {
    expect(mdcTrigger(fm('---\napplyTo: "**/*.ts,**/*.tsx"\n---\n'))).toEqual({ trigger: 'paths', paths: ['**/*.ts', '**/*.tsx'] });
  });

  it('no frontmatter at all ⇒ manual (the bare .cursorrules case is the caller’s to promote)', () => {
    expect(mdcTrigger(null)).toEqual({ trigger: 'manual', paths: [] });
  });
});
