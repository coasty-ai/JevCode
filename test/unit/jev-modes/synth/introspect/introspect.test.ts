/**
 * Unit tests of src/jev-modes/synth/introspect: the script builder (repro script + pass, sentinel), the
 * output parser, the caps of `namesFromRaw` (≤ 400 names, receiver first, falsy predicates
 * first), the dispatch-prefix reader, the composed alias names, the per-run facts registry, and
 * one real `python3` run on a tiny workspace whose failing call has `is_*` properties and a
 * class hierarchy to introspect (skipped when python3 is missing).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTES_MAX, CLASSES_MAX, INTROSPECT_NAMES_MAX, INTROSPECT_SENTINEL, MODULE_NAMES_MAX, PREDICATES_MAX, buildIntrospectScript, classMethodPrefixes, clearRunFacts, composedAliasNames, emptyIntrospection, introspectRepro, introspectedNamesFlat, namesFromRaw, parseIntrospectOutput, runFacts, setRunFacts, vocabularyAdditions } from '../../../../../src/jev-modes/synth/introspect/index.js';
import type { RawIntrospection } from '../../../../../src/jev-modes/synth/introspect/index.js';
import { REPRO_SENTINEL } from '../../../../../src/jev-modes/synth/oracle/runner.js';
import { analyse } from '../../../../../src/jev-modes/synth/py/index.js';
import type { VerifyRunFn } from '../../../../../src/jev-modes/synth/verify/types.js';

const pythonAvailable = spawnSync('python3', ['-c', 'import sys'], { encoding: 'utf8' }).status === 0;

describe('script and parser', () => {
  it('the introspection script is the repro script plus the pass, both sentinels present, anchors embedded', () => {
    const script = buildIntrospectScript(['x = 1', 'x + 1'], { workspace: '/w', packageName: null }, [{ file: '/home/u/pkg/mod.py', line: 12, fn: 'f' }]);
    expect(script).toContain(`SENTINEL = ${JSON.stringify(REPRO_SENTINEL)}`);
    expect(script).toContain(`ISENT = ${JSON.stringify(INTROSPECT_SENTINEL)}`);
    // the anchors travel JSON-in-JSON like the runner's own constants
    expect(script).toContain('ANCHORS = json.loads(');
    expect(script).toContain('mod.py');
    expect(script.indexOf('def run_chunk')).toBeLessThan(script.indexOf('def _introspect()'));
  });

  it('parseIntrospectOutput reads the last sentinel line; missing or broken gives null', () => {
    const raw: RawIntrospection = { ok: true, operands: [{ expr: 'a.b', type: 'T', mro: ['T', 'Base'], preds: ['is_x'], falsy: ['is_x'], attrs: ['foo'], frame: null, receiver: true }], module: 'm', module_names: ['g'] };
    expect(parseIntrospectOutput(`${REPRO_SENTINEL}{"ok":true,"results":[]}\n${INTROSPECT_SENTINEL}${JSON.stringify(raw)}\n`)).toEqual(raw);
    expect(parseIntrospectOutput('nothing')).toBeNull();
    expect(parseIntrospectOutput(`${INTROSPECT_SENTINEL}{oops`)).toBeNull();
    expect(parseIntrospectOutput(`${INTROSPECT_SENTINEL}[1,2]`)).toBeNull();
  });
});

describe('namesFromRaw', () => {
  it('puts the raising receiver first, falsy predicates first, drops non-identifiers, caps every list and the total at 400', () => {
    const many = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    const raw: RawIntrospection = {
      ok: true,
      target: 'f(x)',
      frames: [{ path: 'pkg/a.py', line: 3, fn: 'f', code: 'return x.g' }, { path: null, line: 1, fn: '<module>', code: null }],
      operands: [
        { expr: 'x', type: 'Outer', mro: ['Outer', 'Mid', 'Base'], preds: ['is_a', 'is_b', 'is_c'], falsy: ['is_c'], attrs: many('attr', 100), frame: { path: 'pkg/a.py', line: 3, fn: 'f', code: 'return x.g' }, receiver: false },
        { expr: 'x.g', type: 'Inner', mro: many('Cls', 70), preds: many('is_p', 130), falsy: many('is_p', 5), attrs: many('other', 100), frame: { path: 'pkg/a.py', line: 3, fn: 'f', code: 'return x.g' }, receiver: true },
        { expr: 'bad-name', type: 'T', mro: ['not a name!'], preds: [], falsy: [], attrs: [], frame: null, receiver: false },
      ],
      module: 'pkg.a',
      module_names: many('mod', 90),
    };
    const names = namesFromRaw(raw, 12);
    expect(names.status).toBe('ran');
    expect(names.durationMs).toBe(12);
    expect(names.target).toBe('f(x)');
    expect(names.moduleName).toBe('pkg.a');
    expect(names.frames).toEqual([{ path: 'pkg/a.py', line: 3, fn: 'f', code: 'return x.g' }]);
    expect(names.operands.map((o) => o.expr)).toEqual(['x.g', 'x', 'bad-name']);
    expect(names.operands[0]!.raisingReceiver).toBe(true);
    expect(names.operands[0]!.classes).toEqual(['not a name!'].filter(() => false).concat(many('Cls', 70)));
    expect(names.operands[1]!.predicates).toEqual(['is_c', 'is_a', 'is_b']);
    expect(names.operands[1]!.falsyPredicates).toEqual(['is_c']);
    expect(names.operands[2]!.classes).toEqual([]);
    expect(names.classes.length).toBeLessThanOrEqual(CLASSES_MAX);
    expect(names.classes[0]).toBe('Cls0');
    expect(names.predicates.length).toBeLessThanOrEqual(PREDICATES_MAX);
    expect(names.predicates.slice(0, 5)).toEqual(many('is_p', 5));
    expect(names.attributes.length).toBeLessThanOrEqual(ATTRIBUTES_MAX);
    expect(names.moduleNames.length).toBeLessThanOrEqual(MODULE_NAMES_MAX);
    expect(names.classes.length + names.predicates.length + names.attributes.length + names.moduleNames.length).toBeLessThanOrEqual(INTROSPECT_NAMES_MAX);
    expect(introspectedNamesFlat(names).length).toBeLessThanOrEqual(INTROSPECT_NAMES_MAX);
  });

  it('a failed pass without operands is no_target; emptyIntrospection carries the status and note', () => {
    expect(namesFromRaw({ ok: false, note: 'no statement to introspect' }, 3).status).toBe('no_target');
    expect(emptyIntrospection('timeout', 'slow', 7)).toMatchObject({ status: 'timeout', note: 'slow', durationMs: 7, classes: [], operands: [] });
  });
});

describe('dispatch prefixes and composed names', () => {
  const mod = analyse(['class P:', '    def _print_Foo(self, e):', '        return 1', '', '    def _print_Bar(self, e):', '        return 2', '', '    def helper(self):', '        return 3', '', 'class Q:', '    def get_a(self):', '        return 1', '', '    def get_b(self):', '        return 2', '', 'class R:', '    def visit_Call(self, n):', '        pass', '', 'class S:', '    def visit_Name(self, n):', '        pass', '', '    def visit_Attr(self, n):', '        pass', '', '    def visit_x(self, n):', '        pass', ''].join('\n'));

  it('finds the shared CapWord prefix of a class, skips accessor pairs and single methods', () => {
    const found = classMethodPrefixes(mod);
    expect(found.map((p) => [p.className, p.prefix, p.methods.map((m) => m.suffix)])).toEqual([
      ['P', '_print_', ['Foo', 'Bar']],
      ['S', 'visit_', ['Name', 'Attr', 'x']],
    ]);
  });

  it('composes <prefix><Class> for every prefix and class, identifiers only', () => {
    expect(composedAliasNames(mod, ['Baz', 'Qux', 'not ok']).sort()).toEqual(['_print_Baz', '_print_Qux', 'visit_Baz', 'visit_Qux']);
    const names = { ...emptyIntrospection('ran', ''), classes: ['Baz'], predicates: ['is_leaf'], attributes: ['value'], moduleNames: ['helper'] };
    expect(vocabularyAdditions(names, { path: 'p.py', src: mod.src, mod }).sort()).toEqual(['Baz', '_print_Baz', 'helper', 'is_leaf', 'value', 'visit_Baz']);
  });
});

describe('run facts registry', () => {
  it('records, extends, reads and clears per run id', () => {
    clearRunFacts('r1');
    expect(runFacts('r1')).toBeNull();
    const names = emptyIntrospection('ran', 'x');
    setRunFacts('r1', { introspected: names });
    expect(runFacts('r1')).toEqual({ introspected: names, history: null });
    const history = { commits: [], files: [], commands: 0, durationMs: 0, note: '' };
    setRunFacts('r1', { history });
    expect(runFacts('r1')).toEqual({ introspected: names, history });
    clearRunFacts('r1');
    expect(runFacts('r1')).toBeNull();
  });
});

describe.skipIf(!pythonAvailable)('introspectRepro with python3', () => {
  const run: VerifyRunFn = async (command, opts) => {
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeoutMs });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
  };
  const lib = [
    'class Base:',
    '    @property',
    '    def is_ready(self):',
    '        return False',
    '    @property',
    '    def is_named(self):',
    '        return True',
    '    def is_method(self):',
    '        return True',
    '',
    'class Thing(Base):',
    '    def __init__(self):',
    '        self.size = 3',
    '',
    'class Box:',
    '    def __init__(self):',
    '        self.inner = Thing()',
    '',
    'def compare(b):',
    '    return b.inner < 0',
    '',
    'def describe(x):',
    '    return "thing %d" % x.size',
    'HELPER = 1',
    '',
  ].join('\n');

  it('records the operands of the raising frame with MRO, predicates and their truth, the receiver, and the module names', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-introspect-'));
    try {
      writeFileSync(join(ws, 'mylib.py'), lib);
      execFileSync('python3', ['-c', 'import sys'], { encoding: 'utf8' });
      const names = await introspectRepro(run, { chunks: ['from mylib import Box, compare', 'box = Box()', 'compare(box)'], options: { packageName: 'mylib' } }, { workspace: ws, python: 'python3' });
      expect(names.status).toBe('ran');
      expect(names.target).toBe('compare(box)');
      expect(names.frames.map((f) => [f.path, f.fn])).toEqual([['mylib.py', 'compare']]);
      const inner = names.operands.find((o) => o.expr === 'b.inner');
      expect(inner).toBeDefined();
      expect(inner!.classes).toEqual(['Thing', 'Base']);
      expect(inner!.predicates).toEqual(['is_ready', 'is_named']);
      expect(inner!.falsyPredicates).toEqual(['is_ready']);
      expect(inner!.attributes).toContain('is_method');
      expect(inner!.attributes).toContain('size');
      expect(inner!.frame).toMatchObject({ path: 'mylib.py', fn: 'compare', line: 20 });
      expect(inner!.raisingReceiver).toBe(false);
      // the comparison raised inside the interpreter's `<`, so the innermost workspace frame is `compare` and its argument `b` is the receiver; it comes first
      expect(names.operands[0]).toMatchObject({ expr: 'b', raisingReceiver: true, classes: ['Box'] });
      expect(names.classes.slice(0, 3)).toEqual(expect.arrayContaining(['Thing', 'Base', 'Box']));
      expect(names.moduleName).toBe('mylib');
      expect(names.moduleNames).toEqual(expect.arrayContaining(['Base', 'Box', 'Thing', 'compare', 'describe', 'HELPER']));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('for a statement that does not raise, evaluates its sub-expressions in the script namespace and reads the callee module', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-introspect-'));
    try {
      writeFileSync(join(ws, 'mylib.py'), lib);
      const names = await introspectRepro(run, { chunks: ['from mylib import Thing, describe', 'describe(Thing())'], options: { packageName: 'mylib' } }, { workspace: ws, python: 'python3' });
      expect(names.status).toBe('ran');
      expect(names.frames).toEqual([]);
      const thing = names.operands.find((o) => o.expr === 'Thing()');
      expect(thing).toBeDefined();
      expect(thing!.classes).toEqual(['Thing', 'Base']);
      expect(thing!.frame).toBeNull();
      expect(names.moduleName).toBe('mylib');
      expect(names.classes).toContain('Base');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a timeout or a broken interpreter yields an empty result with the status, never a throw', async () => {
    const slow: VerifyRunFn = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    expect((await introspectRepro(slow, { chunks: ['x'], options: { packageName: null } }, { workspace: '/w' })).status).toBe('timeout');
    const broken: VerifyRunFn = async () => ({ stdout: '', stderr: 'no python', exitCode: 127 });
    const r = await introspectRepro(broken, { chunks: ['x'], options: { packageName: null } }, { workspace: '/w' });
    expect(r.status).toBe('error');
    expect(r.note).toContain('no python');
  });
});
