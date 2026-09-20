/**
 * The Python line tracer (see ./trace_lines.py for the design notes), embedded as a string so a
 * run can write it into its tmp dir without shipping loose files in the bundle.
 *
 * TRACE_LINES_PY must equal trace_lines.py byte for byte; test/unit/synth/sbfl/tracer.test.ts
 * enforces it. To regenerate after editing the .py, paste the file's content between the
 * backticks (the source must not contain a backtick or "${"; String.raw keeps backslashes).
 */
export const TRACER_FILENAME = 'trace_lines.py';

export const TRACE_LINES_PY: string = String.raw`"""Per-test line coverage for spectrum-based fault localisation (stdlib only, Python >= 3.9).

Usage:  python3 trace_lines.py < spec.json        (parent; one JSON object per test on stdout)
        python3 trace_lines.py --child < spec.json (internal; one test, one JSON object)

Spec (stdin JSON):
  {"mode": "pytest" | "call", "cwd": str, "files": [str], "tests": [...], "timeoutSec": number}
  pytest test: "tests/test_x.py::test_fn" or {"id": nodeid}
  call test:   {"id": str, "module": str, "fn": str, "args": [...], "expected": ..., "tolerance": float?}
               'module' is an importable name (from cwd) or a path ending in .py.

Per-test result (one JSON line, keys sorted):
  {"id": str, "outcome": "pass" | "fail" | "error" | "timeout" | "skip",
   "lines": {file-as-given: [line, ...]}, "exception": {"type": str, "message": str} | null,
   "durationMs": int, "actual": str (call mode, on fail), "log": str (stderr tail, not on pass)}

Design: the parent runs every test in a fresh child subprocess (this same file with --child), so
the interpreter state is clean, an infinite loop or crash in one test cannot take the others
down, and a wall-clock backstop (subprocess timeout) exists even when the in-process alarm cannot
fire (a test stuck inside a C call). Inside the child, 'signal.setitimer' (the alarm) raises
_SbflTimeout so the child itself can report "timeout" together with the lines executed so far.
sys.settrace is filtered by realpath(co_filename) against 'files', and only "line" events are
recorded; the trace is armed around the test only (after imports / pytest collection) so the
spectrum is the test body's execution, not module-level definitions.

pytest mode runs 'pytest.main([nodeid, ...], plugins=[_PytestCapture])' in-process in the child:
the project's conftest, fixtures, parametrisation, markers and plugins all work, and the plugin
reads the outcome from 'pytest_runtest_makereport' (AssertionError -> fail, other -> error,
Skipped -> skip). If pytest is not importable the child falls back to a minimal stdlib runner
that imports the test file by path and calls 'test_fn' / 'Class().method' with no arguments;
fixtures and parametrised ids are reported as outcome "error" in that fallback. Setting the
environment variable SBFL_NO_PYTEST=1 forces the fallback (used by the unit tests).

fd 1 is redirected onto fd 2 at child start-up, so anything the test (or pytest) prints goes to
the parent's stderr capture (kept as a tail in "log") and the result JSON, written on a dup of the
original stdout, is the only thing on the child's stdout.
"""
import collections.abc
import importlib
import importlib.util
import inspect
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time

CHILD_GRACE_SEC = 2.0
LOG_TAIL_BYTES = 2048
MESSAGE_MAX_CHARS = 2000
REPR_MAX_CHARS = 500
DEFAULT_TIMEOUT_SEC = 10.0
DEFAULT_FLOAT_TOLERANCE = 1e-6
EXIT_BAD_SPEC = 2

_TIMED_OUT = False


class _SbflTimeout(BaseException):
    """Raised in the main thread by the alarm handler. A BaseException so that 'except
    Exception' in test code, and pytest's own exception capture, cannot hide it."""


# ---------------------------------------------------------------------------------------------
# Coverage collection
# ---------------------------------------------------------------------------------------------


class _Collector:
    def __init__(self, cwd, files):
        self._keys = {}
        for f in files:
            self._keys[os.path.realpath(os.path.join(cwd, f))] = f
        self._cache = {}
        self.lines = {}
        for f in files:
            self.lines[f] = set()

    def _key(self, co_filename):
        try:
            return self._cache[co_filename]
        except KeyError:
            pass
        key = None
        if co_filename and not co_filename.startswith('<'):
            key = self._keys.get(os.path.realpath(co_filename))
        self._cache[co_filename] = key
        return key

    def _local(self, frame, event, arg):
        if event == 'line':
            key = self._key(frame.f_code.co_filename)
            if key is not None and frame.f_lineno is not None:
                self.lines[key].add(frame.f_lineno)
        return self._local

    def _global(self, frame, event, arg):
        if event == 'call' and self._key(frame.f_code.co_filename) is not None:
            return self._local
        return None

    def start(self):
        threading.settrace(self._global)
        sys.settrace(self._global)

    def stop(self):
        sys.settrace(None)
        threading.settrace(None)

    def as_json(self):
        out = {}
        for f, s in self.lines.items():
            out[f] = sorted(s)
        return out


# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------


def _trim(text, limit):
    text = str(text)
    if len(text) > limit:
        return text[: limit - 3] + '...'
    return text


def _exc_info(exc):
    return {'type': type(exc).__name__, 'message': _trim(exc, MESSAGE_MAX_CHARS)}


def _repr(value):
    try:
        return _trim(repr(value), REPR_MAX_CHARS)
    except Exception as exc:  # repr itself may fail on hostile objects
        return '<unrepresentable: %s>' % type(exc).__name__


def _tail_bytes(data):
    if not data:
        return ''
    if len(data) > LOG_TAIL_BYTES:
        data = data[-LOG_TAIL_BYTES:]
    return data.decode('utf-8', 'replace')


def _import_path(path):
    name = os.path.splitext(os.path.basename(path))[0]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError('cannot import %s' % path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _arm(timeout_sec):
    def handler(signum, frame):
        global _TIMED_OUT
        _TIMED_OUT = True
        raise _SbflTimeout()

    if hasattr(signal, 'SIGALRM') and hasattr(signal, 'setitimer'):
        signal.signal(signal.SIGALRM, handler)
        signal.setitimer(signal.ITIMER_REAL, max(0.001, float(timeout_sec)))


def _disarm():
    if hasattr(signal, 'SIGALRM') and hasattr(signal, 'setitimer'):
        signal.setitimer(signal.ITIMER_REAL, 0)


def _approx_equal(actual, expected, tolerance):
    """Structural equality as a JSON oracle sees it: bool is not int, floats within a tolerance,
    tuples equal lists (JSON has no tuples), dicts by key."""
    if isinstance(actual, bool) or isinstance(expected, bool):
        return isinstance(actual, bool) and isinstance(expected, bool) and actual == expected
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        if isinstance(actual, float) or isinstance(expected, float):
            if math.isnan(actual) and math.isnan(expected):
                return True
            abs_tol = DEFAULT_FLOAT_TOLERANCE if tolerance is None else float(tolerance)
            return math.isclose(actual, expected, rel_tol=DEFAULT_FLOAT_TOLERANCE, abs_tol=abs_tol)
        return actual == expected
    if isinstance(actual, (list, tuple)) and isinstance(expected, (list, tuple)):
        if len(actual) != len(expected):
            return False
        for a, e in zip(actual, expected):
            if not _approx_equal(a, e, tolerance):
                return False
        return True
    if isinstance(actual, dict) and isinstance(expected, dict):
        if set(actual.keys()) != set(expected.keys()):
            return False
        for k in expected:
            if not _approx_equal(actual[k], expected[k], tolerance):
                return False
        return True
    try:
        return bool(actual == expected)
    except Exception:
        return False


# ---------------------------------------------------------------------------------------------
# Child: call mode
# ---------------------------------------------------------------------------------------------


def _run_call(spec, test, collector):
    cwd = spec['cwd']
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
    module_name = test['module']
    if module_name.endswith('.py') or os.sep in module_name:
        mod = _import_path(os.path.join(cwd, module_name))
    else:
        mod = importlib.import_module(module_name)
    fn = getattr(mod, test['fn'])
    args = test.get('args', [])
    collector.start()
    try:
        actual = fn(*args)
        if isinstance(actual, collections.abc.Iterator):
            actual = list(actual)
    finally:
        collector.stop()
    if _approx_equal(actual, test.get('expected'), test.get('tolerance')):
        return 'pass', None, None
    message = 'expected %s, got %s' % (_repr(test.get('expected')), _repr(actual))
    return 'fail', {'type': 'AssertionError', 'message': _trim(message, MESSAGE_MAX_CHARS)}, _repr(actual)


# ---------------------------------------------------------------------------------------------
# Child: pytest mode (real pytest in-process, or the stdlib fallback)
# ---------------------------------------------------------------------------------------------


def _make_pytest_capture(pytest, collector):
    class _PytestCapture:
        def __init__(self):
            self.outcome = None
            self.exception = None

        @pytest.hookimpl(hookwrapper=True)
        def pytest_runtest_protocol(self, item, nextitem):
            collector.start()
            try:
                yield
            finally:
                collector.stop()

        def pytest_runtest_makereport(self, item, call):
            if call.excinfo is None:
                if call.when == 'call' and self.outcome is None:
                    self.outcome = 'pass'
                return None
            exc = call.excinfo.value
            if isinstance(exc, _SbflTimeout):
                self.outcome = 'timeout'
                self.exception = None
                return None
            if self.outcome in ('timeout', 'fail', 'error'):
                return None  # first decisive phase wins; a teardown error after that is noise
            if call.excinfo.errisinstance(pytest.skip.Exception):
                self.outcome = 'skip'
            elif call.when == 'call' and isinstance(exc, AssertionError):
                self.outcome = 'fail'
            else:
                self.outcome = 'error'
            self.exception = _exc_info(exc)
            return None

    return _PytestCapture()


def _run_pytest(spec, test_id, collector):
    if os.environ.get('SBFL_NO_PYTEST'):
        return _run_fallback(spec, test_id, collector)
    try:
        import pytest
    except ImportError:
        return _run_fallback(spec, test_id, collector)
    capture = _make_pytest_capture(pytest, collector)
    args = [test_id, '-q', '-p', 'no:cacheprovider', '-o', 'addopts=', '--tb=short']
    code = pytest.main(args, plugins=[capture])
    if _TIMED_OUT:
        return 'timeout', None
    if capture.outcome is None:
        return 'error', {'type': 'PytestError', 'message': 'pytest exit code %s; the test did not run' % int(code)}
    return capture.outcome, capture.exception


def _run_fallback(spec, test_id, collector):
    """No pytest available: import the test file by path and call the test with no arguments."""
    path, _, rest = test_id.partition('::')
    if not rest:
        raise ValueError('the fallback runner needs "file.py::name" node ids: %r' % test_id)
    full = os.path.join(spec['cwd'], path)
    for p in (os.path.dirname(full), spec['cwd']):
        if p not in sys.path:
            sys.path.insert(0, p)
    obj = _import_path(full)
    for part in rest.split('::'):
        if '[' in part:
            raise ValueError('parametrised test ids need pytest (not importable): %r' % test_id)
        obj = getattr(obj, part)
        if isinstance(obj, type):
            obj = obj()
    params = [p for p in inspect.signature(obj).parameters.values() if p.default is inspect.Parameter.empty]
    if params:
        raise ValueError('fixtures need pytest (not importable): %s' % ', '.join(p.name for p in params))
    collector.start()
    try:
        obj()
    except AssertionError as exc:
        collector.stop()
        return 'fail', _exc_info(exc)
    finally:
        collector.stop()
    return 'pass', None


# ---------------------------------------------------------------------------------------------
# Child main
# ---------------------------------------------------------------------------------------------


def _child_main():
    result_fd = os.dup(1)
    os.dup2(2, 1)
    spec = json.load(sys.stdin)
    cwd = spec['cwd']
    files = spec['files']
    test = spec['test']
    timeout = float(spec.get('timeoutSec', DEFAULT_TIMEOUT_SEC))
    os.chdir(cwd)
    collector = _Collector(cwd, files)
    outcome, exception, actual = 'error', None, None
    started = time.monotonic()
    try:
        _arm(timeout)
        try:
            if spec['mode'] == 'call':
                outcome, exception, actual = _run_call(spec, test, collector)
            else:
                outcome, exception = _run_pytest(spec, test['id'], collector)
        finally:
            _disarm()
    except _SbflTimeout:
        outcome = 'timeout'
    except BaseException as exc:  # SystemExit / KeyboardInterrupt from the test are errors too
        outcome, exception = 'error', _exc_info(exc)
    finally:
        collector.stop()
    if _TIMED_OUT:
        outcome = 'timeout'
    if outcome == 'timeout':
        exception = {'type': 'Timeout', 'message': 'exceeded %g s' % timeout}
    result = {
        'id': test['id'],
        'outcome': outcome,
        'lines': collector.as_json(),
        'exception': exception,
        'durationMs': int((time.monotonic() - started) * 1000),
    }
    if actual is not None:
        result['actual'] = actual
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    os.write(result_fd, (json.dumps(result, sort_keys=True) + '\n').encode('utf-8'))


# ---------------------------------------------------------------------------------------------
# Parent
# ---------------------------------------------------------------------------------------------


def _bad_spec(message):
    sys.stderr.write('trace_lines: bad spec: %s\n' % message)
    sys.exit(EXIT_BAD_SPEC)


def _normalise_test(raw, mode, index):
    if isinstance(raw, str):
        if mode != 'pytest':
            _bad_spec('tests[%d] must be an object in call mode' % index)
        return {'id': raw}
    if not isinstance(raw, dict):
        _bad_spec('tests[%d] must be a string or an object' % index)
    test = dict(raw)
    if mode == 'call':
        for key in ('module', 'fn'):
            if not isinstance(test.get(key), str):
                _bad_spec('tests[%d].%s must be a string' % (index, key))
        if 'expected' not in test:
            _bad_spec('tests[%d].expected is required' % index)
        if not isinstance(test.get('args', []), list):
            _bad_spec('tests[%d].args must be a list' % index)
        if 'id' not in test:
            test['id'] = '%s(%s)' % (test['fn'], json.dumps(test.get('args', []))[1:-1])
    if not isinstance(test.get('id'), str):
        _bad_spec('tests[%d].id must be a string' % index)
    return test


def _parse_child(proc, test, files):
    line = ''
    for candidate in proc.stdout.decode('utf-8', 'replace').splitlines():
        if candidate.strip():
            line = candidate
    result = None
    if line:
        try:
            result = json.loads(line)
        except ValueError:
            result = None
    if not isinstance(result, dict) or result.get('id') != test['id']:
        result = {
            'id': test['id'],
            'outcome': 'error',
            'lines': dict((f, []) for f in files),
            'exception': {'type': 'ChildCrashed', 'message': 'no result from the child (exit code %s)' % proc.returncode},
            'durationMs': 0,
        }
    if result.get('outcome') != 'pass':
        log = _tail_bytes(proc.stderr)
        if log:
            result['log'] = log
    return result


def _parent_main():
    try:
        spec = json.load(sys.stdin)
    except ValueError as exc:
        _bad_spec('stdin is not JSON: %s' % exc)
    if not isinstance(spec, dict):
        _bad_spec('spec must be an object')
    mode = spec.get('mode')
    if mode not in ('pytest', 'call'):
        _bad_spec('mode must be "pytest" or "call"')
    files = spec.get('files')
    if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
        _bad_spec('files must be a list of paths')
    tests = spec.get('tests')
    if not isinstance(tests, list):
        _bad_spec('tests must be a list')
    timeout = spec.get('timeoutSec', DEFAULT_TIMEOUT_SEC)
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
        _bad_spec('timeoutSec must be a positive number')
    cwd = os.path.abspath(spec.get('cwd') or os.getcwd())
    if not os.path.isdir(cwd):
        _bad_spec('cwd is not a directory: %s' % cwd)
    tests = [_normalise_test(raw, mode, i) for i, raw in enumerate(tests)]

    env = dict(os.environ)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    script = os.path.abspath(__file__)
    for test in tests:
        child_spec = {'mode': mode, 'cwd': cwd, 'files': files, 'test': test, 'timeoutSec': timeout}
        started = time.monotonic()
        try:
            proc = subprocess.run(
                [sys.executable, script, '--child'],
                input=json.dumps(child_spec).encode('utf-8'),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=cwd,
                env=env,
                timeout=float(timeout) + CHILD_GRACE_SEC,
            )
        except subprocess.TimeoutExpired as exc:
            result = {
                'id': test['id'],
                'outcome': 'timeout',
                'lines': dict((f, []) for f in files),
                'exception': {
                    'type': 'Timeout',
                    'message': 'killed by the parent after %g s (the alarm could not fire); coverage lost' % (float(timeout) + CHILD_GRACE_SEC),
                },
                'durationMs': int((time.monotonic() - started) * 1000),
            }
            log = _tail_bytes(exc.stderr)
            if log:
                result['log'] = log
        else:
            result = _parse_child(proc, test, files)
        sys.stdout.write(json.dumps(result, sort_keys=True) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    if '--child' in sys.argv[1:]:
        _child_main()
    else:
        _parent_main()
`;
