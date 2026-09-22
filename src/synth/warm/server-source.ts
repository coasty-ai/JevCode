/**
 * The warm lane runner's Python source (docs/HARNESS-NEXT-DESIGN.md §3 M6, wave S1).
 *
 * Kept as a TypeScript string for the same reason `src/bench/quixbugs/pytest.ts` is: the harness
 * ships as one bundled `dist/jevcode.mjs`, so a sibling `.py` file would not be there at runtime,
 * and the pytest lane mode has no bench directory to anchor a checked-in script to. The source is
 * written once per run into `<runDir>/tmp/synth/warm/` (inside the seatbelt's writable roots) and
 * started through `ctx.sandbox.run`, so the worker inherits the profile, the env scrub, the
 * redaction and the three-pass tree kill of the cold path without a second spawn implementation.
 *
 * `test/unit/synth/warm/server-source.test.ts` compiles it with the interpreter, so a syntax error
 * fails `npm test` rather than a live run.
 */

/** stdout line the worker prints once its FIFOs exist; the TS side waits for it before connecting. */
export const WARM_READY_PREFIX = 'JEVCODE_WARM_READY';
/** FIFO names inside the worker's own directory. */
export const WARM_REQ_FIFO = 'req';
export const WARM_RESP_FIFO = 'resp';

