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
 * `test/unit/jev-modes/synth/warm/server-source.test.ts` compiles it with the interpreter, so a syntax error
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
  * importing the candidate is inside a deadline too (SIGALRM, at the largest cap any case that
    will run could claim), because the cold path imports it inside each case's own child: a
    module body that never returns reports a TIMEOUT per case here as well, instead of holding
    the lane until the whole run's wall;
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
# src/sandbox/run.ts TAIL_BYTES and the sieve's RUN_OUTPUT_BYTES: a warm run's output is bounded
# exactly where a cold run's is. Without it a chatty candidate's whole output crosses the fifo
# into the harness process, and the two paths summarise the same candidate differently.
TAIL_BYTES = 16384
DEFAULT_OUTPUT_BYTES = 262144
# A warm cap is never cut below this fraction of the cold one, however large the measured
# start-up allowance: a warm timeout only costs the caller a cold re-run, never a verdict.
MIN_DEADLINE_FRACTION = 0.5
# Between a case's own deadline and the read of its pipe: a fork's write-to-read latency.
PIPE_SLACK_S = 0.005
# sandbox-exec + /bin/sh (docs/HARNESS-NEXT-DESIGN.md §3 M6, measured): paid by every cold run
# before its interpreter starts, by no warm one.
SHELL_SPAWN_S = 0.007
# How long a start-up measurement describes the machine it was taken on. The cost being
# corrected for is load-dependent (67-74 ms idle, several hundred under an 8-lane bench), so a
# value taken once at boot goes stale; re-measuring costs two interpreter starts per window.
STARTUP_TTL_S = 15.0
# Bias: the allowance is deliberately over-stated, because a warm cap that is too TIGHT only
# costs the caller a cold re-run (it discards any warm run that hit a deadline), while one that
# is too loose lets a candidate the cold path kills finish warm -- a false negative nothing
# re-checks.
STARTUP_SAFETY = 1.25


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


class _Sink(object):
    """One stream, bounded exactly as src/sandbox/run.ts StreamCollector bounds a cold run's: a
    head of at most 'cap' bytes out of a budget SHARED by the run's streams, then a rolling tail
    of 'tail_bytes', then the same marker and the same omitted-byte count. 'cap=None' is
    unbounded, which is what the per-case pipes inside run_tests.py are on the cold path too."""

    def __init__(self, shared, cap, tail_bytes):
        self.shared = shared
        self.cap = cap
        self.tail_bytes = tail_bytes
        self.parts = []
        self.head_len = 0
        self.tail = b""
        self.seen = 0

    def push(self, chunk):
        self.seen += len(chunk)
        if self.cap is None:
            self.parts.append(chunk)
            self.head_len += len(chunk)
            return
        room = max(0, self.cap - self.shared["head"])
        if room >= len(chunk):
            self.parts.append(chunk)
            self.head_len += len(chunk)
            self.shared["head"] += len(chunk)
            return
        if room > 0:
            self.parts.append(chunk[:room])
            self.head_len += room
            self.shared["head"] += room
        self.shared["truncated"] = True
        self.tail = (self.tail + chunk[room:])[-self.tail_bytes:]

    def finish(self):
        head = b"".join(self.parts)
        if not self.tail:
            return head
        # drop a leading partial UTF-8 sequence so the tail decodes cleanly, as the cold path does
        start = 0
        while start < len(self.tail) and start < 4 and (self.tail[start] & 0xC0) == 0x80:
            start += 1
        dropped = self.seen - self.head_len - len(self.tail)
        marker = "\\n\\u2026[output truncated: %d bytes omitted]\\u2026\\n" % dropped
        return head + marker.encode("utf-8") + self.tail[start:]


def _sinks_for(fds, shared, cap, tail_bytes=TAIL_BYTES):
    return dict((fd, _Sink(shared, cap, tail_bytes)) for fd in fds)


def _drain(fds, deadlines, on_expire, sinks):
    """Read every fd until EOF or its own deadline into its _Sink. Returns {fd: bytes}; expired
    fds call on_expire(fd)."""
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
        except InterruptedError:
            continue
        except (OSError, ValueError):
            break
        for fd in ready:
            try:
                chunk = os.read(fd, READ_CHUNK)
            except InterruptedError:
                continue
            except OSError:
                live.discard(fd)
                continue
            if not chunk:
                live.discard(fd)
            else:
                sinks[fd].push(chunk)
    return dict((fd, sink.finish()) for fd, sink in sinks.items())


