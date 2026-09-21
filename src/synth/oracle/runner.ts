/**
 * Turn a chosen snippet into a runnable reproduction and a code-computed pass criterion.
 *
 * The generated Python script (`buildReproScript`) puts the workspace (and `<workspace>/src`)
 * first on `sys.path`, splits every chunk into top-level statements with `ast`, runs them one by
 * one in a shared namespace, captures `repr()` of each expression statement's value and the
 * stdout it printed, catches exceptions (type, message, frames) and prints one JSON line behind a
 * sentinel. It runs through the caller's `run(cmd, { cwd, timeoutMs })` (the engine's sandbox in
 * production) with the workspace's `.venv/bin/python` when present, else `python3`, and a 30 s
 * timeout. Nothing is written to disk: the script travels base64-encoded inside the command.
 *
 * Two bounded fix-ups make reporters' snippets runnable without changing their meaning: on a
 * `NameError` for a name the repository's top-level package exports (or an importable module
 * name such as `inspect`), the runner binds it and retries the statement once, recording the
 * import it added; a Django workspace gets `settings.configure()` with an in-memory sqlite
 * database and an app labelled `app` for models the snippet defines, whose tables are created
 * as they appear. A statement that fails on a module the repository does not provide (numpy,
 * the reporter's own `bug.app.models`) is marked `environment` and never counts as evidence.
 *
 * The pass criterion is built in code from the expected output (`buildCriterion`) and evaluated
 * in code (`evaluateCriterion`): normalised string equality for printed values (whitespace,
 * quote style, trailing zeros, dict key order, memory addresses), `type(...)` names when the issue
 * talks about types, exception-type equality for `should_raise_but_does_not`, "no exception" for
 * `exception_raised`. Jev never sees or decides a verdict.
 */
import type { VerifyRunFn, VerifyRunResult } from '../verify/types.js';
import type { CodeBlock, Criterion, CriterionStrength, Expectation, ExpectedValue, Extraction, FailureKind, ReproException, ReproRunResult, StatementResult, Verdict } from './types.js';
import { exceptionTypeIn, expectedActualOf, normaliseRepl, stripTrailingComment } from './extract.js';

export const REPRO_TIMEOUT_MS = 30_000;
export const REPRO_MAX_OUTPUT_BYTES = 512 * 1024;
export const REPRO_SENTINEL = '__JEVCODE_REPRO__';
/** Longest repr / stdout kept per statement in the result (chars). */
export const VALUE_CHARS_MAX = 4000;
export const OUTPUT_TAIL_CHARS = 2000;

export interface ReproScriptOptions {
  /** absolute path of the checkout the snippet runs against; put first on sys.path (and `<workspace>/src` when it exists) */
  workspace: string;
  /** the repository's importable top-level package (`sympy`, `django`, `_pytest`), for the NameError fix-up; null disables it */
  packageName: string | null;
  /** framework preamble; 'django' configures settings + an in-memory sqlite database + an app for snippet models */
  framework?: 'django' | null;
}

export interface ReproRunOptions extends ReproScriptOptions {
  /** interpreter; default: `.venv/bin/python` under the workspace when present, else `python3` */
  python?: string;
  timeoutMs?: number;
  /** extra environment assignments prefixed to the command (KEY=value, shell-quoted by the caller) */
  env?: Record<string, string>;
}

function pyLiteral(v: unknown): string {
  return JSON.stringify(v);
}

