/**
 * The Python side of the introspection pass. `buildIntrospectScript` is the oracle runner's own
 * reproduction script (oracle/runner.ts `buildReproScript`: same namespace, same NameError
 * fix-ups, same framework preamble) with one pass appended after the statements have run:
 *
 * 1. the target statement is the last one that raised (environment gaps excluded), else the
 *    last one that produced a value;
 * 2. if it raised, the statement runs once more under `try` so the traceback's frames are live:
 *    the innermost frame inside the workspace, the frames Jev anchored (`anchors`, matched by
 *    file suffix and function name) and the next innermost workspace frame (≤ FRAMES_MAX) each
 *    have the dotted names of their source line evaluated in their own locals/globals;
 * 3. if it did not raise, the sub-expressions of the statement (names and attributes first,
 *    then calls and subscripts) are evaluated in the script namespace;
 * 4. per object: `type(obj).__mro__` class names, the public `dir(obj)` names split into `is_*`
 *    predicates (properties that read as a bool / None, with their truth value now) and other
 *    attributes; plus the public names of the raising frame's (or the callee's) module.
 *
 * The result travels behind INTROSPECT_SENTINEL as one JSON line; the repro sentinel line is
 * still printed first, so the same output also parses as a reproduction run. Nothing is
 * written to disk; the whole script is base64 inside the command (`reproCommand`).
 */
import { buildReproScript, reproCommand } from '../oracle/runner.js';
import type { ReproScriptOptions } from '../oracle/runner.js';
import type { TracebackFrame } from '../oracle/types.js';

export const INTROSPECT_SENTINEL = '__JEVCODE_INTROSPECT__';
/** Frames introspected per raising traceback: the innermost workspace frame, the anchors, the next innermost. */
export const FRAMES_MAX = 3;
/** Dotted-name operands evaluated per frame / per statement. */
export const OPERANDS_MAX = 8;
/** `dir(obj)` public attribute names kept per object on the Python side (the TS side caps again). */
export const ATTRS_PER_OBJECT_MAX = 80;
/** Module-level names kept on the Python side. */
export const MODULE_NAMES_RAW_MAX = 120;

export interface IntrospectAnchor {
  file: string;
  line: number;
  fn: string | null;
}

/** JSON shape the pass prints (validated loosely on the TS side). */
export interface RawIntrospection {
  ok?: boolean;
  target?: string | null;
  frames?: { path?: string | null; line?: number; fn?: string | null; code?: string | null }[];
  operands?: {
    expr?: string;
    type?: string;
    mro?: string[];
    preds?: string[];
    falsy?: string[];
    attrs?: string[];
    frame?: { path?: string | null; line?: number; fn?: string | null; code?: string | null } | null;
    receiver?: boolean;
  }[];
  module?: string | null;
  module_names?: string[];
  note?: string;
}

function pyLiteral(v: unknown): string {
  return JSON.stringify(v);
}

