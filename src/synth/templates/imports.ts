/**
 * Import insertion for a name that is used but bound nowhere (ladder `tagcloud`: `Counter`
 * used in three functions, never imported). The name is resolved through a table of common
 * standard-library names, through corpus files that define it (relative import) or import it
 * (the donor import line copied), or as a module (`import x` when the name is used as
 * `x.attr`). The import goes after the last module-level import (which keeps a
 * `from __future__` line first), so the primary edit is an `extraEdits` insert and the
 * candidate's `text` is the site's line unchanged; at a site inside a function body the
 * import is offered as a local import as well.
 */
import type { LineEdit } from '../types.js';
import type { PyModule } from '../py/structure.js';
import type { Draft, TemplateContext } from './common.js';
import { BUILTIN_SET, FAMILY_PRIOR, currentLineText, isName, isOp, uniq } from './common.js';
import { isKeyword } from '../py/tokenize.js';
import { reindent } from '../py/edits.js';

/** Common `from <module> import <name>` resolutions for standard-library names. */
export const STDLIB_NAMES: Readonly<Record<string, string>> = {
  Counter: 'collections', defaultdict: 'collections', OrderedDict: 'collections', deque: 'collections', namedtuple: 'collections', ChainMap: 'collections',
  dataclass: 'dataclasses', field: 'dataclasses', asdict: 'dataclasses', astuple: 'dataclasses', replace: 'dataclasses',
  Path: 'pathlib', PurePath: 'pathlib',
  datetime: 'datetime', date: 'datetime', timedelta: 'datetime', timezone: 'datetime',
  Enum: 'enum', IntEnum: 'enum', Flag: 'enum', auto: 'enum',
  ABC: 'abc', abstractmethod: 'abc',
  Any: 'typing', Dict: 'typing', List: 'typing', Optional: 'typing', Tuple: 'typing', Set: 'typing', FrozenSet: 'typing', Union: 'typing', Callable: 'typing',
  Iterable: 'typing', Iterator: 'typing', Sequence: 'typing', Mapping: 'typing', MutableMapping: 'typing', TypeVar: 'typing', Generic: 'typing', Protocol: 'typing',
  cast: 'typing', overload: 'typing', NamedTuple: 'typing', TypedDict: 'typing', Literal: 'typing', Final: 'typing', ClassVar: 'typing', Type: 'typing', Deque: 'typing', DefaultDict: 'typing',
  deepcopy: 'copy',
  partial: 'functools', reduce: 'functools', lru_cache: 'functools', wraps: 'functools', cache: 'functools', cached_property: 'functools', total_ordering: 'functools',
  chain: 'itertools', combinations: 'itertools', permutations: 'itertools', product: 'itertools', groupby: 'itertools', islice: 'itertools', accumulate: 'itertools', zip_longest: 'itertools', cycle: 'itertools', repeat: 'itertools', starmap: 'itertools', takewhile: 'itertools', dropwhile: 'itertools',
  contextmanager: 'contextlib', suppress: 'contextlib', closing: 'contextlib', ExitStack: 'contextlib',
  heappush: 'heapq', heappop: 'heapq', heapify: 'heapq', nlargest: 'heapq', nsmallest: 'heapq',
  bisect_left: 'bisect', bisect_right: 'bisect', insort: 'bisect',
  sqrt: 'math', floor: 'math', ceil: 'math', inf: 'math', pi: 'math', isclose: 'math', gcd: 'math', log: 'math', log2: 'math', exp: 'math', factorial: 'math', hypot: 'math', isnan: 'math', isinf: 'math',
  shuffle: 'random', randint: 'random', choice: 'random', randrange: 'random', sample: 'random', uniform: 'random',
  getLogger: 'logging', dumps: 'json', loads: 'json',
  Decimal: 'decimal', Fraction: 'fractions',
  StringIO: 'io', BytesIO: 'io',
  patch: 'unittest.mock', MagicMock: 'unittest.mock', Mock: 'unittest.mock', TestCase: 'unittest',
  NamedTemporaryFile: 'tempfile', TemporaryDirectory: 'tempfile', mkdtemp: 'tempfile', mkstemp: 'tempfile',
  urlparse: 'urllib.parse', urljoin: 'urllib.parse', quote: 'urllib.parse', unquote: 'urllib.parse', urlencode: 'urllib.parse',
  sleep: 'time', perf_counter: 'time', monotonic: 'time',
  environ: 'os', getcwd: 'os', listdir: 'os', makedirs: 'os',
  mean: 'statistics', median: 'statistics', stdev: 'statistics', variance: 'statistics',
  Iterable_: 'collections.abc',
  attrgetter: 'operator', itemgetter: 'operator', methodcaller: 'operator',
  dedent: 'textwrap', indent: 'textwrap', wrap: 'textwrap',
  SequenceMatcher: 'difflib', unified_diff: 'difflib',
  pformat: 'pprint', pprint: 'pprint',
  uuid4: 'uuid', UUID: 'uuid',
};