/** The Python source of the runner for `chunks` (REPL statements or code blocks, one string each). */
export function buildReproScript(chunks: readonly string[], opts: ReproScriptOptions): string {
  const framework = opts.framework ?? null;
  return [
    'import sys, os, json, ast, io, time, traceback, contextlib, importlib, importlib.util, warnings',
    `WS = json.loads(${pyLiteral(pyLiteral(opts.workspace))})`,
    `PKG = json.loads(${pyLiteral(pyLiteral(opts.packageName))})`,
    `CHUNKS = json.loads(${pyLiteral(pyLiteral(chunks))})`,
    `FRAMEWORK = json.loads(${pyLiteral(pyLiteral(framework))})`,
    `SENTINEL = ${pyLiteral(REPRO_SENTINEL)}`,
    `VALUE_MAX = ${VALUE_CHARS_MAX}`,
    'for p in (os.path.join(WS, "src"), WS):',
    '    if os.path.isdir(p):',
    '        sys.path.insert(0, p)',
    'os.chdir(WS)',
    'warnings.simplefilter("ignore")',
    'ns = {"__name__": "__main__", "__builtins__": __builtins__}',
    'results = []',
    'STDLIB = set(getattr(sys, "stdlib_module_names", ())) | {"numpy", "scipy", "pandas", "matplotlib", "cython", "Cython", "mpmath", "IPython", "ipdb"}',
    'NETWORK_ERRORS = {"ConnectionError", "ConnectTimeout", "ReadTimeout", "MaxRetryError", "NewConnectionError", "gaierror", "URLError", "HTTPError", "SSLError", "ProxyError", "RemoteDisconnected", "timeout", "TimeoutError", "ConnectionRefusedError", "ConnectionResetError"}',
    '',
    'def clip(s):',
    '    s = str(s)',
    '    return s if len(s) <= VALUE_MAX else s[:VALUE_MAX] + "..."',
    '',
    'def frames_of(tb):',
    '    out = []',
    '    for f in traceback.extract_tb(tb):',
    '        out.append({"file": f.filename, "line": f.lineno, "fn": f.name, "code": f.line})',
    '    return out[:40]',
    '',
    'def exc_record(e):',
    '    return {"type": type(e).__name__, "message": clip(e), "frames": frames_of(e.__traceback__)}',
    '',
    'def is_environment(e, src):',
    '    if isinstance(e, ModuleNotFoundError):',
    '        top = (e.name or "").split(".")[0]',
    '        return PKG is None or top != PKG',
    '    if isinstance(e, ImportError) and PKG is not None and PKG not in (e.name or ""):',
    '        return True',
    '    if type(e).__name__ in NETWORK_ERRORS or isinstance(e, (OSError,)) and "Connection" in type(e).__name__:',
    '        return True',
    '    return False',
    '',
    'DJANGO_NAMES = {"models": "django.db.models", "forms": "django.forms", "admin": "django.contrib.admin", "settings": "django.conf"}',
    '',
    'def fixup_name(name):',
    '    if name in ns:',
    '        return None',
    '    if FRAMEWORK == "django" and name in DJANGO_NAMES:',
    '        mod = DJANGO_NAMES[name]',
    '        ns[name] = importlib.import_module(mod) if name != "settings" else importlib.import_module(mod).settings',
    '        return "from %s import %s" % (mod.rsplit(".", 1)[0], name) if name != "settings" else "from django.conf import settings"',
    '    if PKG is not None:',
    '        try:',
    '            pkg = importlib.import_module(PKG)',
    '            if hasattr(pkg, name):',
    '                ns[name] = getattr(pkg, name)',
    '                return "from %s import %s" % (PKG, name)',
    '        except Exception:',
    '            pass',
    '    if name != PKG and (name in STDLIB or (name.islower() and importlib.util.find_spec(name) is not None)):',
    '        try:',
    '            ns[name] = importlib.import_module(name)',
    '            return "import %s" % name',
    '        except Exception:',
    '            return None',
    '    return None',
    '',
    'def run_node(node, src, rec):',
    '    out = io.StringIO()',
    '    with contextlib.redirect_stdout(out):',
    '        if isinstance(node, ast.Expr):',
    '            code = compile(ast.Expression(body=node.value), "<repro>", "eval")',
    '            v = eval(code, ns)',
    '            ns["_"] = v',
    '            if v is not None:',
    '                rec["value"] = clip(repr(v))',
    '                rec["type_name"] = type(v).__name__',
    '        else:',
    '            mod = ast.Module(body=[node], type_ignores=[])',
    '            exec(compile(mod, "<repro>", "exec"), ns)',
    '    rec["stdout"] = clip(out.getvalue())',
    '',
    'def after_statement():',
    '    if FRAMEWORK != "django":',
    '        return',
    '    try:',
    '        from django.apps import apps',
    '        from django.db import connection, models',
    '        if not apps.ready:',
    '            return',
    '        cfg = apps.get_app_config("app")',
    '        existing = set(connection.introspection.table_names())',
    '        pending = []',
    '        for name, obj in list(ns.items()):',
    '            if isinstance(obj, type) and issubclass(obj, models.Model) and obj is not models.Model and obj.__module__ == "__main__" and not obj._meta.abstract:',
    '                if obj._meta.label_lower not in {m._meta.label_lower for m in cfg.get_models()}:',
    '                    apps.register_model("app", obj)',
    '                if obj._meta.db_table not in existing:',
    '                    pending.append(obj)',
    '        for m in pending:',
    '            try:',
    '                with connection.schema_editor() as se:',
    '                    se.create_model(m)',
    '            except Exception:',
    '                pass  # a related model is not defined yet; created once it is',
    '    except Exception as e:',
    '        results.append({"chunk": -1, "stmt": -1, "source": "<django table setup>", "kind": "stmt", "value": None, "stdout": "", "exception": exc_record(e), "fixup": None, "environment": True, "ms": 0})',
    '',
    'def run_chunk(ci, src):',
    '    try:',
    '        tree = ast.parse(src)',
    '    except SyntaxError as e:',
    '        results.append({"chunk": ci, "stmt": 0, "source": clip(src), "kind": "syntax_error", "value": None, "stdout": "", "exception": {"type": "SyntaxError", "message": clip(e), "frames": []}, "fixup": None, "environment": False, "ms": 0})',
    '        return',
    '    for si, node in enumerate(tree.body):',
    '        seg = ast.get_source_segment(src, node) or ""',
    '        rec = {"chunk": ci, "stmt": si, "source": clip(seg), "kind": "expr" if isinstance(node, ast.Expr) else "stmt", "value": None, "stdout": "", "exception": None, "fixup": None, "environment": False, "ms": 0}',
    '        t0 = time.time()',
    '        try:',
    '            run_node(node, src, rec)',
    '        except NameError as e:',
    '            err = e',
    '            fixes = []',
    '            for _ in range(6):',
    '                if not isinstance(err, NameError):',
    '                    break',
    '                name = getattr(err, "name", None) or (str(err).split("\'")[1] if "\'" in str(err) else None)',
    '                fix = fixup_name(name) if name else None',
    '                if fix is None:',
    '                    break',
    '                fixes.append(fix)',
    '                try:',
    '                    run_node(node, src, rec)',
    '                    err = None',
    '                    break',
    '                except BaseException as e2:',
    '                    err = e2',
    '            if fixes:',
    '                rec["fixup"] = "; ".join(fixes)',
    '            if err is not None:',
    '                rec["exception"] = exc_record(err)',
    '                rec["environment"] = is_environment(err, seg)',
    '        except BaseException as e:',
    '            rec["exception"] = exc_record(e)',
    '            rec["environment"] = is_environment(e, seg)',
    '        rec["ms"] = int((time.time() - t0) * 1000)',
    '        results.append(rec)',
    '        after_statement()',
    '',
    'def django_preamble():',
    '    import django',
    '    from django.conf import settings',
    '    from django.apps import AppConfig',
    '    class ReproAppConfig(AppConfig):',
    '        name = "__main__"',
    '        label = "app"',
    '        path = WS',
    '        default_auto_field = "django.db.models.AutoField"',
    '        def import_models(self):',
    '            self.models = self.apps.all_models[self.label]',
    '    import __main__ as m',
    '    m.ReproAppConfig = ReproAppConfig',
    '    if not settings.configured:',
    '        settings.configure(DEBUG=True, SECRET_KEY="repro", USE_TZ=False, DEFAULT_AUTO_FIELD="django.db.models.AutoField",',
    '            DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}},',
    '            INSTALLED_APPS=["django.contrib.contenttypes", "django.contrib.auth", "__main__.ReproAppConfig"],',
    '            TEMPLATES=[{"BACKEND": "django.template.backends.django.DjangoTemplates", "DIRS": [], "APP_DIRS": False}])',
    '    django.setup()',
    '',
    'if FRAMEWORK == "django":',
    '    try:',
    '        django_preamble()',
    '    except Exception as e:',
    '        results.append({"chunk": -1, "stmt": -1, "source": "<django preamble>", "kind": "stmt", "value": None, "stdout": "", "exception": exc_record(e), "fixup": None, "environment": True, "ms": 0})',
    'for ci, src in enumerate(CHUNKS):',
    '    run_chunk(ci, src)',
    'sys.stdout.flush()',
    'sys.stdout.write("\\n" + SENTINEL + json.dumps({"ok": True, "python": sys.version.split()[0], "results": results}) + "\\n")',
    '',
  ].join('\n');
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Every reproduction runs under this hash seed. CPython randomises `str` hashes per process, and
 * a snippet whose verdict rests on a hash is then a coin toss between runs: django-15315's
 * `d = {f: 1}; class Book(models.Model): title = f; assert f in d` passes ~1/8 of the time with
 * the bug present, because the dict lookup finds `f` by identity whenever the changed hash lands
 * on the same slot (jev-only-swebench-2-oracle: 24 of 162 lane runs "passed", every one a
 * dead-code insert after `return` in `__hash__`; the workspace re-run then failed again). One
 * seed for the base run, the lanes and the workspace re-run makes a verdict a fact of the code,
 * not of the process.
 */
export const REPRO_HASH_SEED = '0';

/** The shell command that runs `script` from the workspace with its venv python when present. */
export function reproCommand(script: string, opts: { workspace: string; python?: string; env?: Record<string, string> }): string {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const envPrefix = Object.entries(opts.env ?? {})
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  const py = opts.python !== undefined ? shellQuote(opts.python) : `"$JEV_PY"`;
  const pick = opts.python !== undefined ? '' : `if [ -x ${shellQuote(opts.workspace)}/.venv/bin/python ]; then JEV_PY=${shellQuote(opts.workspace)}/.venv/bin/python; else JEV_PY=python3; fi; `;
  const run = `${envPrefix === '' ? '' : `env ${envPrefix} `}${py} -c ${shellQuote(`import base64;exec(compile(base64.b64decode('${b64}'),'<jevcode-repro>','exec'))`)}`;
  return `${pick}PYTHONDONTWRITEBYTECODE=1 PYTHONWARNINGS=ignore PYTHONHASHSEED=${REPRO_HASH_SEED} ${run}`;
}

interface RawResult {
  ok?: boolean;
  python?: string;
  results?: RawStatement[];
}
interface RawStatement {
  chunk?: number;
  stmt?: number;
  source?: string;
  kind?: string;
  value?: string | null;
  type_name?: string;
  stdout?: string;
  exception?: { type?: string; message?: string; frames?: { file?: string; line?: number; fn?: string | null; code?: string | null }[] } | null;
  fixup?: string | null;
  environment?: boolean;
  ms?: number;
}

function statementOf(r: RawStatement): StatementResult {
  const kind: StatementResult['kind'] = r.kind === 'expr' ? 'expr' : r.kind === 'syntax_error' ? 'syntax_error' : 'stmt';
  let exception: ReproException | null = null;
  if (r.exception !== null && r.exception !== undefined) {
    exception = {
      type: r.exception.type ?? 'Exception',
      message: r.exception.message ?? '',
      frames: (r.exception.frames ?? []).map((f) => ({ file: f.file ?? '', line: f.line ?? 0, fn: f.fn ?? null, code: f.code ?? null })),
    };
  }
  const out: StatementResult = {
    chunk: r.chunk ?? 0,
    stmt: r.stmt ?? 0,
    source: r.source ?? '',
    kind,
    value: r.value ?? null,
    typeName: r.type_name ?? null,
    stdout: r.stdout ?? '',
    exception,
    fixup: r.fixup ?? null,
    environment: r.environment === true,
    ms: r.ms ?? 0,
  };
  return out;
}

/** Parse the runner's sentinel line out of the process output; null when the sentinel is missing. */
export function parseReproOutput(stdout: string): { python: string | null; statements: StatementResult[] } | null {
  const at = stdout.lastIndexOf(REPRO_SENTINEL);
  if (at === -1) return null;
  const line = stdout.slice(at + REPRO_SENTINEL.length).split('\n')[0] ?? '';
  let raw: RawResult;
  try {
    raw = JSON.parse(line) as RawResult;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.results)) return null;
  return { python: raw.python ?? null, statements: raw.results.map(statementOf) };
}

