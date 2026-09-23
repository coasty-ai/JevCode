/** `edit_file` matching (docs/AGENT-LOOP-DESIGN.md §4.5): the cascade, re-indentation, the guards and the errors. */
import { describe, expect, it } from 'vitest';
import { closestWindow, editResultLine, matchEdit, placeholderLine, unescapeModelText, type EditMatch } from '../../../src/agent/tools/edit-match.js';

function ok(m: EditMatch): Extract<EditMatch, { ok: true }> {
  if (!m.ok) throw new Error(`expected a match, got: ${m.error}`);
  return m;
}

const edit = (content: string, oldString: string, newString: string, replaceAll = false): EditMatch => matchEdit(content, { path: 'f', oldString, newString, replaceAll });

describe('trivial errors and the placeholder guard', () => {
  it('identical strings and an empty old_string are INVALID ARGUMENTS', () => {
    expect(edit('abc', 'b', 'b')).toEqual({ ok: false, error: 'INVALID ARGUMENTS for edit_file: new_string is identical to old_string' });
    expect(edit('abc', '', 'x')).toEqual({ ok: false, error: 'INVALID ARGUMENTS for edit_file: old_string is empty; use write_file to create a file or replace a whole file' });
  });

  it.each(['// ... rest of the code unchanged', '# ... existing code', '/* ... remaining methods */', '<!-- ... same as before -->', '    // ...rest unchanged'])('refuses a placeholder: %s', (line) => {
    expect(edit('a\nb\n', 'b', `x\n${line}\n`)).toEqual({ ok: false, error: `ERROR: new_string contains a placeholder ("${line.trim()}"); write the complete code` });
  });

  it('allows a bare `...` (valid Python) and a placeholder-looking comment the file already had', () => {
    expect(placeholderLine('def f():\n    ...\n')).toBeNull();
    expect(ok(edit('x = 1\n# ... rest unchanged\n', 'x = 1', 'x = 2')).action).toEqual({ kind: 'edit', old: 'x = 1', new: 'x = 2' });
    expect(placeholderLine('# ... rest unchanged\ny', '# ... rest unchanged')).toBeNull();
  });
});

describe('exact matching', () => {
  it('one occurrence is an exact edit with the replacement lines', () => {
    const m = ok(edit('a\nb\nc\n', 'b', 'B1\nB2'));
    expect(m.action).toEqual({ kind: 'edit', old: 'b', new: 'B1\nB2' });
    expect(m.lines).toEqual([2, 3]);
    expect(m.how).toBeNull();
    expect(editResultLine('f', m)).toBe('OK: edited f (1 replacement, lines 2-3)');
  });

  it('several occurrences without replace_all name their lines', () => {
    expect(edit('x\ny\nx\ny\nx\n', 'x', 'z')).toEqual({ ok: false, error: 'ERROR: old_string matches 3 places in f (lines 1, 3, 5); include more surrounding lines or set replace_all' });
  });

  it('replace_all with several occurrences becomes a whole-file write', () => {
    const m = ok(edit('x\ny\nx\n', 'x', 'z', true));
    expect(m.action).toEqual({ kind: 'write', content: 'z\ny\nz\n' });
    expect(m.replacements).toBe(2);
    expect(editResultLine('f', m)).toBe('OK: edited f (2 replacements)');
  });

  it('replace_all with one occurrence stays a plain edit', () => {
    expect(ok(edit('x\ny\n', 'x', 'z', true)).action).toEqual({ kind: 'edit', old: 'x', new: 'z' });
  });

  it('a CRLF file compares CRLF and gets CRLF back', () => {
    const m = ok(edit('one\r\ntwo\r\nthree\r\n', 'two\nthree', 'TWO\nTHREE'));
    expect(m.action).toEqual({ kind: 'edit', old: 'two\r\nthree', new: 'TWO\r\nTHREE' });
    expect(m.newContent).toBe('one\r\nTWO\r\nTHREE\r\n');
  });

  it('keeps a leading BOM', () => {
    const m = ok(edit('\uFEFFfirst\nsecond\n', 'first', 'FIRST'));
    expect(m.newContent).toBe('\uFEFFFIRST\nsecond\n');
    expect(m.action).toEqual({ kind: 'edit', old: 'first', new: 'FIRST' });
  });
});