export const WARM_SERVER_PY = `#!/usr/bin/env python3
"""JevCode warm lane runner (docs/HARNESS-NEXT-DESIGN.md M6): one persistent, sandboxed
interpreter per lane that pays interpreter start and \`import pytest\` once and then forks per
candidate, so a candidate run costs milliseconds instead of the measured 67-183 ms.

Transport: two FIFOs in --dir, created here so the harness needs no mkfifo(2) binding.
Newline-delimited JSON requests on 'req', newline-delimited JSON responses on 'resp'. Readiness
is announced on stdout as 'JEVCODE_WARM_READY <pid>'. The process exits when 'req' reaches EOF
(the harness closed its end, including by dying), when the harness does not attach within
--connect-ms of the announcement (opening a FIFO blocks until the peer opens, and a harness that
gave up on the boot would otherwise leave this process blocked there), on --idle-ms without a
request, on --max-ms of life, or on {"op":"shutdown"}.

Isolation is the cold path's, not a weaker one:
  * every candidate runs in a fork() of this process in its own session (setsid), so it has its
    own address space and its own process group; nothing it writes to module globals, to
    sys.modules or to open files can reach the next candidate;
  * the per-case SIGKILL timeout is kept -- each JSON case is its own fork() with its own
    deadline, enforced by select() + SIGKILL, exactly as run_tests.py's per-case subprocess
    timeout does;
  * the whole candidate run has a wall deadline enforced with killpg(SIGKILL);
  * PYTHONDONTWRITEBYTECODE is set here as well as by the harness, so no .pyc can go stale;
  * the seatbelt applies, because the harness starts this process through its own sandbox.

Invalidation, in two layers. The warm parent aims to import nothing from --root (repeatable: the
workspace and the lane): _prewarm() refuses any module that resolves under a root, so a candidate
edit cannot be masked by a module this process already holds. Whatever the parent *did* import
from under a root is hashed at boot, and re-hashed before every request: a file added, removed
or changed answers "invalidate", and the harness then runs that candidate cold and restarts the
worker. Any exception in the parent is a fatal error answer, with the same consequence.
"""
import argparse
import errno
import hashlib
import json
import os
import select
import signal
import sys
import time

READY = "JEVCODE_WARM_READY"
PREWARM_MAX = 500
REAP_GRACE_S = 2.0
READ_CHUNK = 65536


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(READ_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _under(path, roots):
    try:
        real = os.path.realpath(path)
    except OSError:
        return False
    for r in roots:
        if real == r or real.startswith(r + os.sep):
            return True
    return False


def _workspace_imports(roots):
    """{realpath: sha256} for every loaded module whose file lies under a workspace root."""
    seen = {}
    for _name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if not isinstance(f, str) or not f or not _under(f, roots):
            continue
        real = os.path.realpath(f)
        try:
            seen[real] = _sha256(f)
        except OSError:
            seen[real] = "<unreadable>"
    return seen


def _kill(pid, group):
    try:
        if group:
            os.killpg(pid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def _reap(pid):
    end = time.monotonic() + REAP_GRACE_S
    while True:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except OSError:
            return None
        if done == pid:
            return status
        if time.monotonic() >= end:
            return None
        time.sleep(0.0005)


def _drain(fds, deadlines, on_expire):
    """Read every fd until EOF or its own deadline. Returns {fd: bytes}; expired fds call on_expire(fd)."""
    buf = {}
    for fd in fds:
        buf[fd] = []
    live = set(fds)
    while live:
        now = time.monotonic()
        for fd in list(live):
            if now >= deadlines[fd]:
                on_expire(fd)
                live.discard(fd)
        if not live:
            break
        wait = max(0.0, min(deadlines[fd] for fd in live) - now)
        try:
            ready, _w, _x = select.select(list(live), [], [], wait)
        except (OSError, ValueError):
            break
        except InterruptedError:
            continue
        for fd in ready:
            try:
                chunk = os.read(fd, READ_CHUNK)
            except OSError as e:
                if e.errno == errno.EINTR:
                    continue
                live.discard(fd)
                continue
            if not chunk:
                live.discard(fd)
            else:
                buf[fd].append(chunk)
    return dict((fd, b"".join(parts)) for fd, parts in buf.items())


def _text(raw):
    return raw.decode("utf-8", "replace")


class Quixbugs(object):
    """run_tests.py imported once; its case semantics are reused, never re-implemented."""

    def __init__(self, directory):
        import importlib.util
        script = os.path.join(directory, "run_tests.py")
        spec = importlib.util.spec_from_file_location("jevcode_run_tests", script)
        mod = importlib.util.module_from_spec(spec)
        # registered so it is part of the tracked import set: if a candidate ever edits the
        # runner itself, the content hash sees it and this parent is invalidated
        sys.modules["jevcode_run_tests"] = mod
        spec.loader.exec_module(mod)
        self.rt = mod

    def _case_child(self, module, name, case, w):
        rt = self.rt
        import copy
        import types
        # run_tests.py's children send what the candidate prints to stderr; the protocol has its own pipe
        sys.stdout = sys.stderr
        try:
            fn = getattr(module, name)
            actual = fn(*copy.deepcopy(case["input"]))
            if isinstance(actual, types.GeneratorType):
                actual = list(actual)
            status = "pass" if rt._compare(name, actual, case["expected"], case["input"]) else "fail"
            payload = {"status": status, "actual": repr(actual)}
        except BaseException as exc:
            payload = {"status": "error", "actual": rt._exc_text(exc)}
        try:
            os.write(w, (json.dumps(payload) + "\\n").encode("utf-8", "replace"))
        except (OSError, ValueError):
            pass
        os._exit(0)

    def _run_cases(self, module, name, cases, timeout, include_slow, jobs):
        """One fork() per case in waves of --jobs, each case under its own deadline: run_tests.py's
        pool-of-subprocesses shape at fork cost, with the per-case SIGKILL kept."""
        rt = self.rt
        results = [None] * len(cases)
        for i, case in enumerate(cases):
            if case.get("slow") and not include_slow:
                results[i] = {"status": "skipped", "actual": "skipped (slow; pass --slow)"}
        pending = [i for i in range(len(cases)) if results[i] is None]
        width = max(1, jobs)
        for start in range(0, len(pending), width):
            wave = pending[start:start + width]
            by_fd = {}
            deadlines = {}
            limits = {}
            for i in wave:
                limit = max(timeout, float(cases[i].get("timeout", 0)))
                limits[i] = limit
                r, w = os.pipe()
                pid = os.fork()
                if pid == 0:
                    try:
                        os.close(r)
                        self._case_child(module, name, cases[i], w)
                    except BaseException:
                        os._exit(70)
                os.close(w)
                by_fd[r] = (i, pid)
                deadlines[r] = time.monotonic() + limit + 0.05
            expired = set()
            raw = _drain(list(by_fd), deadlines, expired.add)
            for fd, (i, pid) in by_fd.items():
                if fd in expired:
                    _kill(pid, False)
                    _reap(pid)
                    results[i] = {"status": "timeout", "actual": "TIMEOUT after %gs" % limits[i]}
                else:
                    _reap(pid)
                    parsed = rt._last_json_line(_text(raw.get(fd, b"")))
                    results[i] = parsed or {"status": "error", "actual": "child produced no result: "}
                try:
                    os.close(fd)
                except OSError:
                    pass
        return [dict({"input": c["input"], "expected": c["expected"]}, **r) for c, r in zip(cases, results)]

    def _run_module(self, name, path, test_file, timeout):
        """run_tests.py's _child_module in this fork: the module's tests share state, as under pytest."""
        import importlib.util
        import re
        import types
        rt = self.rt
        with open(test_file) as f:
            expected_names = re.findall(r"^def (test\\w*)\\(", f.read(), re.M)
        try:
            rt._load_candidate(name, path)
            spec = importlib.util.spec_from_file_location(name + "_test", test_file)
            tmod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(tmod)
        except BaseException as exc:
            text = rt._exc_text(exc, test_file)
            return [{"input": t, "expected": "pass", "status": "error", "actual": "import error: " + text}
                    for t in expected_names]
        tests = [(k, v) for k, v in vars(tmod).items() if k.startswith("test") and isinstance(v, types.FunctionType)]
        docs = {}
        for k, v in tests:
            docs[k] = (v.__doc__ or "").strip().splitlines()[0] if v.__doc__ else ""
        signal.signal(signal.SIGALRM, rt._alarm)
        results = []
        for k, fn in tests:
            signal.setitimer(signal.ITIMER_REAL, timeout)
            try:
                fn()
                r = {"status": "pass", "actual": "pass"}
            except rt._Timeout:
                r = {"status": "timeout", "actual": "TIMEOUT after %gs" % timeout}
            except AssertionError as exc:
                r = {"status": "fail", "actual": rt._exc_text(exc, test_file)}
            except BaseException as exc:
                r = {"status": "error", "actual": rt._exc_text(exc, test_file)}
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
            label = ("%s: %s" % (k, docs[k])) if docs.get(k) else k
            results.append({"input": label, "expected": "pass", "status": r["status"], "actual": r["actual"]})
        return results

    def run(self, req, meta_w):
        rt = self.rt
        name = req["name"]
        path = os.path.abspath(req["path"])
        timeout = float(req.get("timeout", 2.0))
        include_slow = bool(req.get("slow", False))
        max_failures = int(req.get("maxFailures", 5))
        jobs = int(req.get("jobs", 0)) or min(8, os.cpu_count() or 1)
        # run_tests.py's children write the protocol on a dup of fd 1 and send prints to stderr
        proto = os.fdopen(os.dup(1), "w")
        os.dup2(2, 1)
        sys.stdout = sys.stderr
        json_tests = os.path.join(rt.TESTS_DIR, name + ".json")
        module_tests = os.path.join(rt.TESTS_DIR, name + "_test.py")
        if not os.path.isfile(path):
            proto.write(json.dumps({"name": name, "error": "candidate not found: " + path}) + "\\n")
            proto.flush()
            return 2
        if os.path.isfile(json_tests):
            with open(json_tests) as f:
                cases = json.load(f)
            try:
                module = rt._load_candidate(name, path)
            except BaseException as exc:
                text = rt._exc_text(exc)
                results = [{"input": c["input"], "expected": c["expected"], "status": "error", "actual": text}
                           for c in cases]
            else:
                results = self._run_cases(module, name, cases, timeout, include_slow, jobs)
        elif os.path.isfile(module_tests):
            results = self._run_module(name, path, module_tests, timeout)
        else:
            proto.write(json.dumps({"name": name, "error": "no tests for %s in %s" % (name, rt.TESTS_DIR)}) + "\\n")
            proto.flush()
            return 2
        counts = {}
        for s in ("pass", "fail", "error", "timeout", "skipped"):
            counts[s] = sum(1 for r in results if r["status"] == s)
        report = {
            "name": name,
            "passed": counts["pass"],
            "failed": counts["fail"],
            "errors": counts["error"] + counts["timeout"],
            "timeouts": counts["timeout"],
            "skipped": counts["skipped"],
            "total": len(results),
            "failures": [{"input": r["input"], "expected": r["expected"], "actual": r["actual"]}
                         for r in results if r["status"] not in ("pass", "skipped")][:max_failures],
        }
        proto.write(json.dumps(report) + "\\n")
        proto.flush()
        ok = report["total"] > 0 and report["failed"] == 0 and report["errors"] == 0
        return 0 if ok else 1


class Pytest(object):
    def __init__(self):
        import pytest
        self.pytest = pytest
        self.prewarmed = False

    def run(self, req, meta_w):
        args = [str(a) for a in req.get("args", [])]
        for k, v in (req.get("env") or {}).items():
            os.environ[str(k)] = str(v)
        for k in (req.get("envUnset") or []):
            os.environ.pop(str(k), None)
        # 'python -m pytest' puts the cwd first on sys.path; this process was started as a script,
        # so its own directory is there instead. Match the cold command byte for byte.
        if sys.path:
            sys.path[0] = os.getcwd()
        code = self.pytest.main(args)
        code = int(getattr(code, "value", code))
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except (OSError, ValueError):
            pass
        if meta_w is not None:
            names = []
            for name, mod in list(sys.modules.items()):
                f = getattr(mod, "__file__", None)
                if isinstance(f, str) and f and not name.startswith("__"):
                    names.append([name, os.path.realpath(f)])
            try:
                os.write(meta_w, (json.dumps({"modules": names[:PREWARM_MAX]}) + "\\n").encode("utf-8", "replace"))
            except (OSError, ValueError):
                pass
        return code


def _fork_candidate(handler, req, deadline_s, want_meta):
    """Run one candidate in a fork; returns (stdout, stderr, exit, timed_out, meta)."""
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    meta_r, meta_w = os.pipe() if want_meta else (None, None)
    pid = os.fork()
    if pid == 0:
        code = 70
        try:
            os.close(out_r)
            os.close(err_r)
            if meta_r is not None:
                os.close(meta_r)
            os.setsid()
            os.dup2(out_w, 1)
            os.dup2(err_w, 2)
            if out_w > 2:
                os.close(out_w)
            if err_w > 2:
                os.close(err_w)
            sys.stdout = os.fdopen(1, "w", buffering=1)
            sys.stderr = os.fdopen(2, "w", buffering=1)
            code = int(handler.run(req, meta_w))
        except BaseException:
            try:
                sys.stderr.write("jevcode warm child: " + repr(sys.exc_info()[1]) + "\\n")
                sys.stderr.flush()
            except BaseException:
                pass
        finally:
            os._exit(code & 0xFF)
    os.close(out_w)
    os.close(err_w)
    if meta_w is not None:
        os.close(meta_w)
    fds = [out_r, err_r] + ([meta_r] if meta_r is not None else [])
    deadline = time.monotonic() + deadline_s
    deadlines = dict((fd, deadline) for fd in fds)
    expired = []
    raw = _drain(fds, deadlines, expired.append)
    timed_out = len(expired) > 0
    if timed_out:
        _kill(pid, True)
    status = _reap(pid)
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass
    code = None
    if status is not None and os.WIFEXITED(status):
        code = os.WEXITSTATUS(status)
    meta = None
    if meta_r is not None:
        line = _text(raw.get(meta_r, b"")).strip()
        if line:
            try:
                meta = json.loads(line.splitlines()[-1])
            except ValueError:
                meta = None
    return _text(raw.get(out_r, b"")), _text(raw.get(err_r, b"")), code, timed_out, meta


def _prewarm(entries, roots):
    """Pre-import the third-party modules a first pytest run needed. A module whose file the child
    reported as living under a workspace root is never imported here, and one that turns out to
    resolve into the workspace is dropped and ends the warming: the warm parent must hold nothing
    a later candidate could edit. That invariant is re-checked by hash before every request."""
    import importlib
    done = 0
    for entry in entries:
        if done >= PREWARM_MAX:
            break
        if not isinstance(entry, list) or len(entry) != 2:
            continue
        name, path = entry[0], entry[1]
        if not isinstance(name, str) or not isinstance(path, str):
            continue
        if name in sys.modules or _under(path, roots):
            continue
        try:
            mod = importlib.import_module(name)
        except BaseException:
            continue
        f = getattr(mod, "__file__", None)
        if isinstance(f, str) and f and _under(f, roots):
            sys.modules.pop(name, None)
            return done
        done += 1
    return done


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--mode", required=True, choices=["quixbugs", "pytest"])
    ap.add_argument("--quixbugs-dir", default=None)
    ap.add_argument("--root", action="append", default=[])
    ap.add_argument("--idle-ms", type=int, default=300000)
    ap.add_argument("--max-ms", type=int, default=1800000)
    ap.add_argument("--connect-ms", type=int, default=30000)
    args = ap.parse_args(argv)

    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True
    roots = [os.path.realpath(r) for r in args.root if r]
    req_path = os.path.join(args.dir, "req")
    resp_path = os.path.join(args.dir, "resp")
    for p in (req_path, resp_path):
        try:
            os.unlink(p)
        except OSError:
            pass
        os.mkfifo(p, 0o600)

    try:
        if args.mode == "quixbugs":
            handler = Quixbugs(args.quixbugs_dir or os.getcwd())
        else:
            handler = Pytest()
    except BaseException as exc:
        sys.stderr.write("jevcode warm boot failed: " + repr(exc) + "\\n")
        sys.stderr.flush()
        return 3
    # the import set this interpreter is allowed to hold, by content hash; anything that differs
    # later means a candidate edited a module the parent already has, and the parent is stale
    baseline = _workspace_imports(roots)

    sys.stdout.write(READY + " " + str(os.getpid()) + "\\n")
    sys.stdout.flush()

    # Opening a FIFO blocks until the peer opens its end. A harness that gave up on this boot
    # never will, so the wait is bounded and a stranded worker exits instead of lingering.
    def _give_up(_signum, _frame):
        raise TimeoutError("the harness did not attach")

    signal.signal(signal.SIGALRM, _give_up)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, args.connect_ms / 1000.0))
    try:
        req = open(req_path, "r")
        resp = open(resp_path, "w")
    except (TimeoutError, OSError):
        return 8
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, signal.SIG_DFL)
    started = time.monotonic()
    prewarm_names = None

    def reply(obj):
        resp.write(json.dumps(obj) + "\\n")
        resp.flush()

    while True:
        if (time.monotonic() - started) * 1000.0 > args.max_ms:
            return 0
        ready, _w, _x = select.select([req], [], [], max(0.001, args.idle_ms / 1000.0))
        if not ready:
            return 0
        line = req.readline()
        if line == "":
            return 0
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            reply({"id": None, "ok": False, "error": "malformed request", "fatal": True})
            return 5
        rid = msg.get("id")
        op = msg.get("op")
        if op == "shutdown":
            reply({"id": rid, "ok": True})
            return 0
        if op == "ping":
            reply({"id": rid, "ok": True, "pid": os.getpid()})
            continue
        if op != "run":
            reply({"id": rid, "ok": False, "error": "unknown op " + repr(op), "fatal": True})
            return 5
        current = _workspace_imports(roots)
        if current != baseline:
            changed = sorted(set(current) ^ set(baseline)) or sorted(p for p in current if current[p] != baseline.get(p))
            reply({"id": rid, "ok": False, "invalidate": changed[0] if changed else "?"})
            return 6
        t0 = time.monotonic()
        want_meta = args.mode == "pytest" and prewarm_names is None
        try:
            out, err, code, timed_out, meta = _fork_candidate(
                handler, msg, max(0.001, float(msg.get("deadlineMs", 120000)) / 1000.0), want_meta)
        except BaseException as exc:
            reply({"id": rid, "ok": False, "error": "warm parent: " + repr(exc), "fatal": True})
            return 7
        ms = (time.monotonic() - t0) * 1000.0
        reply({"id": rid, "ok": True, "stdout": out, "stderr": err, "exit": code,
               "timedOut": bool(timed_out), "ms": round(ms, 3)})
        if want_meta and isinstance(meta, dict):
            prewarm_names = meta.get("modules", [])
            try:
                _prewarm(prewarm_names, roots)
            except BaseException:
                pass
            if _workspace_imports(roots) != baseline:
                return 6


if __name__ == "__main__":
    sys.exit(main() or 0)
`;