function tailOf(res: VerifyRunResult): string {
  const s = `${res.stdout}\n${res.stderr ?? ''}`.replace(new RegExp(`${REPRO_SENTINEL}.*$`, 'm'), '').trim();
  return s.length > OUTPUT_TAIL_CHARS ? s.slice(-OUTPUT_TAIL_CHARS) : s;
}

/** Run the chunks in the workspace; never throws on a failing script (status carries it). */
export async function runRepro(run: VerifyRunFn, chunks: readonly string[], opts: ReproRunOptions): Promise<ReproRunResult> {
  const script = buildReproScript(chunks, opts);
  const cmdOpts: { workspace: string; python?: string; env?: Record<string, string> } = { workspace: opts.workspace };
  if (opts.python !== undefined) cmdOpts.python = opts.python;
  if (opts.env !== undefined) cmdOpts.env = opts.env;
  const command = reproCommand(script, cmdOpts);
  const timeoutMs = opts.timeoutMs ?? REPRO_TIMEOUT_MS;
  const started = Date.now();
  const res = await run(command, { cwd: opts.workspace, timeoutMs, maxOutputBytes: REPRO_MAX_OUTPUT_BYTES });
  const durationMs = res.durationMs ?? Date.now() - started;
  const timedOut = res.timedOut === true || res.killedBy === 'timeout';
  const parsed = parseReproOutput(res.stdout);
  if (timedOut) return { status: 'timeout', python: parsed?.python ?? null, statements: parsed?.statements ?? [], exitCode: res.exitCode, durationMs, outputTail: tailOf(res) };
  if (parsed === null) return { status: res.exitCode === 0 ? 'no_output' : 'error', python: null, statements: [], exitCode: res.exitCode, durationMs, outputTail: tailOf(res) };
  return { status: 'ran', python: parsed.python, statements: parsed.statements, exitCode: res.exitCode, durationMs, outputTail: tailOf(res) };
}