/** Standard-library module names, for `import <name>` when the unbound name is used as a receiver. */
export const STDLIB_MODULES: ReadonlySet<string> = new Set([
  'os', 'sys', 're', 'json', 'math', 'time', 'random', 'itertools', 'functools', 'collections', 'typing', 'pathlib', 'subprocess', 'shutil', 'tempfile',
  'logging', 'csv', 'io', 'copy', 'datetime', 'enum', 'abc', 'heapq', 'bisect', 'operator', 'string', 'struct', 'hashlib', 'base64', 'textwrap', 'unicodedata',
  'statistics', 'decimal', 'fractions', 'argparse', 'dataclasses', 'contextlib', 'threading', 'asyncio', 'socket', 'http', 'urllib', 'uuid', 'glob', 'fnmatch',
  'pickle', 'pprint', 'traceback', 'warnings', 'inspect', 'types', 'weakref', 'array', 'queue', 'secrets', 'sqlite3', 'zlib', 'gzip', 'zipfile', 'tarfile',
  'platform', 'signal', 'errno', 'locale', 'calendar', 'difflib', 'shlex', 'codecs', 'ast', 'tokenize', 'timeit', 'unittest', 'numbers', 'cmath', 'stat', 'html', 'xml', 'email', 'mimetypes',
]);

/** Names the module uses that nothing binds: not a statement target, parameter, comprehension variable, import, builtin or attribute. */
export function unboundNames(mod: PyModule): string[] {
  const bound = new Set<string>([...mod.moduleNames, ...BUILTIN_SET, '__future__', '__all__', '__version__', '__author__']);
  for (const st of mod.statements) for (const b of st.binds) bound.add(b);
  for (const b of mod.blocks) for (const p of b.params) bound.add(p.name);
  // import statements name modules, not values; everything else is scanned token by token
  const code = mod.statements.filter((st) => st.kind !== 'import' && st.kind !== 'from_import');
  // comprehension targets (`for x in`, at any bracket depth) and lambda parameters
  for (const st of code) {
    const t = st.tokens;
    for (let k = 0; k < t.length; k++) {
      const u = t[k]!;
      if (u.type !== 'NAME') continue;
      if (u.text === 'for') for (let j = k + 1; j < t.length && !(t[j]!.type === 'NAME' && t[j]!.text === 'in'); j++) if (isName(t[j])) bound.add(t[j]!.text);
      if (u.text === 'lambda') for (let j = k + 1; j < t.length && !isOp(t[j], ':'); j++) if (isName(t[j])) bound.add(t[j]!.text);
    }
  }
  const used: string[] = [];
  for (const st of code) {
    const t = st.tokens;
    let depth = 0;
    for (let k = 0; k < t.length; k++) {
      const u = t[k]!;
      if (u.type === 'OP') {
        if (u.text === '(' || u.text === '[' || u.text === '{') depth++;
        else if (u.text === ')' || u.text === ']' || u.text === '}') depth = Math.max(0, depth - 1);
        continue;
      }
      if (u.type !== 'NAME' || isKeyword(u.text) || isOp(t[k - 1], '.')) continue;
      // keyword argument names inside a call: `f(key=value)`
      if (depth > 0 && isOp(t[k + 1], '=') && (isOp(t[k - 1], '(') || isOp(t[k - 1], ','))) continue;
      if (!bound.has(u.text)) used.push(u.text);
    }
  }
  return uniq(used);
}