describe('fallback matchers', () => {
  const PY = 'class A:\n    def f(self):\n        if x:\n            return 1\n        return 2\n';

  it('line-trimmed: a mis-indented Python block is found and new_string re-indented', () => {
    const m = ok(edit(PY, 'if x:\n    return 1', 'if x:\n    return 3\nelse:\n    pass'));
    expect(m.how).toBe('indentation');
    expect(m.reindent).toBe(8);
    expect(m.action).toEqual({ kind: 'edit', old: '        if x:\n            return 1', new: '        if x:\n            return 3\n        else:\n            pass' });
    expect(editResultLine('a.py', m)).toBe('OK: edited a.py (1 replacement, lines 3-6) (matched after normalising indentation; new_string re-indented by 8)');
  });

  it('line-trimmed: trailing whitespace differences report whitespace', () => {
    const m = ok(edit('a = 1   \nb = 2\n', 'a = 1\nb = 2', 'a = 3\nb = 4'));
    expect(m.how).toBe('whitespace');
    expect(m.newContent).toBe('a = 3\nb = 4\n');
  });

  it('indentation-flexible wins where line-trimmed is ambiguous', () => {
    // both windows match trimmed, but only one keeps the relative indentation of old_string
    const content = 'if a:\n    x\nif a:\nx\n';
    const m = ok(edit(content, '  if a:\n      x', '  if b:\n      x'));
    expect(m.how).toBe('indentation');
    expect(m.newContent).toBe('if b:\n    x\nif a:\nx\n');
  });

  it('whitespace-normalised: runs of whitespace inside a line', () => {
    const m = ok(edit('x = foo(a,  b)\ny = 2\n', 'foo(a, b)', 'foo(a, c)'));
    expect(m.how).toBe('whitespace');
    expect(m.action).toEqual({ kind: 'edit', old: 'foo(a,  b)', new: 'foo(a, c)' });
  });

  it('whitespace-normalised: a call the model wrote on one line that the file wraps', () => {
    const m = ok(edit('call(alpha,\n     beta)\n', 'call(alpha, beta)', 'call(alpha, gamma)'));
    expect(m.newContent).toBe('call(alpha, gamma)\n');
  });

  it('escape-normalised: double-escaped newlines and quotes, applied to new_string too', () => {
    const m = ok(edit('print("hi")\nline2\n', 'print(\\"hi\\")\\nline2', 'print(\\"yo\\")\\nline2'));
    expect(m.how).toBe('escapes');
    expect(m.action).toEqual({ kind: 'edit', old: 'print("hi")\nline2', new: 'print("yo")\nline2' });
    expect(unescapeModelText('a\\tb\\\\c')).toBe('a\tb\\c');
  });

  it('the disproportion guard refuses a loose span far larger than old_string', () => {
    const r = edit('alpha\n\n\n\n\n\n\nbeta\n', 'alpha beta', 'x');
    expect(r).toEqual({ ok: false, error: 'ERROR: old_string only loosely matches f, over a much larger span than old_string; Re-read the file with read_file and copy old_string exactly (without the line-number prefix).' });
  });

  it('a fallback span whose exact text repeats elsewhere is applied as a whole-file write', () => {
    // the trimmed match is unique as a line window, but its text `foo()` also occurs inside `xfoo()`
    const m = ok(edit('foo()\nxfoo()\n', '  foo()', 'bar()'));
    expect(m.action).toEqual({ kind: 'write', content: 'bar()\nxfoo()\n' });
    expect(m.reindent).toBe(-2);
  });

  it('an ambiguous fallback names the lines', () => {
    const r = edit('  a\n  b\n    a\n    b\n', 'a\nb', 'c\nd');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('ERROR: old_string matches 2 places in f (lines 1, 3); include more surrounding lines or set replace_all');
  });
});

describe('no match', () => {
  it('answers with the closest window, numbered, when it is similar enough', () => {
    const r = edit('def foo():\n    return compute_value(1)\n\ndef bar():\n    pass\n', 'def foo():\n    return compute_valu(2)', 'x');
    expect(r).toEqual({
      ok: false,
      error: 'ERROR: old_string not found in f. Closest match at lines 1-2:\n     1\tdef foo():\n     2\t    return compute_value(1)\nRe-read the file with read_file and copy old_string exactly (without the line-number prefix).',
    });
  });

  it('says only "not found" when nothing is close', () => {
    expect(edit('completely\ndifferent\n', 'zzz qqq', 'x')).toEqual({ ok: false, error: 'ERROR: old_string not found in f. Re-read the file with read_file and copy old_string exactly (without the line-number prefix).' });
    expect(closestWindow('abc\n', 'xyz')).toBeNull();
  });
});