// ---------------------------------------------------------------------------------------
// Network use (a verdict that is the network's, not the code's)
// ---------------------------------------------------------------------------------------

/**
 * Exception types the reproduction script marks as environment gaps (its `NETWORK_ERRORS` set),
 * mirrored here for the runtime tell of `detectNetworkUse`.
 */
export const NETWORK_ERROR_TYPES: ReadonlySet<string> = new Set(['ConnectionError', 'ConnectTimeout', 'ReadTimeout', 'MaxRetryError', 'NewConnectionError', 'gaierror', 'URLError', 'HTTPError', 'SSLError', 'ProxyError', 'RemoteDisconnected', 'timeout', 'TimeoutError', 'ConnectionRefusedError', 'ConnectionResetError']);
/** Modules whose import in a snippet, together with a URL literal, says the snippet talks to the network. */
const NETWORK_MODULES = ['requests', 'urllib', 'urllib2', 'urllib3', 'socket', 'http', 'httplib', 'httpx', 'aiohttp', 'ftplib', 'smtplib', 'websocket', 'websockets'];
const NETWORK_MODULE_SET: ReadonlySet<string> = new Set(NETWORK_MODULES);
const IMPORT_LINE = /^\s*import\s+(.+?)\s*$/gm;
const FROM_LINE = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm;