/** The introspection pass alone (appended to the repro script; exported so the unit tests can read it). */
export function introspectPass(anchors: readonly IntrospectAnchor[]): string {
  return [
    '',
    '# ---- introspection pass (src/synth/introspect/script.ts)',
    'import keyword as _kw, linecache as _lc, re as _re, types as _types',
    `ISENT = ${pyLiteral(INTROSPECT_SENTINEL)}`,
    `ANCHORS = json.loads(${pyLiteral(pyLiteral(anchors))})`,
    `FRAMES_MAX = ${FRAMES_MAX}`,
    `OPERANDS_MAX = ${OPERANDS_MAX}`,
    `ATTRS_MAX = ${ATTRS_PER_OBJECT_MAX}`,
    `MODULE_NAMES_MAX = ${MODULE_NAMES_RAW_MAX}`,
    '_WSR = os.path.realpath(WS)',
    '_out = {"ok": True, "target": None, "frames": [], "operands": [], "module": None, "module_names": [], "note": ""}',
    '_KW = set(_kw.kwlist)',
    '_NAME_RE = _re.compile(r"(?<![\\w.])[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*")',
    '_SKIP = object()',
    '_SKIP_TYPES = (_types.ModuleType, _types.FunctionType, _types.BuiltinFunctionType, _types.MethodType, _types.BuiltinMethodType)',
    '',
    'def _rel(path):',
    '    # a real file under the workspace; `<repro>` / `<jevcode-repro>` pseudo-files would resolve against the cwd',
    '    if not path or path.startswith("<"):',
    '        return None',
    '    try:',
    '        rp = os.path.realpath(path)',
    '        if not os.path.isfile(rp):',
    '            return None',
    '    except Exception:',
    '        return None',
    '    if rp.startswith(_WSR + os.sep):',
    '        return os.path.relpath(rp, _WSR)',
    '    return None',
    '',
    'def _mro(o):',
    '    try:',
    '        t = o if isinstance(o, type) else type(o)',
    '        return [c.__name__ for c in t.__mro__ if c is not object][:40]',
    '    except Exception:',
    '        return []',
    '',
    'def _attrs(o):',
    '    try:',
    '        names = sorted(n for n in dir(o) if not n.startswith("_"))',
    '    except Exception:',
    '        return [], [], []',
    '    preds, falsy, attrs = [], [], []',
    '    for n in names:',
    '        if n.startswith("is_") and not isinstance(o, type):',
    '            try:',
    '                v = getattr(o, n)',
    '            except Exception:',
    '                v = _SKIP',
    '            if v is _SKIP or callable(v):',
    '                attrs.append(n)',
    '                continue',
    '            preds.append(n)',
    '            if not v:',
    '                falsy.append(n)',
    '        else:',
    '            attrs.append(n)',
    '    return preds, falsy, attrs[:ATTRS_MAX]',
    '',
    'def _record(expr, val, frame, receiver_ids):',
    '    if val is None or isinstance(val, _SKIP_TYPES):',
    '        return None',
    '    preds, falsy, attrs = _attrs(val)',
    '    return {"expr": expr, "type": val.__name__ if isinstance(val, type) else type(val).__name__, "mro": _mro(val), "preds": preds, "falsy": falsy, "attrs": attrs, "frame": frame, "receiver": id(val) in receiver_ids}',
    '',
    'def _dotted(line):',
    '    out = []',
    '    for m in _NAME_RE.finditer(line or ""):',
    '        parts = m.group(0).split(".")',
    '        if parts[0] in _KW:',
    '            continue',
    '        for k in range(len(parts), 0, -1):',
    '            p = ".".join(parts[:k])',
    '            if p not in out:',
    '                out.append(p)',
    '    return out',
    '',
    'def _module_names(modname):',
    '    mod = sys.modules.get(modname) if modname else None',
    '    if mod is None:',
    '        return []',
    '    try:',
    '        names = [n for n in dir(mod) if not n.startswith("_")]',
    '    except Exception:',
    '        return []',
    '    own = [n for n in names if getattr(getattr(mod, n, None), "__module__", None) == modname]',
    '    rest = [n for n in names if n not in own]',
    '    return (own + rest)[:MODULE_NAMES_MAX]',
    '',
    'def _frame_info(x):',
    '    return {"path": x["path"], "line": x["line"], "fn": x["fn"], "code": x["code"]}',
    '',
    'def _walk(tb):',
    '    fr = []',
    '    while tb is not None:',
    '        f = tb.tb_frame',
    '        code = (_lc.getline(f.f_code.co_filename, tb.tb_lineno) or "").strip() or None',
    '        fr.append({"path": _rel(f.f_code.co_filename), "line": tb.tb_lineno, "fn": f.f_code.co_name, "code": code, "frame": f})',
    '        tb = tb.tb_next',
    '    return fr',
    '',
    'def _anchored(x):',
    '    for a in ANCHORS:',
    '        afile = (a.get("file") or "").replace("\\\\", "/")',
    '        if x["fn"] == a.get("fn") and x["path"] and (afile.endswith(x["path"]) or afile.split("/")[-1] == x["path"].split("/")[-1]):',
    '            return True',
    '    return False',
    '',
    'def _introspect_exception(node, src):',
    '    rec2 = {"value": None, "stdout": ""}',
    '    try:',
    '        run_node(node, src, rec2)',
    '    except BaseException as e:',
    '        fr = _walk(e.__traceback__)',
    '    else:',
    '        _out["note"] = "the statement did not raise on the second run"',
    '        return False',
    '    ws = [x for x in fr if x["path"] is not None]',
    '    _out["frames"] = [_frame_info(x) for x in ws]',
    '    if not ws:',
    '        # raised in the snippet itself (an assert, a bare comparison): the statement\'s own operands are what there is',
    '        _out["note"] = "no traceback frame inside the workspace; operands of the statement itself"',
    '        return _introspect_value(node)',
    '    innermost = ws[-1]',
    '    # the raising frame, then the anchored frames and the rest, each innermost first (the caller of the raising frame holds the operands of the failing call)',
    '    chosen = [innermost] + [x for x in reversed(ws) if _anchored(x) and x is not innermost]',
    '    for x in reversed(ws):',
    '        if x not in chosen:',
    '            chosen.append(x)',
    '    chosen = chosen[:FRAMES_MAX]',
    '    f0 = innermost["frame"]',
    '    receiver_ids = set()',
    '    for name in f0.f_code.co_varnames[: f0.f_code.co_argcount]:',
    '        if name in f0.f_locals:',
    '            receiver_ids.add(id(f0.f_locals[name]))',
    '    anchor = next((x for x in chosen if _anchored(x)), None)',
    '    modframe = (anchor or innermost)["frame"]',
    '    _out["module"] = modframe.f_globals.get("__name__")',
    '    _out["module_names"] = _module_names(_out["module"])',
    '    for x in chosen:',
    '        f = x["frame"]',
    '        n = 0',
    '        for expr in _dotted(x["code"]):',
    '            if n >= OPERANDS_MAX:',
    '                break',
    '            try:',
    '                val = eval(expr, f.f_globals, f.f_locals)',
    '            except Exception:',
    '                continue',
    '            rec = _record(expr, val, _frame_info(x), receiver_ids)',
    '            if rec is not None:',
    '                _out["operands"].append(rec)',
    '                n += 1',
    '    return True',
    '',
    'def _introspect_value(node):',
    '    expr_node = node.value if isinstance(node, ast.Expr) else getattr(node, "value", None)',
    '    if expr_node is None:',
    '        _out["note"] = "the target statement has no expression to evaluate"',
    '        return False',
    '    subs = []',
    '    for sub in ast.walk(expr_node):',
    '        if isinstance(sub, (ast.Name, ast.Attribute, ast.Call, ast.Subscript)):',
    '            subs.append(sub)',
    '    subs.sort(key=lambda s: 0 if isinstance(s, (ast.Name, ast.Attribute)) else 1)',
    '    callee = expr_node.func if isinstance(expr_node, ast.Call) else None',
    '    seen = set()',
    '    n = 0',
    '    sink = io.StringIO()',
    '    for sub in subs:',
    '        if n >= OPERANDS_MAX:',
    '            break',
    '        try:',
    '            text = ast.unparse(sub) if hasattr(ast, "unparse") else ast.dump(sub)',
    '        except Exception:',
    '            continue',
    '        if text in seen:',
    '            continue',
    '        seen.add(text)',
    '        try:',
    '            with contextlib.redirect_stdout(sink):',
    '                val = eval(compile(ast.Expression(body=sub), "<introspect>", "eval"), ns)',
    '        except Exception:',
    '            continue',
    '        if sub is callee:',
    '            _out["module"] = getattr(val, "__module__", None)',
    '            continue',
    '        rec = _record(text, val, None, set())',
    '        if rec is not None:',
    '            _out["operands"].append(rec)',
    '            n += 1',
    '    if _out["module"] is None and callee is not None:',
    '        try:',
    '            _out["module"] = getattr(eval(compile(ast.Expression(body=callee), "<introspect>", "eval"), ns), "__module__", None)',
    '        except Exception:',
    '            pass',
    '    _out["module_names"] = _module_names(_out["module"])',
    '    return True',
    '',
    'def _introspect():',
    '    evidence = [r for r in results if r.get("chunk", -1) >= 0 and not r.get("environment") and r.get("kind") != "syntax_error"]',
    '    raised = [r for r in evidence if r.get("exception")]',
    '    valued = [r for r in evidence if r.get("value") is not None]',
    '    target = raised[-1] if raised else (valued[-1] if valued else (evidence[-1] if evidence else None))',
    '    if target is None:',
    '        _out["ok"] = False',
    '        _out["note"] = "no statement to introspect"',
    '        return',
    '    _out["target"] = target.get("source")',
    '    src = CHUNKS[target["chunk"]]',
    '    node = ast.parse(src).body[target["stmt"]]',
    '    if target.get("exception"):',
    '        _introspect_exception(node, src)',
    '    else:',
    '        _introspect_value(node)',
    '',
    'try:',
    '    _introspect()',
    'except BaseException as _e:',
    '    _out["ok"] = False',
    '    _out["note"] = "introspection failed: %s: %s" % (type(_e).__name__, clip(_e))',
    'sys.stdout.flush()',
    'sys.stdout.write("\\n" + ISENT + json.dumps(_out, default=str) + "\\n")',
    '',
  ].join('\n');
}

/** The repro script for `chunks` with the introspection pass appended. */
export function buildIntrospectScript(chunks: readonly string[], opts: ReproScriptOptions, anchors: readonly IntrospectAnchor[] = []): string {
  return `${buildReproScript(chunks, opts)}\n${introspectPass(anchors)}`;
}

/** Anchors the pass matches frames against, from the oracle's judged frames (file suffix + function name). */
export function anchorsOf(frames: readonly TracebackFrame[]): IntrospectAnchor[] {
  return frames.map((f) => ({ file: f.file, line: f.line, fn: f.fn }));
}

/** The shell command that runs the introspection script (same interpreter pick as the oracle runner). */
export function introspectCommand(script: string, opts: { workspace: string; python?: string; env?: Record<string, string> }): string {
  return reproCommand(script, opts);
}

/** The pass's JSON, or null when the sentinel is missing or unparseable. */
export function parseIntrospectOutput(stdout: string): RawIntrospection | null {
  const at = stdout.lastIndexOf(INTROSPECT_SENTINEL);
  if (at === -1) return null;
  const line = stdout.slice(at + INTROSPECT_SENTINEL.length).split('\n')[0] ?? '';
  try {
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    return raw as RawIntrospection;
  } catch {
    return null;
  }
}