/** 1-based line BEFORE which a new module-level import goes: after the last import, else after the docstring, else 1. */
export function importInsertLine(mod: PyModule): number {
  const moduleImports = mod.imports.filter((i) => i.scope === 'module');
  if (moduleImports.length > 0) {
    const last = Math.max(...moduleImports.map((i) => mod.statements[i.statementIndex]!.endLine));
    return last + 1;
  }
  const first = mod.statements[0];
  if (first !== undefined && first.blockIndex === null && first.kind === 'expr' && first.tokens.every((u) => u.type === 'STRING')) return first.endLine + 1;
  return 1;
}

function dottedModule(fromPath: string, toPath: string): string {
  const norm = (p: string): string[] => p.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  const a = norm(fromPath);
  const b = norm(toPath);
  const stem = b[b.length - 1]!.replace(/\.py$/, '');
  const sameDir = a.length === b.length && a.slice(0, -1).every((seg, k) => seg === b[k]);
  if (sameDir) return `.${stem === '__init__' ? '' : stem}`;
  const parts = b.slice(0, -1).filter((seg) => seg !== '' && seg !== '.');
  return [...parts, stem].join('.');
}

/** Import statements that would bind `name`, best first. */
export function importLinesFor(ctx: TemplateContext, name: string): { text: string; p: number }[] {
  const out: { text: string; p: number }[] = [];
  const std = STDLIB_NAMES[name];
  if (std !== undefined) out.push({ text: `from ${std} import ${name}`, p: 1 });
  for (const [path, file] of ctx.opts.corpus) {
    if (path === ctx.site.file.path) continue;
    const imp = file.mod.imports.find((i) => i.bound === name && i.scope === 'module');
    if (imp !== undefined) out.push({ text: file.mod.statements[imp.statementIndex]!.text, p: 0.95 });
    const defines = file.mod.moduleNames.includes(name) && !file.mod.imports.some((i) => i.bound === name);
    if (defines) out.push({ text: `from ${dottedModule(ctx.site.file.path, path)} import ${name}`, p: 0.9 });
  }
  if (STDLIB_MODULES.has(name)) out.push({ text: `import ${name}`, p: 0.9 });
  const seen = new Set<string>();
  return out.filter((o) => (seen.has(o.text) ? false : (seen.add(o.text), true)));
}

export function importDrafts(ctx: TemplateContext): Draft[] {
  const out: Draft[] = [];
  const base = FAMILY_PRIOR.import;
  const { site, mod } = ctx;
  // Resolve every unbound name first and keep the ones with an import to offer, nearest the site
  // first; truncating before resolving would let unresolvable names (a typo, a test-only helper)
  // crowd out the one name an import fixes.
  const resolved = unboundNames(mod)
    .filter((n) => !isKeyword(n))
    .map((name) => ({ name, imports: importLinesFor(ctx, name) }))
    .filter((r) => r.imports.length > 0)
    .sort((a, b) => Number(ctx.nearby.has(b.name)) - Number(ctx.nearby.has(a.name)))
    .slice(0, 8);
  if (resolved.length === 0) return out;
  const at = importInsertLine(mod);
  // a local import can only go before the first line of the current statement
  const startsHere = ctx.stmt === undefined || ctx.stmt.startLine === site.line;
  const current = currentLineText(ctx);
  for (const { name, imports } of resolved) {
    const loc = ctx.nearby.has(name) ? 1 : 0.7;
    for (const imp of imports) {
      const prior = base * imp.p * loc;
      const edit: LineEdit = { path: site.file.path, line: at, kind: 'insert', text: imp.text };
      if (site.kind === 'replace') {
        if (site.line === at && ctx.lead === '' && startsHere) out.push({ text: `${imp.text}\n${current}`, op: 'import_insert', prior });
        else out.push({ text: site.currentLine, op: 'import_insert_top', prior, extraEdits: [edit] });
        // a local import right before the failing statement also fixes a NameError
        if (ctx.lead !== '' && startsHere) out.push({ text: `${reindent(imp.text, ctx.lead)}\n${current}`, op: 'import_insert_local', prior: prior * 0.6 });
      } else if (site.line === at && site.indent === '') out.push({ text: imp.text, op: 'import_insert', prior });
      else out.push({ text: reindent(imp.text, site.indent), op: 'import_insert_local', prior: prior * 0.6 });
    }
  }
  return out;
}