def _interpreter_start_s(samples=3):
    """What a COLD run spends before the candidate's first instruction, measured here, on this
    machine, at this load, by actually starting the interpreter three times.

    Every warm deadline has this subtracted, so that a cap of T means the same amount of
    CANDIDATE compute on both paths (docs/HARNESS-NEXT-DESIGN.md §3 M6): cold spends interpreter
    start plus the runner's own imports inside T, warm spends ~0.5 ms of fork(). The MAXIMUM of
    the samples is deliberate -- overstating the allowance makes the warm path stricter than the
    cold one, and a warm timeout is re-run cold by the caller, while understating it would let a
    candidate the cold run kills finish warm, which is a false negative nothing re-checks."""
    import subprocess
    worst = 0.0
    for _ in range(max(1, samples)):
        t = time.monotonic()
        try:
            subprocess.call([sys.executable, "-c", "0"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except BaseException:
            return 0.0
        worst = max(worst, time.monotonic() - t)
    return worst


_STARTUP = {"at": None, "s": 0.0}


def _refresh_startup(samples=2):
    """Re-measure the cost of starting an interpreter, at most once per STARTUP_TTL_S.

    Measuring once at boot is not enough: under an 8-lane bench the cold start-up this corrects
    for grows several-fold, and an allowance frozen at the idle value leaves the warm cap too
    generous exactly when it matters (measured: 5 of 82 QuixBugs pairs at a 0.5 s cap under a
    24-way load, every one of them a cold-only timeout).

    Called AFTER a reply, never before a fork: the measurement costs two interpreter starts and
    must not land inside a run the probe is timing."""
    now = time.monotonic()
    if _STARTUP["at"] is None or now - _STARTUP["at"] > STARTUP_TTL_S:
        _STARTUP["s"] = _interpreter_start_s(samples)
        _STARTUP["at"] = time.monotonic()
    return _STARTUP["s"]


def _charged(nominal_s, allowance_s):
    """The warm deadline for a cold cap of 'nominal_s', never below half of it."""
    return max(nominal_s * MIN_DEADLINE_FRACTION, nominal_s - max(0.0, allowance_s))


def _text(raw):
    return raw.decode("utf-8", "replace")


class Quixbugs(object):
    """run_tests.py imported once; its case semantics are reused, never re-implemented."""

    startup_s = 0.0
    boot_s = 0.0
    boot_startup_s = 0.0

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

    def _run_cases(self, module, name, cases, timeout, include_slow, jobs, allowance):
        """One fork() per case in waves of --jobs, each case under its own deadline: run_tests.py's
        pool-of-subprocesses shape at fork cost, with the per-case SIGKILL kept.

        'allowance' is what run_tests.py's own per-case child spends before the candidate runs
        (interpreter start, importing run_tests.py, importing the candidate) and which this fork
        does not: subtracting it is what makes a '--timeout T' cap mean the same compute here as
        it does cold. The reported limit stays the nominal one, so the failure text matches."""
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
            sinks = {}
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
                # unbounded, exactly like run_tests.py's own capture of a case subprocess: what
                # the candidate prints goes to the run's stderr pipe, which IS bounded
                sinks[r] = _Sink({"head": 0, "truncated": False}, None, TAIL_BYTES)
                deadlines[r] = time.monotonic() + _charged(limit, allowance) + PIPE_SLACK_S
            expired = set()
            raw = _drain(list(by_fd), deadlines, expired.add, sinks)
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

    def _import_cap(self, cases, timeout, include_slow):
        """The deadline the candidate's import gets, and the one every case reports if it blows it.

        run_tests.py imports the candidate INSIDE each case's own child, so a module body that never
        returns is an ordinary per-case TIMEOUT there, at that case's own cap (--timeout, raised by the
        case's "timeout"). Here the import happens once for the whole wave, so it is armed with the
        largest cap any case that will actually run could claim: never shorter than the cold path
        allows, so a slow-but-finite import cannot be failed here and passed cold."""
        caps = [timeout] + [float(c.get("timeout", 0)) for c in cases
                            if not (c.get("slow") and not include_slow)]
        return max(caps)

    def _import_timeout_rows(self, cases, timeout, include_slow):
        """The cold rows for an import that never returned: each case reports its own cap as a TIMEOUT,
        and a slow case that was going to be skipped is still skipped (run_tests.py checks "slow" before
        it spawns anything, so the hanging import never reaches it)."""
        rows = []
        for c in cases:
            if c.get("slow") and not include_slow:
                r = {"status": "skipped", "actual": "skipped (slow; pass --slow)"}
            else:
                r = {"status": "timeout", "actual": "TIMEOUT after %gs" % max(timeout, float(c.get("timeout", 0)))}
            rows.append(dict({"input": c["input"], "expected": c["expected"]}, **r))
        return rows

    def _run_module(self, name, path, test_file, timeout):
        """run_tests.py's _child_module in this fork: the module's tests share state, as under pytest."""
        import importlib.util
        import re
        import types
        rt = self.rt
        with open(test_file) as f:
            expected_names = re.findall(r"^def (test\\w*)\\(", f.read(), re.M)
        # The import runs under a deadline this worker owns, exactly as each test below does. Without it
        # the one piece of candidate code outside every warm deadline was the module body, and a
        # candidate that hangs there held the lane until the whole run's wall -- for every case, and then
        # again cold.
        #
        # The deadline is the COLD one, not the per-case cap: run_tests.py gives this same import the whole
        # module wall (run_tests.py:209, overall = timeout * (len(expected_names) + 1) + 5, applied to the
        # --_child-module subprocess that does _load_candidate + exec_module), so arming it at "timeout"
        # would fail a slow-but-finite module body here that passes cold -- a CORRECT candidate thrown away
        # by the screen. That is the same rule _import_cap states on the JSON path ("never shorter than the
        # cold path allows"), and it applies here for the same reason. A true hang is still bounded by the
        # worker rather than by the run's wall, and the rows are worded exactly as run_tests.py:229 words
        # them, so warm is byte-identical to cold and not merely the same status.
        overall = timeout * (len(expected_names) + 1) + 5
        signal.signal(signal.SIGALRM, rt._alarm)
        signal.setitimer(signal.ITIMER_REAL, overall)
        try:
            rt._load_candidate(name, path)
            spec = importlib.util.spec_from_file_location(name + "_test", test_file)
            tmod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(tmod)
        except rt._Timeout:
            return [{"input": t, "expected": "pass", "status": "timeout",
                     "actual": "TIMEOUT (module wall-clock %gs exceeded)" % overall} for t in expected_names]
        except BaseException as exc:
            text = rt._exc_text(exc, test_file)
            return [{"input": t, "expected": "pass", "status": "error", "actual": "import error: " + text}
                    for t in expected_names]
        finally:
            # the per-test loop arms its own; nothing may stay armed across the tests
            signal.setitimer(signal.ITIMER_REAL, 0)
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
            t_load = time.monotonic()
            # the import is the one piece of candidate code that used to run outside every deadline this
            # worker owns; a module body that never returns held the lane until the run's whole wall
            module = None
            imported = False
            signal.signal(signal.SIGALRM, rt._alarm)
            signal.setitimer(signal.ITIMER_REAL, self._import_cap(cases, timeout, include_slow))
            try:
                module = rt._load_candidate(name, path)
                imported = True
            except rt._Timeout:
                results = self._import_timeout_rows(cases, timeout, include_slow)
            except BaseException as exc:
                text = rt._exc_text(exc)
                results = [{"input": c["input"], "expected": c["expected"], "status": "error", "actual": text}
                           for c in cases]
            finally:
                # disarmed before the cases run: each of them is a fork with its own deadline, and a
                # timer still ticking here would raise _Timeout in the middle of the wave
                signal.setitimer(signal.ITIMER_REAL, 0)
            if imported:
                # the cold per-case child pays interpreter start, importing run_tests.py and
                # importing the candidate inside its own --timeout; this fork pays none of them
                allowance = (self.startup_s + self.boot_s + (time.monotonic() - t_load)) * STARTUP_SAFETY
                results = self._run_cases(module, name, cases, timeout, include_slow, jobs, allowance)
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
    startup_s = 0.0
    boot_s = 0.0
    boot_startup_s = 0.0

    def __init__(self):
        import pytest
        self.pytest = pytest
        self.prewarmed = False

    def run(self, req, meta_w):
        args = [str(a) for a in req.get("args", [])]
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


def _fork_candidate(handler, req, deadline_s, want_meta, out_cap, tail_bytes):
    """Run one candidate in a fork; returns (stdout, stderr, exit, timed_out, truncated, meta).

    The deadline is charged from BEFORE the fork and the caller has already subtracted what a
    cold run spends on process start, so 'deadline_s' means the same compute on both paths. The
    two output streams share one 'out_cap' byte budget, exactly as src/sandbox/run.ts shares one
    across a cold run's streams."""
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    meta_r, meta_w = os.pipe() if want_meta else (None, None)
    started = time.monotonic()
    pid = os.fork()
    if pid == 0:
        code = 70
        try:
            os.close(out_r)
            os.close(err_r)
            if meta_r is not None:
                os.close(meta_r)
            os.setsid()
            # per-run environment, set in the CHILD so every candidate sees what its cold twin
            # would and nothing leaks into the next one; both handlers get it, not just pytest
            for k, v in (req.get("env") or {}).items():
                os.environ[str(k)] = str(v)
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
    shared = {"head": 0, "truncated": False}
    sinks = _sinks_for([out_r, err_r], shared, out_cap, tail_bytes)
    if meta_r is not None:
        sinks[meta_r] = _Sink({"head": 0, "truncated": False}, None, tail_bytes)
    deadline = started + deadline_s
    deadlines = dict((fd, deadline) for fd in fds)
    expired = []
    raw = _drain(fds, deadlines, expired.append, sinks)
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
    return _text(raw.get(out_r, b"")), _text(raw.get(err_r, b"")), code, timed_out, shared["truncated"], meta


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
        boot_t0 = time.monotonic()
        if args.mode == "quixbugs":
            handler = Quixbugs(args.quixbugs_dir or os.getcwd())
        else:
            handler = Pytest()
        # what a cold run pays for the runner's own imports (exec run_tests.py / import pytest)
        handler.boot_s = time.monotonic() - boot_t0
        handler.boot_startup_s = _interpreter_start_s(3)
        handler.startup_s = handler.boot_startup_s
        _STARTUP["s"] = handler.boot_startup_s
        _STARTUP["at"] = time.monotonic()
    except BaseException as exc:
        sys.stderr.write("jevcode warm boot failed: " + repr(exc) + "\\n")
        sys.stderr.flush()
        return 3

    def _allowance():
        """What a cold run of this command spends before the candidate's first instruction.
        The runner's own imports (exec run_tests.py / import pytest) were timed at boot and are
        scaled by how much slower an interpreter start is now than it was then: both are the
        same kind of CPU-bound work, so the same load factor applies to both."""
        now_s = _STARTUP["s"]
        base = handler.boot_startup_s or now_s or 1.0
        handler.startup_s = now_s
        return (now_s + handler.boot_s * (now_s / base) + SHELL_SPAWN_S) * STARTUP_SAFETY
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
        cap = int(msg.get("outputBytes", DEFAULT_OUTPUT_BYTES))
        tail = int(msg.get("tailBytes", TAIL_BYTES))
        nominal_s = max(0.001, float(msg.get("deadlineMs", 120000)) / 1000.0)
        # re-read before the fork, so the forked child inherits a current handler.startup_s
        run_allowance = _allowance()
        try:
            out, err, code, timed_out, truncated, meta = _fork_candidate(
                handler, msg, _charged(nominal_s, run_allowance), want_meta,
                cap if cap > 0 else None, tail if tail > 0 else TAIL_BYTES)
        except BaseException as exc:
            reply({"id": rid, "ok": False, "error": "warm parent: " + repr(exc), "fatal": True})
            return 7
        ms = (time.monotonic() - t0) * 1000.0
        reply({"id": rid, "ok": True, "stdout": out, "stderr": err, "exit": code,
               "timedOut": bool(timed_out), "truncated": bool(truncated), "ms": round(ms, 3)})
        # the caller is now parsing that reply: the idle moment to re-price a cold start
        _refresh_startup()
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
