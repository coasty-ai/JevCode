/**
 * The import family on general fixtures (the ladder `tagcloud` case is in ladder.test.ts): a
 * repo-local definition found through the corpus scope tables (relative import for a sibling,
 * dotted path otherwise), a corpus file's own import copied verbatim, the standard-library table
 * with its second-choice modules and `import x` for a module used as a receiver, the
 * module-level import gap (`atImportGap`) versus a gap inside a function, and the tables'
 * internal consistency.
 */
import { describe, expect, it } from 'vitest';
import { FAMILY_PRIOR, STDLIB_MODULES, STDLIB_NAMES, STDLIB_NAMES_ALT, atImportGap, buildContext, createTemplateSource } from '../../../../src/synth/templates/index.js';
import { applyCandidate, compileFailures, insertSite, options, replaceSite, sourceFromText } from './helpers.js';

const source = createTemplateSource();

describe('import template on general fixtures', () => {
  it('a sibling module that defines the missing name: `from .util import slugify` at the import gap, applied and compiled', () => {
    const util = sourceFromText('src/util.py', 'def slugify(s: str) -> str:\n    return s.lower()\n');
    const app = sourceFromText('src/app.py', '"""App."""\n\nimport os\n\n\ndef title(s):\n    return slugify(s).title()\n');
    const corpus = new Map([[util.path, util], [app.path, app]]);
    // the gap after `import os` (L3) is L4
    const gap = insertSite(app, 4, 0);
    expect(atImportGap(buildContext(gap, options({ corpus })))).toBe(true);
    const cands = source.enumerate(gap, options({ corpus }));
    expect(cands.map((c) => c.text)).toEqual(['from .util import slugify']);
    expect(cands[0]).toMatchObject({ op: 'import_insert', source: 'template' });
    expect(cands[0]!.prior).toBeCloseTo(FAMILY_PRIOR.import * 0.9, 6);
    const after = applyCandidate(cands[0]!);
    expect(after.split('\n').slice(0, 5)).toEqual(['"""App."""', '', 'import os', 'from .util import slugify', '']);
    expect(compileFailures([{ id: 'app', src: after }])).toEqual([]);
    // at the use line the same import rides as an extra edit at the import line
    const atUse = source.enumerate(replaceSite(app, 7), options({ corpus })).find((c) => c.op === 'import_insert_top')!;
    expect(atUse.extraEdits).toEqual([{ path: 'src/app.py', line: 4, kind: 'insert', text: 'from .util import slugify' }]);
    expect(atUse.text).toBe('    return slugify(s).title()');
  });

  it('a definition in another directory is imported by its dotted path; a corpus import of the same name is the same text, once', () => {
    const text = sourceFromText('lib/text.py', 'def slugify(s):\n    return s\n');
    const other = sourceFromText('src/other.py', 'from lib.text import slugify\n\nx = slugify("a")\n');
    // no imports: the gap is after the docstring (L2)
    const app = sourceFromText('src/app.py', '"""Titles."""\n\n\ndef title(s):\n    return slugify(s)\n');
    const corpus = new Map([[text.path, text], [other.path, other], [app.path, app]]);
    const cands = source.enumerate(insertSite(app, 2, 0), options({ corpus }));
    expect(cands.map((c) => c.text)).toEqual(['from lib.text import slugify']);
    // the verbatim copy of another file's import (0.95) wins the dedupe over the derived path (0.9)
    expect(cands[0]!.prior).toBeCloseTo(FAMILY_PRIOR.import * 0.95, 6);
    // a different import of the name elsewhere in the corpus is offered too, lower
    const alias = sourceFromText('src/third.py', 'from vendor.slugs import slugify\n');
    const more = source.enumerate(insertSite(app, 2, 0), options({ corpus: new Map([...corpus, [alias.path, alias]]) }));
    expect(more.map((c) => c.text)).toEqual(['from lib.text import slugify', 'from vendor.slugs import slugify']);
  });

  it('standard library: the first-choice module, `import x` for a module used as a receiver, then the second-choice module', () => {
    const app = sourceFromText('m.py', '"""Waiting."""\n\n\ndef wait(n):\n    sleep(n)\n    return json.dumps(n)\n');
    const cands = source.enumerate(insertSite(app, 2, 0), options());
    expect(cands.map((c) => [c.text, c.op])).toEqual([
      ['from time import sleep', 'import_insert'],
      ['import json', 'import_insert'],
      ['from asyncio import sleep', 'import_insert'],
    ]);
    expect(cands.map((c) => c.prior)).toEqual([FAMILY_PRIOR.import, FAMILY_PRIOR.import * 0.9, FAMILY_PRIOR.import * 0.8]);
    expect(compileFailures(cands.map((c) => ({ id: c.id, src: applyCandidate(c) })))).toEqual([]);
  });

  it('at the import gap the most-used unbound name comes first; elsewhere the name nearest the site does', () => {
    const app = sourceFromText('m.py', 'import os\n\n\ndef f(xs):\n    return sqrt(sum(xs))\n\n\ndef g(xs):\n    d = defaultdict(int)\n    e = defaultdict(list)\n    return d, e, defaultdict\n');
    const gap = source.enumerate(insertSite(app, 2, 0), options()).map((c) => c.text);
    expect(gap).toEqual(['from collections import defaultdict', 'from math import sqrt']);
    // beside `sqrt` the nearby name leads, the far one follows at the 0.7 locality factor
    const near = source.enumerate(replaceSite(app, 5), options()).filter((c) => c.op === 'import_insert_top');
    expect(near.map((c) => c.extraEdits![0]!.text)).toEqual(['from math import sqrt', 'from collections import defaultdict']);
    expect(near[1]!.prior).toBeCloseTo(near[0]!.prior! * 0.7, 6);
  });

  it('a gap inside a function gets the indented import at a lower prior than the module gap; atImportGap is false there and at replace sites', () => {
    const app = sourceFromText('m.py', 'import os\n\n\ndef f(xs):\n    total = sum(xs)\n    return sqrt(total)\n');
    const top = source.enumerate(insertSite(app, 2, 0), options()).find((c) => c.text === 'from math import sqrt')!;
    const inFn = source.enumerate(insertSite(app, 6, 4), options()).find((c) => c.text === '    from math import sqrt')!;
    expect(inFn.op).toBe('import_insert_local');
    expect(inFn.prior!).toBeLessThan(top.prior!);
    expect(compileFailures([{ id: 'local', src: applyCandidate(inFn) }])).toEqual([]);
    expect(atImportGap(buildContext(insertSite(app, 6, 4), options()))).toBe(false);
    expect(atImportGap(buildContext(insertSite(app, 1, 0), options()))).toBe(false); // before `import os`, not after it
    expect(atImportGap(buildContext(replaceSite(app, 6), options()))).toBe(false);
    // a module-level gap that is not the import line still gets the import, as a plain module-level line
    const before = source.enumerate(insertSite(app, 1, 0), options()).find((c) => c.text === 'from math import sqrt')!;
    expect(before.op).toBe('import_insert_local');
    expect(before.prior!).toBeLessThan(top.prior!);
  });

  it('nothing to import, nothing offered: a file whose every name is bound yields no import candidate', () => {
    const app = sourceFromText('m.py', 'import os\n\n\ndef f(xs):\n    return os.path.join(*xs)\n');
    expect(source.enumerate(insertSite(app, 2, 0), options())).toEqual([]);
  });

  it('the tables are consistent: first choices live in standard-library modules, second choices never repeat the first', () => {
    for (const [name, mod] of Object.entries(STDLIB_NAMES)) {
      expect(STDLIB_MODULES.has(mod.split('.')[0]!), `${name}: ${mod}`).toBe(true);
      expect(name).toMatch(/^[A-Za-z_]\w*$/);
    }
    for (const [name, alts] of Object.entries(STDLIB_NAMES_ALT)) {
      expect(alts.length).toBeGreaterThan(0);
      for (const a of alts) {
        expect(a, name).not.toBe(STDLIB_NAMES[name]);
        expect(STDLIB_MODULES.has(a.split('.')[0]!), `${name}: ${a}`).toBe(true);
      }
    }
    expect(STDLIB_NAMES['Counter']).toBe('collections');
    expect(STDLIB_NAMES_ALT['Counter']).toEqual(['typing']);
  });
});
