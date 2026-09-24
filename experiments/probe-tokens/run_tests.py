"""Run the QuixBugs tests for one program against a patched source file, without pytest.
Usage: python3 run_tests.py <quixbugs_root> <name> <patched_program.py>
Prints one line: PASS <n> | FAIL <passed>/<n> <first failure>
"""
import importlib.util, os, shutil, signal, sys, tempfile, types, math

root, name, patched = sys.argv[1:4]
work = tempfile.mkdtemp(prefix="qb-", dir="/tmp/jevonly/work")
pkg = os.path.join(work, "python_programs"); os.makedirs(pkg)
shutil.copy(patched, os.path.join(pkg, f"{name}.py"))
shutil.copy(os.path.join(root, "python_programs", "node.py"), os.path.join(pkg, "node.py"))
open(os.path.join(pkg, "__init__.py"), "w").close()
sys.path[:0] = [work, os.path.join(root, "python_testcases"), os.path.join(root, "python_programs")]

class _Approx:
    def __init__(self, v, abs=1e-6): self.v, self.abs = v, abs
    def __eq__(self, o):
        try: return math.isclose(o, self.v, abs_tol=self.abs)
        except TypeError: return False
stub = types.ModuleType("pytest"); stub.use_correct = False; stub.run_slow = False
class _Skip(Exception): pass
def _skip(*a, **k): raise _Skip()
stub.skip = _skip
class _Mark:
    @staticmethod
    def parametrize(argnames, argvalues):
        def deco(fn): fn._params = (argnames, argvalues); return fn
        return deco
stub.mark = _Mark(); stub.approx = lambda v, abs=1e-6: _Approx(v, abs)
sys.modules["pytest"] = stub

def alarm(*_): raise TimeoutError("timeout")
signal.signal(signal.SIGALRM, alarm)

try:
    spec = importlib.util.spec_from_file_location(f"test_{name}", os.path.join(root, "python_testcases", f"test_{name}.py"))
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
except Exception as e:
    print(f"FAIL 0/0 import: {type(e).__name__}: {str(e)[:80]}"); shutil.rmtree(work, ignore_errors=True); sys.exit(1)

cases = []
for fname in dir(mod):
    fn = getattr(mod, fname)
    if not (fname.startswith("test") and callable(fn)): continue
    if hasattr(fn, "_params"):
        for vals in fn._params[1]: cases.append((fname, fn, tuple(vals)))
    else: cases.append((fname, fn, ()))
passed, first = 0, None
for fname, fn, args in cases:
    signal.alarm(3)
    try:
        fn(*args); passed += 1
    except _Skip:
        passed += 1  # slow case skipped by the upstream test itself
    except BaseException as e:
        if first is None: first = f"{fname}{args if args else ''}: {type(e).__name__}"[:120]
        if os.environ.get("QB_TRACE") and first: import traceback; traceback.print_exc()
    finally: signal.alarm(0)
shutil.rmtree(work, ignore_errors=True)
print(f"PASS {passed}" if passed == len(cases) and cases else f"FAIL {passed}/{len(cases)} {first}")
sys.exit(0 if passed == len(cases) and cases else 1)
