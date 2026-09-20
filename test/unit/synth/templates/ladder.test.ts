/**
 * Ladder tasks (bench/data/ladder) whose gold fix is one template application: `profiles`
 * (None guard with the same-receiver alternative), `stats` (empty-sequence raise copied from a
 * sibling with the function name substituted), `tagcloud` (import of an unbound name after the
 * last import) and `table` (a parameter with its default added to `pad`, the body literal
 * rewritten to use it, and the caller in another file passing it through). Multi-edit
 * candidates must apply through py/edits and produce a diff `git apply --check` accepts.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../../../src/synth/py/index.js';
import { createTemplateSource } from '../../../../src/synth/templates/index.js';
import { LADDER, applyCandidate, compileFailures, gitApplyCheck, insertSite, norm, options, replaceSite, sourceFile, sourceFromText } from './helpers.js';

const source = createTemplateSource();
const task = (name: string, file: string, dir: 'src' | 'gold' = 'src') => sourceFile(`src/${file}`, join(LADDER, name, dir, file));

describe('template source on the ladder tasks', () => {
  it('profiles: guards the None nickname and returns the other attribute of the same receiver', () => {
    const file = task('profiles', 'profiles.py');
    const cands = source.enumerate(replaceSite(file, 20), options());
    const want = '    if user.nickname is None:\n        return user.full_name\n    nick = user.nickname.strip()';
    const hit = cands.find((c) => c.text === want);
    expect(hit, cands.slice(0, 10).map((c) => c.text).join('\n---\n')).toBeDefined();
    expect(hit!.op).toBe('guard_none_return_alt_before');
    // the guard ranks in the first handful: it is the None-guard idiom on the line's own attribute
    expect(cands.indexOf(hit!)).toBeLessThan(5);
    // the applied file is the gold file
    expect(applyCandidate(hit!)).toBe(task('profiles', 'profiles.py', 'gold').src);
    // the return-type default is offered too
    expect(cands.some((c) => c.text === '    if user.nickname is None:\n        return ""\n    nick = user.nickname.strip()')).toBe(true);
  });

  it('stats: raises on an empty sequence with the sibling message renamed to this function', () => {
    const file = task('stats', 'stats.py');
    const cands = source.enumerate(insertSite(file, 18, 4), options());
    const want = '    if not values:\n        raise ValueError("median of empty sequence")';
    const hit = cands.find((c) => c.text === want);
    expect(hit, cands.slice(0, 10).map((c) => c.text).join('\n---\n')).toBeDefined();
    expect(hit!.op).toBe('guard_empty_raise');
    expect(cands.indexOf(hit!)).toBeLessThan(6);
    expect(applyCandidate(hit!)).toBe(task('stats', 'stats.py', 'gold').src);
    // no donor message is copied verbatim with the wrong function name
    expect(cands.some((c) => c.text.includes('"mean of empty sequence"'))).toBe(false);
  });

  it('tagcloud: imports the unbound name after the last import via extraEdits, and inline at the import site', () => {
    const file = task('tagcloud', 'tagcloud.py');
    const site = replaceSite(file, 28);
    const cands = source.enumerate(site, options());
    const hit = cands.find((c) => c.op === 'import_insert_top' && c.extraEdits?.some((e) => e.text === 'from collections import Counter'));
    expect(hit).toBeDefined();
    expect(hit!.text).toBe(site.currentLine);
    expect(hit!.extraEdits).toEqual([{ path: 'src/tagcloud.py', line: 8, kind: 'insert', text: 'from collections import Counter' }]);
    expect(cands.indexOf(hit!)).toBe(0);
    const after = applyCandidate(hit!);
    expect(after.split('\n')[7]).toBe('from collections import Counter');
    expect(after.split('\n')[2]).toBe('from __future__ import annotations');
    expect(compileFailures([{ id: 'tagcloud', src: after }])).toEqual([]);
    const diff = unifiedDiff('src/tagcloud.py', file.src, after);
    expect(gitApplyCheck(new Map([['src/tagcloud.py', file.src]]), diff).ok).toBe(true);
    // a local import before the failing statement is offered at lower prior
    const local = cands.find((c) => c.op === 'import_insert_local');
    expect(local?.text).toBe('    from collections import Counter\n    counts: Counter = Counter()');
    expect(local!.prior!).toBeLessThan(hit!.prior!);
    // at the import position itself the import is the inserted line
    const top = source.enumerate(insertSite(file, 8, 0), options());
    expect(top.some((c) => c.text === 'from collections import Counter' && c.extraEdits === undefined)).toBe(true);
  });

  it('table: adds the sibling parameter with its default to `pad` and rewrites the body literal', () => {
    const fmt = task('table', 'fmt.py');
    const cands = source.enumerate(replaceSite(fmt, 6), options());
    const header = 'def pad(text: str, width: int, fill: str = " ") -> str:';
    const withBody = cands.find((c) => c.text === header && c.op === 'add_param_sibling_with_edits');
    expect(withBody, cands.map((c) => c.text).join('\n')).toBeDefined();
    expect(withBody!.extraEdits).toEqual([{ path: 'src/fmt.py', line: 10, kind: 'replace', text: '    return text + fill * (width - len(text))' }]);
    const after = applyCandidate(withBody!);
    expect(after).toBe(task('table', 'fmt.py', 'gold').src);
    const diff = unifiedDiff('src/fmt.py', fmt.src, after);
    expect(diff).toContain('+def pad(text: str, width: int, fill: str = " ") -> str:');
    expect(gitApplyCheck(new Map([['src/fmt.py', fmt.src]]), diff).ok).toBe(true);
    // the signature-only variant exists as well, ranked below the complete one
    const alone = cands.find((c) => c.text === header && c.op === 'add_param_sibling');
    expect(alone).toBeDefined();
    expect(alone!.prior!).toBeLessThan(withBody!.prior!);
  });

  it('table: the caller passes `fill` through, found from the sibling call with the same leading arguments', () => {
    const fmt = task('table', 'fmt.py');
    const tbl = task('table', 'table.py');
    const cands = source.enumerate(replaceSite(tbl, 43), options({ corpus: new Map([['src/fmt.py', fmt]]) }));
    const hit = cands.find((c) => norm(c.text) === 'cells.append(pad(cell, width, fill))');
    expect(hit).toBeDefined();
    expect(hit!.op).toBe('call_add_arg_sibling');
    expect(applyCandidate(hit!)).toBe(task('table', 'table.py', 'gold').src);
    // without a sibling call to copy from, the callee's definition in the corpus proposes its unfilled parameter
    const goldFmt = task('table', 'fmt.py', 'gold');
    const caller = sourceFromText('src/use.py', 'from .fmt import pad\n\n\ndef render(cell, width, fill):\n    return pad(cell, width)\n');
    const viaDef = source.enumerate(replaceSite(caller, 5), options({ corpus: new Map([['src/fmt.py', goldFmt]]) }));
    expect(viaDef.some((c) => c.op === 'call_add_arg_param' && norm(c.text) === 'return pad(cell, width, fill)')).toBe(true);
  });

  it('events: the misspelt dataclass attribute is replaced by the field of the class whose other fields the receiver uses', () => {
    const file = task('events', 'events.py');
    const line = file.mod.lines.findIndex((l) => l.includes('event.end_at')) + 1;
    expect(line).toBeGreaterThan(0);
    const cands = source.enumerate(replaceSite(file, line), options());
    const buggy = file.mod.lines[line - 1]!;
    const hit = cands.find((c) => c.text === buggy.replace('event.end_at', 'event.ends_at'));
    expect(hit).toBeDefined();
    expect(hit!.op).toBe('attr_subst');
    expect(applyCandidate(hit!)).toBe(task('events', 'events.py', 'gold').src);
  });
});