/** The network modules a snippet imports (`import a, b.c as d`, `from a.b import x`), sorted. */
function networkImports(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IMPORT_LINE)) {
    for (const part of (m[1] ?? '').split(',')) {
      const root = part.trim().split(/\s+/)[0]?.split('.')[0] ?? '';
      if (NETWORK_MODULE_SET.has(root)) out.add(root);
    }
  }
  for (const m of text.matchAll(FROM_LINE)) {
    const root = (m[1] ?? '').split('.')[0] ?? '';
    if (NETWORK_MODULE_SET.has(root)) out.add(root);
  }
  return [...out].sort();
}
/** `requests.get(`, `urlopen(`, `socket.create_connection(`, `HTTPConnection(`: the call forms of those modules. */
const NETWORK_CALL = /\b(?:requests\.(?:get|post|put|patch|delete|head|options|request|Session)|urlopen|urlretrieve|create_connection|HTTP(?:S)?Connection|httpx\.(?:get|post|put|Client)|aiohttp\.ClientSession)\s*\(/;
const URL_LITERAL = /["'](?:https?|ftp|wss?):\/\/([^"'/\s:?#]+)/g;
/** Hosts a snippet may name without leaving the machine (Django's test client uses `testserver`). */
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|testserver)$/i;
const NETWORK_MESSAGE = /connection|name resolution|network is unreachable|failed to establish|temporary failure|nodename nor servname|max retries exceeded/i;

/** How a reproduction depends on the network: read from its text (`static`) or from what a run raised (`runtime`). */
export interface NetworkUse {
  kind: 'static' | 'runtime';
  /** one line for the transcript: the modules and host, or the exception */
  evidence: string;
}

/**
 * Whether the reproduction needs the network: statically, an import (or call form) of a network
 * module together with a URL literal naming a non-local host — requests-2931's oracle is
 * `requests.put("http://httpbin.org/put", …)` inside the `requests` checkout, so the gold
 * `return data` read `unchanged` while a wrong `.decode()` line read `plausible` (rung 3,
 * §21.6 item 1); at run time, a statement that raised one of the script's network error types or
 * a connection message. Null when nothing points at the network.
 */
export function detectNetworkUse(chunks: readonly string[], result: ReproRunResult | null): NetworkUse | null {
  const text = chunks.join('\n');
  const modules = networkImports(text);
  const calls = NETWORK_CALL.test(text);
  const hosts: string[] = [];
  for (const m of text.matchAll(URL_LITERAL)) {
    const host = m[1] ?? '';
    if (host !== '' && !LOCAL_HOST.test(host) && !hosts.includes(host)) hosts.push(host);
  }
  if ((modules.length > 0 || calls) && hosts.length > 0) {
    const by = modules.length > 0 ? modules.join(', ') : 'a network call';
    return { kind: 'static', evidence: `${by} against ${hosts.slice(0, 2).join(', ')}` };
  }
  if (result !== null) {
    for (const s of result.statements) {
      const e = s.exception;
      if (e === null) continue;
      if (NETWORK_ERROR_TYPES.has(e.type) || NETWORK_MESSAGE.test(e.message)) return { kind: 'runtime', evidence: `${e.type}: ${e.message.slice(0, 80)}` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Chunks of a block
// ---------------------------------------------------------------------------------------

/** The source chunks of one block: one per REPL statement, or the whole code text. */
export function chunksOf(block: CodeBlock): string[] {
  if (block.repl !== undefined) return normaliseRepl(block.repl).statements;
  return [block.text];
}

const ASSIGN_TARGETS = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=[^=]/m;
const DEF_TARGETS = /^(?:def|class)\s+([A-Za-z_]\w*)/m;
const IMPORT_TARGETS = /^(?:from\s+\S+\s+)?import\s+(.+)$/m;

/** Names a chunk binds at top level: assignment targets, def/class names, imported names. */
export function boundNames(chunk: string): string[] {
  const out = new Set<string>();
  for (const line of chunk.split('\n')) {
    const a = ASSIGN_TARGETS.exec(line);
    if (a !== null) for (const n of (a[1] ?? '').split(',')) out.add(n.trim());
    const d = DEF_TARGETS.exec(line);
    if (d !== null) out.add(d[1] ?? '');
    const im = IMPORT_TARGETS.exec(line);
    if (im !== null) for (const part of (im[1] ?? '').split(',')) {
      const n = part.trim().split(/\s+as\s+/).at(-1)?.split('.')[0] ?? '';
      if (n !== '' && n !== '*') out.add(n);
    }
  }
  out.delete('');
  return [...out];
}

export interface ChunksWithContext {
  /** context statements first, then the block's own chunks */
  chunks: string[];
  /** how many chunks precede the block's own (add to a block-relative statement index) */
  offset: number;
  /** indices of the earlier blocks whose statements were prepended */
  contextBlocks: number[];
}

/**
 * The block's chunks, preceded by the statements of earlier runnable blocks that bind a name the
 * block uses without binding it itself (sympy-20428: `bad_poly` comes from the first transcript).
 * Only imports and names are inferred; the reporter's statements are never rewritten.
 */
export function chunksWithContext(block: CodeBlock, extraction: Extraction): ChunksWithContext {
  const own = chunksOf(block);
  const ownBound = new Set(own.flatMap(boundNames));
  const ownText = own.join('\n');
  const used = new Set((ownText.match(/\b[A-Za-z_]\w*\b/g) ?? []).filter((n) => !ownBound.has(n)));
  const context: string[] = [];
  const contextBlocks: number[] = [];
  const needed = new Set<string>();
  // walk earlier blocks from the nearest: a block is context when it binds a name still needed
  const earlier = extraction.blocks.filter((b) => b.index < block.index && (b.kind === 'code' || b.kind === 'repl')).reverse();
  const picked: CodeBlock[] = [];
  let want = new Set(used);
  const unresolvedCapitalised = (): boolean => [...want].some((n) => /^[A-Z]/.test(n) || /^[a-z_]\w*$/.test(n));
  for (const b of earlier) {
    const chunks = chunksOf(b);
    const bound = chunks.flatMap(boundNames);
    const hit = bound.filter((n) => want.has(n));
    // a `from X import *` block may bind anything still unresolved
    const star = /^\s*from\s+\S+\s+import\s+\*/m.test(chunks.join('\n')) && unresolvedCapitalised();
    if (hit.length === 0 && !star) continue;
    picked.unshift(b);
    for (const n of hit) needed.add(n);
    const bText = chunks.join('\n');
    const bBound = new Set(bound);
    want = new Set([...want].filter((n) => !bBound.has(n)));
    for (const n of bText.match(/\b[A-Za-z_]\w*\b/g) ?? []) if (!bBound.has(n)) want.add(n);
  }
  for (const b of picked) {
    context.push(...chunksOf(b));
    contextBlocks.push(b.index);
  }
  return { chunks: [...context, ...own], offset: context.length, contextBlocks };
}

// ---------------------------------------------------------------------------------------
// Value normalisation and the criterion
// ---------------------------------------------------------------------------------------

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (quote !== null) {
      cur += c;
      if (c === '\\') {
        cur += s[i + 1] ?? '';
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Sort the top-level `key: value` pairs of a dict literal so key order does not matter. */
function normaliseDict(s: string): string {
  if (!(s.startsWith('{') && s.endsWith('}'))) return s;
  const inner = s.slice(1, -1);
  const parts = splitTopLevel(inner, ',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0 || !parts.every((p) => splitTopLevel(p, ':').length >= 2)) return s;
  return `{${parts.sort().join(', ')}}`;
}

/**
 * Whitespace collapsed, quote style unified, trailing zeros of floats dropped (`4.00000000000000`
 * → `4.0`), memory addresses removed, dict keys sorted, a trailing `# comment` dropped.
 */
export function normaliseValue(raw: string): string {
  let s = stripTrailingComment(raw.trim());
  // a repr of a multi-line string shows `\n` escapes where the reporter pasted real newlines
  s = s.replace(/\\n/g, ' ').replace(/\\t/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(['"])\s+/, '$1').replace(/\s+(['"])$/, '$1');
  s = s.replace(/ at 0x[0-9a-fA-F]+/g, '');
  s = s.replace(/"/g, "'");
  s = s.replace(/\b(\d+)\.(\d*?)0+\b(?!\d)/g, (_m, a: string, b: string) => `${a}.${b === '' ? '0' : b}`);
  s = s.replace(/\b(\d+)\.(?=[^\d\w]|$)/g, '$1.0');
  s = s.replace(/\s*([,:()[\]{}])\s*/g, '$1');
  s = s.replace(/,/g, ', ').replace(/:/g, ': ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*([()[\]{}])\s*/g, '$1');
  s = normaliseDict(s);
  return s;
}

/**
 * Loose equality: the same multiset of tokens (identifiers, numbers, punctuation) regardless of
 * order and spacing. Reporters type the expected value by hand and get argument order wrong
 * (sympy-15345: `'Max[x,2]'` for what the printer emits as `'Max[2, x]'`); the pass criterion uses
 * this tier only together with "differs from the recorded wrong value" (`evaluateCriterion`).
 */
export function valuesEqualLoose(a: string, b: string): boolean {
  const toks = (s: string): string => (normaliseValue(s).replace(/^'(.*)'$/, '$1').match(/[A-Za-z_]\w*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_]/g) ?? []).sort().join('\u0001');
  return toks(a) === toks(b) && toks(a) !== '';
}

/** Equality of two shown values after normalisation (the REPL's repr vs the reporter's paste). */
export function valuesEqual(a: string, b: string): boolean {
  const na = normaliseValue(a);
  const nb = normaliseValue(b);
  if (na === nb) return true;
  // the reporter often pastes a repr with its quotes, the runner captures stdout without them (and vice versa)
  const strip = (s: string): string => s.replace(/^'(.*)'$/, '$1');
  return strip(na) === strip(nb);
}

export interface CriterionInput {
  failureKind: FailureKind;
  /** the block that runs */
  reproduction: CodeBlock;
  /** the block whose shown values are the expected output, when Jev found one (may be the reproduction itself) */
  expected: CodeBlock | null;
  /** the block that shows the wrong behaviour, when any */
  actual: CodeBlock | null;
  expectations: readonly Expectation[];
  /** chunks prepended before the reproduction's own (chunksWithContext.offset); block-relative statement indices are shifted by it */
  chunkOffset?: number;
}

export interface BuiltCriterion {
  criterion: Criterion;
  strength: CriterionStrength;
  /** the expected text the goal shows (`FailureView.expected`) */
  expectedText: string;
  /** how the criterion was derived, for the transcript */
  derivation: string;
}

/** Shown values of a REPL block, by statement index (shifted by `offset`), tracebacks excluded. */
function shownValues(block: CodeBlock, offset = 0): ExpectedValue[] {
  if (block.repl === undefined) return [];
  return normaliseRepl(block.repl)
    .shown.filter((s) => s.traceback === null)
    .map((s) => ({ chunk: s.statement + offset, text: s.text }));
}

/** The exception the issue reports: from the actual block's tracebacks, then any traceback, then a sentence. */
function reportedException(input: CriterionInput, extraTracebacks: readonly { exceptionType: string }[]): string | null {
  const fromBlock = (b: CodeBlock | null): string | null => b?.tracebacks.find((t) => t.exceptionType !== '')?.exceptionType ?? null;
  return fromBlock(input.actual) ?? fromBlock(input.reproduction) ?? extraTracebacks.find((t) => t.exceptionType !== '')?.exceptionType ?? input.expectations.map((e) => exceptionTypeIn(e.text)).find((t) => t !== null) ?? null;
}

/**
 * Build the criterion in code. `null` when no criterion can be stated (performance, feature
 * requests, a wrong value with nothing to compare against and no observed output either).
 */
export function buildCriterion(input: CriterionInput, extraTracebacks: readonly { exceptionType: string }[] = []): BuiltCriterion | null {
  const kind = input.failureKind;
  if (kind === 'performance' || kind === 'none_of_these') return null;
  if (kind === 'exception_raised') {
    const exc = reportedException(input, extraTracebacks);
    return { criterion: { form: 'no_exception' }, strength: 'strong', expectedText: exc === null ? 'completes without raising' : `completes without raising ${exc}`, derivation: 'failure_kind = exception_raised → the script must complete without an uncaught exception' };
  }
  if (kind === 'should_raise_but_does_not') {
    const exc = input.expectations.map((e) => exceptionTypeIn(e.text)).find((t) => t !== null) ?? reportedException(input, extraTracebacks);
    if (exc === null) return null;
    return { criterion: { form: 'raises', exceptionType: exc }, strength: 'strong', expectedText: `raises ${exc}`, derivation: `failure_kind = should_raise_but_does_not → the last statement must raise ${exc}` };
  }
  // wrong_value / wrong_type: the expected text comes from the expected block's shown values or an expectation sentence
  const sentence = input.expectations.map((e) => ({ e, ea: expectedActualOf(e) })).find((x) => x.ea.expected !== null);
  if (kind === 'wrong_type') {
    const typeName = sentence?.ea.expected ?? null;
    if (typeName === null) return null;
    return { criterion: { form: 'type_name', expected: typeName }, strength: 'strong', expectedText: `type ${typeName}`, derivation: `failure_kind = wrong_type → type(last value).__name__ must equal ${typeName} (from "${sentence?.e.text.slice(0, 80) ?? ''}")` };
  }
  const actualValues = shownValues(input.actual ?? input.reproduction);
  const lastActual = actualValues[actualValues.length - 1];
  const withActual = (c: Criterion & { form: 'values' }, sentenceActual: string | null): Criterion => {
    const observed = sentenceActual ?? lastActual?.text ?? null;
    return observed === null ? c : { ...c, observedActual: observed };
  };
  if (input.expected !== null && input.expected.index !== input.reproduction.index) {
    // a separate block shows the correct output: its (last) shown value is what the reproduction's last statement must produce
    const values = shownValues(input.expected);
    const last = values[values.length - 1];
    const text = last?.text ?? (input.expected.kind === 'output' ? input.expected.text : null);
    if (text !== null && text !== undefined) return { criterion: withActual({ form: 'values', expected: [{ chunk: 'last', text }] }, null), strength: 'strong', expectedText: text, derivation: `block ${input.expected.index} shows the expected output; the reproduction's last value must equal it` };
  }
  if (input.expected !== null && input.expected.index === input.reproduction.index && input.actual?.index !== input.reproduction.index) {
    // the reproduction itself shows the expected values per statement (the reporter typed what should appear)
    const values = shownValues(input.expected, input.chunkOffset ?? 0);
    if (values.length > 0) return { criterion: { form: 'values', expected: values }, strength: 'strong', expectedText: values.map((v) => v.text).join(' | '), derivation: `the reproduction's shown values are the expected ones (shows_expected on block ${input.expected.index})` };
  }
  if (sentence !== undefined && sentence.ea.expected !== null) {
    return { criterion: withActual({ form: 'values', expected: [{ chunk: 'last', text: sentence.ea.expected }] }, sentence.ea.actual), strength: 'strong', expectedText: sentence.ea.expected, derivation: `expected value from the sentence "${sentence.e.text.slice(0, 100)}"` };
  }
  // no stated expected value: the only criterion left is "anything but the observed output, without raising"
  if (lastActual !== undefined) return { criterion: { form: 'differs_from_actual', actual: lastActual.text }, strength: 'weak', expectedText: `not ${lastActual.text}`, derivation: `no expected value stated; the last value must differ from the observed ${lastActual.text} and nothing may raise` };
  return null;
}

// ---------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------

function observedOf(s: StatementResult): string {
  if (s.exception !== null) return `${s.exception.type}: ${s.exception.message}`;
  if (s.value !== null) return s.value;
  return s.stdout.replace(/\n$/, '');
}

/** Statements that count as evidence: syntax errors and environment gaps excluded. */
export function evidenceStatements(result: ReproRunResult): StatementResult[] {
  return result.statements.filter((s) => s.chunk >= 0 && !s.environment && s.kind !== 'syntax_error');
}

function lastWithOutput(statements: readonly StatementResult[]): StatementResult | null {
  for (let i = statements.length - 1; i >= 0; i--) {
    const s = statements[i]!;
    if (s.exception !== null || s.value !== null || s.stdout.trim() !== '') return s;
  }
  return statements[statements.length - 1] ?? null;
}

/** Statements of a chunk that produced a value / output / exception, the last one preferred. */
function statementForChunk(statements: readonly StatementResult[], chunk: number | 'last'): StatementResult | null {
  if (chunk === 'last') return lastWithOutput(statements);
  const own = statements.filter((s) => s.chunk === chunk);
  return lastWithOutput(own);
}

/** Evaluate the criterion against a run; a run that did not produce results never passes. */
export function evaluateCriterion(criterion: Criterion, result: ReproRunResult): Verdict {
  if (result.status !== 'ran') return { pass: false, actual: result.status === 'timeout' ? `timeout after ${Math.round(result.durationMs / 1000)} s` : `runner ${result.status}: ${result.outputTail.slice(-200)}`, expected: describeCriterion(criterion), reason: `the runner did not report results (${result.status})`, statement: null };
  const statements = evidenceStatements(result);
  if (statements.length === 0) return { pass: false, actual: 'no statement ran (environment gaps only)', expected: describeCriterion(criterion), reason: 'every statement failed on the environment', statement: null };
  const raised = statements.filter((s) => s.exception !== null);
  switch (criterion.form) {
    case 'no_exception': {
      const first = raised[0] ?? null;
      const last = lastWithOutput(statements);
      return first === null ? { pass: true, actual: last === null ? 'completed' : observedOf(last), expected: 'completes without raising', reason: 'no statement raised', statement: last } : { pass: false, actual: observedOf(first), expected: 'completes without raising', reason: `${first.exception?.type ?? 'exception'} raised at "${first.source.slice(0, 80)}"`, statement: first };
    }
    case 'raises': {
      const last = lastWithOutput(statements);
      const hit = raised.find((s) => s.exception?.type === criterion.exceptionType) ?? null;
      return hit !== null ? { pass: true, actual: observedOf(hit), expected: `raises ${criterion.exceptionType}`, reason: 'the expected exception was raised', statement: hit } : { pass: false, actual: last === null ? 'completed' : observedOf(last), expected: `raises ${criterion.exceptionType}`, reason: `no statement raised ${criterion.exceptionType}`, statement: last };
    }
    case 'type_name': {
      const last = lastWithOutput(statements);
      const typeName = last?.typeName ?? null;
      const ok = last !== null && last.exception === null && typeName !== null && normaliseValue(typeName) === normaliseValue(criterion.expected);
      return { pass: ok, actual: last === null ? 'no value' : last.exception !== null ? observedOf(last) : `type ${typeName ?? '?'}`, expected: `type ${criterion.expected}`, reason: ok ? 'type matches' : 'type differs or the statement raised', statement: last };
    }
    case 'values': {
      const mismatches: string[] = [];
      const loose: string[] = [];
      let compared: StatementResult | null = null;
      for (const ev of criterion.expected) {
        const s = statementForChunk(statements, ev.chunk);
        compared = s;
        if (s === null) {
          mismatches.push(`no statement for chunk ${String(ev.chunk)}`);
          continue;
        }
        if (s.exception !== null) {
          mismatches.push(`raised ${s.exception.type} instead of ${ev.text}`);
          continue;
        }
        const observed = s.value !== null && s.stdout.trim() === '' ? s.value : s.stdout.trim() !== '' ? s.stdout.replace(/\n$/, '') : (s.value ?? '');
        if (valuesEqual(observed, ev.text) || (s.value !== null && valuesEqual(s.value, ev.text))) continue;
        // loose tier: same tokens in another order, and not the wrong value the issue recorded
        const notTheWrongOne = criterion.observedActual === undefined || !valuesEqual(observed, criterion.observedActual);
        if (ev.chunk === 'last' && notTheWrongOne && valuesEqualLoose(observed, ev.text)) {
          loose.push(`"${observed.slice(0, 120)}" ~ "${ev.text.slice(0, 120)}" (same tokens, other order)`);
          continue;
        }
        mismatches.push(`"${observed.slice(0, 120)}" != "${ev.text.slice(0, 120)}"`);
      }
      const last = criterion.expected.length === 1 ? compared : lastWithOutput(statements);
      const reason = mismatches.length > 0 ? mismatches.join('; ') : loose.length > 0 ? `loose match: ${loose.join('; ')}` : 'every expected value matches';
      return { pass: mismatches.length === 0, actual: last === null ? 'no value' : observedOf(last), expected: criterion.expected.map((e) => e.text).join(' | '), reason, statement: last };
    }
    case 'differs_from_actual': {
      const last = lastWithOutput(statements);
      if (last === null) return { pass: false, actual: 'no value', expected: `not ${criterion.actual}`, reason: 'no statement produced a value', statement: null };
      if (last.exception !== null) return { pass: false, actual: observedOf(last), expected: `not ${criterion.actual}`, reason: 'the last statement raised', statement: last };
      const observed = observedOf(last);
      const same = valuesEqual(observed, criterion.actual);
      return { pass: !same, actual: observed, expected: `not ${criterion.actual}`, reason: same ? 'the observed wrong value is unchanged' : 'the value changed and nothing raised', statement: last };
    }
    default:
      return { pass: false, actual: '', expected: '', reason: 'unknown criterion', statement: null };
  }
}

export function describeCriterion(c: Criterion): string {
  switch (c.form) {
    case 'no_exception':
      return 'completes without raising';
    case 'raises':
      return `raises ${c.exceptionType}`;
    case 'values':
      return c.expected.map((e) => e.text).join(' | ');
    case 'type_name':
      return `type ${c.expected}`;
    case 'differs_from_actual':
      return `not ${c.actual}`;
    default:
      return '';
  }
}
