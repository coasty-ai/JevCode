# Reach at the gold site: can the jev-only sources produce the fix on the 9 issue-oracle-valid SWE-bench instances? (2026-09-20)

Question (brief): for the 9 SWE-bench Verified instances whose issue oracle is VALID
(`experiments/results/oracle-from-issue.md`: sympy-15345, -17139, -19954, -11618, -12096, django-15315, -15128,
-15563, requests-2931), can the jev-only candidate sources produce the gold patch, or a test-equivalent one, at the
gold site, and if not, which single missing capability would make it reachable?

**No Jev call was made: $0.00, 0 requests.** Every number below is code + `python3`: the real modules
(`src/synth/mutate`, `templates`, `donor`, `search/composite.ts`, `sketch/pool.ts`, `fill/state.ts`, `beam/vocab.ts`,
`sieve/queue.ts`) enumerated at a `Site` built the way `localize/sites.ts` builds one, with `EnumerateOptions` built the
way `search/subgoal.ts` builds them, on the base-commit worktrees under `/tmp/jevonly/repos/<id>` (checked clean and at
`base_commit` before every read; never written to). Test runs (issue-oracle scripts and FAIL_TO_PASS tests) ran in
private worktrees under `/tmp/jevonly/reach/` with the bench venvs under `~/.jevcode/runs/bench-work/`.

Scripts (all under `experiments/reach/`): `reach-oracle-9.mts` (the per-site enumeration; outputs
`out/reach-oracle-9.<ids>.json`), `hunk-subsets.mts` (gold-hunk subsets and hand-written one-line alternatives against
the F2P tests; `out/hunk-subsets.json`), `sieve-at-site.mts` (every SEEDS candidate at the gold site run through the
issue oracle, 4 lanes; `out/sieve-at-site.<id>.json`), `passers-vs-f2p.mts` (the sieve's passers against the F2P tests),
`statement-site-15315.mts`, `probe-line.mts`, `non_oracle_21.py` (the all-30 table from `coverage-study.json`),
`lib.mts`. Logs in `out/log-*.txt`.

## Headline

| instance | oracle | gold hunks (code) | class | gold hunk in a source's set at the gold site | test-equivalent fix in a source's set (F2P verified) | candidates at the gold site (SEEDS, cap 254 each) | missing capability |
| --- | --- | --- | --- | --- | --- | --- | --- |
| psf__requests-2931 | valid (no_exception) | 2 | 1× 1-line replace, 1× 2-line insert | hunk 1 (`return data`): **yes** — mutation `unwrap_call` #16 of 159 and donor `statement_donor` #54 of 254, SEEDS; hunk 2 (params guard): no source, capped or uncapped | **yes**: hunk 1 alone passes `test_binary_put` (hunk-subsets) | 634 at `models.py:84` (159 + 72 + 254 + 149) | none for the test; the second hunk (a guard whose body is not `return`/`raise`) needs guard bodies copied from a sibling statement |
| sympy__sympy-12096 | valid_weak (differs_from_actual) | 1 | 1× 1-line replace | no (gold `*[i.evalf(prec) for i in self.args]` is a new comprehension; sketch pool has no shape for it) | **yes**: `return nfloat(self._imp_(*self.args), prec)` — mutation `call_substitution` #11 of 237 and template `callee_subst` #57 of 152, SEEDS; 7 more `callee_subst` lines (`expand(...)` family) also pass F2P | 743 at `function.py:510` (237 + 152 + 254 + 100); the sieve ran 712 distinct: **40 pass the weak oracle, 8 of them pass F2P** | none for the test; the guard must pick the `16.0` behaviour cluster (exactly the 8 F2P passers) among 40 oracle passers |
| django__django-15315 | valid (no_exception) | 1 | 5-line statement → 1 line | no: the site is a physical line of a 5-line `return hash((…))`; every source keeps the bracket signature or leaves lines 546–549 dangling; at a joined statement-level site still no (needs drop 2 tuple elements + unwrap) | **degenerate yes**: `return not hash((` (mutation `negation` #0 of 21) and `return 0` / `return False` inserted before (template `insert_return_before`) pass `test_hash_immutability`: a constant hash | 383 at `__init__.py:545` (21 + 92 + 254 + 16); over the 5 physical lines 2,171 distinct: 38 pass the oracle, **1,143 break the module import**, 3 pass F2P | statement-level replace sites (the whole logical statement as one `Site`) **and** a `history` source: the gold line is byte-identical to `__hash__` before commit 502e75f9ed (#31750), which the issue names |
| sympy__sympy-15345 | valid (values, loose) | 2 | 2× insert (dict entries at module level; a class-body alias) | no; the alias `_print_MinMaxBase = _print_Function` instantiates sketch P11 `_ = _` (pool index 1) but `_print_MinMaxBase` is in no slot vocabulary, no file, no test, no issue | **no** — although the alias line **alone** passes `test_Function` (hunk-subsets): the fix is one inserted line whose left name is `'_print_' + MinMaxBase` | 413 at the class-body gap `mathematica.py:104` (254 + 0 + 159 + 0); 203 at the dict gap | a name source from runtime introspection of the failing call: `type(Max(x, 2)).__mro__` gives `MinMaxBase`; the file's own convention `'_print_' + cls.__name__` (`printer.py:285`) composes the slot value |
| sympy__sympy-17139 | valid (no_exception) | 1 | 1× 2-line guard insert | no source, capped or uncapped; sketch P12 header `if _ <op> _:` is 5 tokens, the gold header 8; `is_real` is in 45 repo files (0 of the 400 loaded) and not in `fu.py` | **no** (the 2-line guard is the minimal fix: both comparisons on `rv.exp` raise for complex `I`) | 612 at the gap `fu.py:503` (254 + 104 + 254 + 0); 596 at the line before | the same introspection name source: `dir(rv.exp)` holds `is_real` (`rv.exp.is_real` is `False` at the failing call); the guard template already offers `return rv` as a body (`returnDefaults`, common.ts:653-659) and only lacks the predicate `not rv.exp.is_real` |
| sympy__sympy-19954 | valid (no_exception) | 3 | 1× 1-line replace + 2× multi-line, one new variable | no: `blocks_remove_mask` exists nowhere; the three hunks are coupled (hunk 1 alone fails F2P) | **no**, although a one-line test-equivalent exists: `for i, r in reversed(list(enumerate(rep_blocks))):` passes `test_sylow_subgroup`; no source produces it (single wrap `_(enumerate(rep_blocks))` is sketch P5 #24; the fix is a double wrap) | see per-instance section | depth-2 wraps (`reversed(list(…))`): composite pairs exist but cap at 100 pairs from 10 seeds (composite.ts:39-41) and never pair a template seed with a template |
| sympy__sympy-11618 | valid (values) | 1 | 1× 14-line insert (new branch) | no (new logic, 11 code lines) | **no**, although a two-edit test-equivalent exists: `zip(` → `zip_longest(`, `fillvalue=0` + `from itertools import zip_longest` passes `test_issue_11617`; `zip_longest` is in the stdlib table (`imports.ts:34`) but no template substitutes a callee by a stdlib sibling and no composite pairs a template with a template | see per-instance section | callee substitution from a stdlib-sibling table with the import carried as `extraEdits` (`zip`→`zip_longest`, `dict`→`defaultdict`, …) |
| django__django-15128 | valid (no_exception) | 6 | 2× insert, 1× delete, 2× 1-line, 1× multi (+3 docstring/comment hunks) | no (functional minimum = 4 coupled edits in 2 functions; `exclude` exists in no file of the 400, no test, no issue text) | **no**: the 4-edit functional minimum passes F2P; the `combine()` insertion alone fails (`TypeError`) | see per-instance section | parameter threading with a repo-wide parameter-name pool: composite signature units (composite.ts:464-510) do the header + call sites, but the name `exclude` must come from the 8 other `def …(…, exclude=None)` signatures in django (0 of them in the 400-file corpus) |
| django__django-15563 | valid_weak | 5 (2 files) | 1× multi (12 new lines), 2× insert, 2× 1-line | no (new logic; `related_ids_index` nowhere; `compiler.py` hunks alone fail F2P: the `subqueries.py` subscript is required) | **no** | see per-instance section | none single: 20 lines of new MTI logic across two files |

Reading: **at the gold site the implemented sources reach a test-passing patch on 3 of 9** (requests-2931 by the gold line
itself, sympy-12096 by a non-gold line, django-15315 by a degenerate constant hash), all in the SEEDS phase and all
inside the 254-per-source cap, so the design's SIEVE would run them without a Jev rank request when the oracle is
cheap (`decideRunPlan`, budget.ts:601-606: `t_run ≤ 2,000 ms`; the issue-oracle scripts measured 138–2,169 ms). The
gold *text* is reached on 1 of 9 (requests-2931). Before any source runs, though, **5 of the 9 gold files are not in the
400 files the engine loads** (next section), so today the engine cannot localise or edit them at all.

## Two findings that precede the sources

### 1. The workspace corpus is cut at 400 files alphabetically, and 5 of the 9 gold files fall outside it

`loadPythonFiles` (src/synth/search/index.ts:319-336) lists every `.py`, drops test paths, **sorts the paths and keeps
the first `MAX_WORKSPACE_PY_FILES = 400`** (index.ts:44, 322-325). The same map is handed to the localizer
(src/synth/index.ts:79-83), to every source as `EnumerateOptions.corpus` (subgoal.ts:321-323) and to the queue's
vocabulary (src/synth/index.ts:67). Measured on the base-commit worktrees (`git ls-files '*.py'` minus `isTestPath`):

| instance | non-test .py files | gold file | alphabetical rank | in the 400? | file #400 |
| --- | --- | --- | --- | --- | --- |
| sympy-15345 | 746 | sympy/printing/mathematica.py | 588 | **no** | sympy/physics/mechanics/rigidbody.py |
| sympy-17139 | 755 | sympy/simplify/fu.py | 650 | **no** | sympy/physics/mechanics/linearize.py |
| sympy-19954 | 811 | sympy/combinatorics/perm_groups.py | 116 | yes | sympy/parsing/c/c_parser.py |
| sympy-11618 | 626 | sympy/geometry/point.py | 196 | yes | sympy/plotting/pygletplot/util.py |
| sympy-12096 | 627 | sympy/core/function.py | 133 | yes | sympy/plotting/pygletplot/util.py |
| django-15315 | 858 | django/db/models/fields/__init__.py | 687 | **no** | django/contrib/messages/__init__.py |
| django-15128 | 857 | django/db/models/sql/query.py | 713 | **no** | django/contrib/messages/__init__.py |
| django-15563 | 859 | django/db/models/sql/compiler.py | 712 | **no** | django/contrib/messages/__init__.py |
| requests-2931 | 83 | requests/models.py | 12 | yes | – |

On django the cut ends inside `django/contrib/` (the locale tree alone is ~180 files), so `django/db/**` is never
loaded; on sympy everything after `sympy/physics/` (`printing`, `simplify`, `solvers`, `sets`, `stats`, …) is gone.
This is not a source limitation but it decides the experiment's premise: the study below builds the site on the gold
file directly (as if localisation had found it) and gives every source the engine's 400-file corpus plus the gold file;
a second pass with the full corpus (`full` in the JSON) changes nothing in the reach columns of the table above.
The two donor lines the fixes would need from elsewhere (`if not X.is_real:` for 17139 lives in 3 sympy files,
`def …(…, exclude=None)` for 15128 in 8 django files) are all outside the 400.

### 2. Replace sites are physical lines; a multi-line statement cannot be rewritten (django-15315)

`replaceSite` (localize/sites.ts:264-276) sets `currentLine = lines[line - 1]`, one physical line. django-15315's
gold replaces the 5-line `return hash((…))` by `return hash(self.creation_counter)`. At line 545 (`return hash((`)
the mutation library's `looksSyntactic` keeps the bracket signature (mutate/index.ts:59-84), the templates'
`wellFormed`/`balancedAs` does the same (templates/index.ts:64-68, 83), and donors have no such filter: the sieve over
the 5 physical lines ran 2,171 distinct candidates and **1,143 broke the module import** (`runner error … from
django.db.models import fields`), 990 ran and failed, 38 passed the issue oracle. Joining the statement onto one line
and re-enumerating (`statement-site-15315.mts`) still yields no gold: mutation 447, templates 363, donors 862, composite
100 candidates uncapped, none `return hash(self.creation_counter)` (dropping two tuple elements and the tuple is a
depth-3 edit; the sketch pool of 221 has no matching shape). The line does exist verbatim in the repository's history:
`git show 502e75f9ed~1:django/db/models/fields/__init__.py` line 529 is `return hash(self.creation_counter)`, and the
issue text says "The bug was introduced in #31750 … we can revert the `__hash__` change". The design's `history`
source (`git log -S`, design §3 last row, "not in v1") would propose it as one candidate.

## Per instance

Site construction: for a modification the replace site is the first removed line; for an insertion the gap site
(`insert` before the old line, gold indent, scope of the line before as `insertSite 'after'` does, localize/sites.ts:278-290)
plus the replace sites of both neighbouring code lines, because the templates emit `_before`/`_after` forms there
(templates/common.ts:535-556). Every candidate is applied with `verify/apply.ts applyCandidate` and the resulting file is
compared with the gold-patched file token by token (blank and comment lines dropped); "first line" means the first
gold code line appears among the candidate's lines. `cap` is `ENUMERATE_CAP = 254` (subgoal.ts:46); "uncapped" re-runs
the source with cap 10⁶ (composite is bounded by its own limits, not by `opts.cap`: `SECOND_ORDER_LIMIT` 100,
`SIGNATURE_UNIT_LIMIT` 20, `DONOR_UNIT_LIMIT` 48, composite.ts:39-64). `EnumerateOptions.testLiterals` came from the
oracle's `FailureView` (subgoal.ts:293-306), `taskIdentifiers` from the issue text (subgoal.ts:308-319).

### psf__requests-2931 (`requests/models.py`, 83 files, t_run 138 ms)

- Hunk 1, `models.py:84`, `return to_native_string(data)` → `return data` (1-line replace, `_encode_params`, 26 lines).
  **Reached** by mutation `unwrap_call` at index 16 of 159 (mutate/operators.ts:27, 878) and by donor `statement_donor` at
  index 54 of 254; templates put the line only inside guard drafts (`guard_none_return_default_before`, 5 hits on the first
  line, none on the hunk). Sketch: P10 shape at pool index 3 of 66, hole `data` in the slot vocabulary (fillable). Beam
  vocabulary complete (2 tokens). Queue vocabulary: nothing missing.
- Hunk 2, gap before `models.py:388`, `if isinstance(params, (str, bytes)):` / `params = to_native_string(params)` (2-line
  insert in `prepare_url`, 73 lines; the gap is a legal `functionGapSlots` slot). **Not reached** by any source at any of the
  three sites, capped or uncapped (mutation 254/368, templates 254/378, donors 254/2,586 at the gap; the first line alone
  appears once among the 2,586 uncapped donors, never with the gold body). Reason: the guard template's bodies are
  `return <alt>` / `return None` / `return <default>` / `continue` / `raise …` / `x = []|""|0` (templates/guards.ts:78-87);
  a body that re-assigns the subject through a call exists only as a donor header+body transplant, and the nearest donor
  (`if isinstance(query, str):` + `query = query.encode('utf-8')`) needs a shape change in the body. Sketch: no shape for the
  8-token header (P12 is `if _ <op> _:`, productions.ts:504-517). Coverage-study's "guard_insertion, donor 1/3-sub" verdict
  was line-level; at hunk level the implemented templates do not produce it.
- **Test-equivalence** (`hunk-subsets.mts`): hunk 1 alone passes `test_binary_put` (1.1 s); hunk 2 alone fails. The oracle
  script (`requests.put(...)`) reaches httpbin over the network, so the sieve was not run on this instance; the F2P test is
  network-free (`Request(...).prepare()`).

### sympy__sympy-12096 (`sympy/core/function.py`, 627 files, rank 133, t_run 245 ms)

- One hunk, `function.py:510` in `_eval_evalf` (48 lines): `Float(self._imp_(*self.args), prec)` →
  `Float(self._imp_(*[i.evalf(prec) for i in self.args]), prec)`. **Gold not reached**: mutation 237, templates 152, donors 254
  (1,876 uncapped), composite 100 (pairs), donor-body units 48 — none. Sketch pool 113: no shape (the gold adds a
  comprehension; P1–P10 hole one token, one operator, a fragment, a wrap or a swap, productions.ts:253-400). Beam: 26 tokens
  (> `BEAM_MAX_TOKENS` 25) and `i`, `evalf` outside the beam vocabulary. Queue vocabulary: complete (every gold NAME is in the
  file).
- **Sieve at the site** (`sieve-at-site.mts`, weak criterion "value differs from `f(g(2))` and nothing raises"): 712 distinct
  SEEDS candidates, 856 s at 4 lanes (median 4.6 s per run under load; the oracle alone measured 245 ms). **40 pass the weak
  oracle**, 662 fail, 4 SyntaxError, 6 timeouts. Their observed values cluster: `16.0` ×8, `57.0` ×6, `0` ×3, `-1.0` ×2,
  eleven `ModuleNotFoundError`s (a `callee_subst` to an unimported name counts as "differs and raises inside the value
  repr"), `Application`, `Lambda(_x, _x)`, `f(f)`, `3249.0`, … **Only the 8 in the `16.0` cluster pass `test_issue_12092`**
  (`passers-vs-f2p.mts`): `return nfloat(self._imp_(*self.args), prec)` (mutation `call_substitution`, index 11 of 237;
  `nfloat` is defined in the same file, function.py:2590) and seven `callee_subst` templates (`expand`, `expand_mul`,
  `expand_log`, `expand_trig`, `expand_multinomial`, `expand_power_base`, `_mexpand`). So the weak oracle admits 32 wrong
  patches for 8 right ones at this one site; behaviour clustering on the repro value (design §2.6 `clusterByBehaviour`,
  search/guard.ts:188) separates them exactly, and the arbitration Choice has to prefer the `16.0` cluster over `57.0`, `0`,
  `-1.0` with an unstated expected value.

### django__django-15315 (`django/db/models/fields/__init__.py`, 858 files, rank 687, t_run 475 ms)

- One hunk, `__init__.py:545-549` → `return hash(self.creation_counter)` in `__hash__` (6 lines). At the physical-line
  site 545: mutation 21, templates 92, donors 254, composite 16 — none. Sketch pool 47: no shape. Queue vocabulary:
  complete. Statement-level site and history: see finding 2.
- **Sieve over the five physical lines**: 2,171 distinct candidates (mutation 400, templates 190, donors 1,265, composite
  316), 859 s at 4 lanes (median 1.3 s). 38 pass the issue oracle (`assert f in d` raises nothing), 990 fail, 1,143 break the
  import. **3 of the 38 pass `test_hash_immutability`**: `return not hash((` (mutation `negation`, index 0 of 21 at line 545:
  the hash becomes the constant `False`), and the templates' `return 0` / `return False` inserted before the statement
  (`insert_return_before`). They are degenerate (a constant hash) but they are what the evaluator's F2P criterion accepts;
  the P2P suite and the design's arbitration guard are what stands between them and a commit.

### sympy__sympy-15345 (`sympy/printing/mathematica.py`, 746 files, rank 588, t_run 1,161 ms)

- Hunk 1, `mathematica.py:34`, two dict entries `"Max": [(lambda *x: True, "Max")],` / `"Min": …` replacing a blank line
  inside a module-level dict literal (a 25-line statement). No function encloses it, so no `functionGapSlots`
  (search/sites.ts:744-746 builds gaps for functions ≤ 40 lines only); mutation and templates produce 0 candidates at the
  site (templates refuse gaps inside a multi-line statement, templates/index.ts:74, `continuesStatement` common.ts:477);
  donors 103/254 and composite 100 produce nothing matching. Sketch pool 0. Beam vocabulary lacks the string `"Max"`.
- Hunk 2, class-body gap `mathematica.py:104`, `_print_MinMaxBase = _print_Function` (class `MCodePrinter`, 80 lines).
  Mutation 254 (insert-mode statement templates), templates 0, donors 159 (254 with the full corpus): none. **Sketch P11
  `_ = _` matches at pool index 1 of 56**, `_print_Function` is a slot option, `_print_MinMaxBase` is not (fill/state.ts
  identifiers: scope, function identifiers, task identifiers, builtins, state.ts:170-180). Queue vocabulary: `_print_MinMaxBase`
  is "nowhere (new name)"; beam vocabulary the same.
- **Test-equivalence**: the alias line **alone** passes `test_Function` (`_print_Function` falls back to
  `expr.func.__name__ + "[%s]"`, mathematica.py:103); "Max entry + alias" passes; "dict entries only" fails. So the fix is
  one inserted line at a class-body gap whose left-hand name is `'_print_' + MinMaxBase`, where `MinMaxBase` is
  `type(Max(x, 2)).__mro__[1].__name__` at the failing call and the `'_print_' +` convention is the file's own dispatch
  (`sympy/printing/printer.py:285`).

### sympy__sympy-17139 (`sympy/simplify/fu.py`, 755 files, rank 650, t_run 2,169 ms)

- One hunk, gap before `fu.py:503` in the nested `_f` (27 lines): `if not rv.exp.is_real:` / `return rv` (legal gap slot).
  Mutation 254, templates 104, donors 254 (12 s per call on the 400-file index) at the gap; 114/128/254/100 at the line
  before: none, capped or uncapped, first line never produced. Sketch pool 40 (52 uncapped): no shape (P12's header is
  `if _ <op> _:`). Beam and slot vocabularies lack `is_real`; the queue vocabulary lists it missing: it occurs in 45 repo
  files (`sympy/assumptions/handlers/sets.py`, `sympy/calculus/singularities.py`, …) and in tests, in none of the 400
  loaded files, and never in `fu.py` (`rv.exp` is read as `.is_integer` ×2 and `.is_negative` ×1 there). The runtime object
  has it: at the failing call `rv.exp` is `ImaginaryUnit`, `dir(rv.exp)` holds 68 `is_*` attributes and `rv.exp.is_real`
  is `False`.
- The guard template already offers the body: `returnDefaults` adds every simple `return` expression of the enclosing
  function (common.ts:653-659), so `return rv` is a `guard_none_return_default` body (guards.ts:81); what it lacks is the
  predicate form `not <subject>.<boolean attribute>` and the attribute name.

### sympy__sympy-19954 (`sympy/combinatorics/perm_groups.py`, 811 files, rank 116, t_run 1,611 ms)

Per-site numbers from the batch log (`out/log-batch-a.txt`): at `perm_groups.py:2197/2201/2208` no source hits the gold
hunk or its first line at cap 254 or uncapped (donors 2,434 uncapped at 2208; templates 787). The batch was still writing
its JSON at hand-back time; the probe at the one-line alternative's site is in `probe-line.mts` output above.

- Three coupled hunks in `minimal_blocks`: `to_remove = []` → `blocks_remove_mask = [False] * len(blocks)`, the loop body
  `del num_blocks[i], blocks[i]` / `to_remove.append(…)` → `blocks_remove_mask[i] = True`, and three list comprehensions
  filtering by the mask. `blocks_remove_mask` exists nowhere (queue vocabulary). Hunk 1 alone fails F2P.
- **A one-line test-equivalent exists**: `for i, r in enumerate(rep_blocks):` → `for i, r in reversed(list(enumerate(rep_blocks))):`
  at `perm_groups.py:2198` passes `test_sylow_subgroup` (the in-loop `del` then cannot shift later indices). At that site no
  source produces it (mutation 81, templates 254/804, donors 254/2,744, composite 100; `probe-line.mts`); the sketch pool
  holds the single wrap `for i, r in _(enumerate(rep_blocks)):` (P5, index 24 of 97) but not the double wrap.

### sympy__sympy-11618 (`sympy/geometry/point.py`, 626 files, rank 196, t_run 724 ms)

Per-site enumeration was still running at hand-back (batch A, after 19954); the verdict does not depend on it: an 11-line
new branch is outside every source by construction (max candidate = one statement + `extraEdits` from a donor block of
≤ 8 lines, donor/source.ts:56, 120-144).

- One 14-line hunk (11 code lines): a dimension-padding branch inserted at the top of `Point.distance`. New logic; every
  token is in the file (coverage-study vocabulary Y/Y) but no source assembles 11 lines.
- **A two-edit test-equivalent exists**: `zip(` → `zip_longest(` with `fillvalue=0` on the existing return, plus
  `from itertools import zip_longest`, passes `test_issue_11617`. The import template knows `zip_longest → itertools`
  (templates/imports.ts:34) but only imports names the module already uses unbound (`unboundNames`, imports.ts:120-155);
  the callee templates substitute a callee by same-file defs, imports and builtin groups (templates/attribute.ts:66-79),
  never by a stdlib sibling; and composite pairs put a mutation on a seed (composite.ts:695 `second = [mutation]`), never a
  template on a template.

### django__django-15128 (`django/db/models/sql/query.py`, 857 files, rank 713, t_run 484 ms)

Per-site enumeration was still running at hand-back (batch C, after 15563; `out/log-batch-c.txt`); the verdict rests on
the vocabulary (`exclude` in no loaded file, test or issue text) and the 4-edit functional minimum below.

- Six code hunks (+3 docstring/comment hunks). **Functional minimum** (hunk-subsets): the two-line insertion in
  `combine()` (`initial_alias = self.get_initial_alias()` / `rhs.bump_prefix(self, exclude={initial_alias})`), `exclude=None` on
  `bump_prefix`, `if exclude is None: exclude = {}`, and the comprehension filter `if alias not in exclude` — 4 coupled edits in
  2 functions, no renames, no deletion — passes `test_conflicting_aliases_during_combine`; the `combine()` insertion alone
  fails (`TypeError`). The composite signature unit (composite.ts:464-510: header + body edits + every call site) is the shape
  of this fix, but its parameter names come from sibling defs of the same file, task identifiers and free body names
  (templates/signature.ts:105-125); `exclude` is in none of them (0 of the 400 files; 8 django signatures outside the cut
  use `exclude=None`), and the guard body `exclude = {}` plus the comprehension filter are two more edits.

### django__django-15563 (`django/db/models/sql/compiler.py` + `subqueries.py`, 859 files, rank 712, t_run 608 ms)

Per site (SEEDS, cap 254, engine corpus; run 1,439 s): `compiler.py:1839` (12-line replacement in `pre_sql_setup`, 43
lines) mutation 89 + templates 155 + donors 254 + composite 100 = 598, no hit; gap `:1854` (`related_ids =
collections.defaultdict(list)`, legal slot) 254 + 176 + 254 = 684, no hit, `defaultdict` outside the file (17 repo files,
`collections` is imported); gap `:1856` (2-line `for parent, index in related_ids_index:` loop) 728, no hit,
`related_ids_index` nowhere; `:1857` (`self.query.related_ids = related_ids`) 709, no hit although sketch P1 matches at
index 4 (the hole `related_ids` is not a slot option: the name is bound only by the gold's own new line); `subqueries.py:137`
(`self.related_ids` → `self.related_ids[model]`) 671, no hit; sketch P3 matches at index 44 and is fillable (`model` in
scope) — the one line of this fix a SKETCH round could produce, useless without the other four.

- Five hunks in two files, 17 code lines, 14 inserted: a new `related_ids_index` loop over `self.query.related_updates`
  with `meta.get_path_to_parent(related)` / `path.join_field.primary_key`, a `collections.defaultdict(list)` accumulator,
  and `self.related_ids[model]` in `subqueries.py`. `compiler.py` hunks alone fail F2P (hunk-subsets). New logic; no
  single capability.

## Hunk subsets and one-line alternatives against the FAIL_TO_PASS tests (`hunk-subsets.mts`, $0)

| instance | variant | F2P |
| --- | --- | --- |
| requests-2931 | gold; **hunk 1 only** (`return data`); hunk 2 only | pass; **pass**; fail |
| sympy-15345 | gold; **alias only**; dict entries only; Max entry + alias | pass; **pass**; fail; pass |
| django-15128 | gold; **functional minimum (4 edits, no renames)**; combine() insertion only | pass; **pass**; fail |
| django-15563 | gold; compiler.py hunks only | pass; fail |
| sympy-19954 | gold; hunk 1 only; **`reversed(list(enumerate(rep_blocks)))`** | pass; fail; **pass** |
| sympy-11618 | gold; **`zip_longest(…, fillvalue=0)` + import** | pass; **pass** |
| sympy-12096 | gold; **`Float(self._imp_(*self.args).evalf(prec), prec)`** | pass; **pass** (not produced by any source: no "append a method call" production) |

sympy runs use `bin/test -C <file> -k <test>` (the whole `test_lambdify.py` and `test_point.py` modules have an unrelated
`RecursionError` under this Python 3.9 venv even at gold); django `tests/runtests.py --settings=test_sqlite --parallel 1
<label>`; requests `pytest <nodeid>`; `PYTHONPATH` puts the private worktree first (checked: the package resolves to the
worktree).

## All 30 instances from the gold diff alone (`non_oracle_21.py` over `coverage-study.json`, $0)

vocab = every gold NAME/literal in the file / in file + test patch; reach = coverage-study's union (mutation d≤2, donor ≤1
sub, templates) / with 2-sub donors — line-level recognisers, more generous than the implemented sources above.

| instance | issue oracle | code hunks | classes | fixed code lines (inserted) | vocab | reach union / 2-sub | tokens outside file + tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| django-15128 | valid | 6 | 2× insert, 1× delete, 2× 1-line, 1× multi | 8 (5) | n/n | n/n | `exclude`, `other_query`, `initial_alias` |
| django-15315 | valid | 1 | 1× multi | 1 (0) | Y/Y | Y/Y | – |
| requests-2931 | valid | 2 | 1× 1-line, 1× insert | 3 (2) | Y/Y | Y/Y | – |
| sympy-11618 | valid | 1 | 1× insert | 11 (11) | Y/Y | n/n | – |
| sympy-15345 | valid | 2 | 2× insert | 3 (3) | n/n | n/n | `"Max"`, `"Min"`, `_print_MinMaxBase` |
| sympy-17139 | valid | 1 | 1× insert | 2 (2) | n/n | n/n | `is_real` |
| sympy-19954 | valid | 3 | 1× 1-line, 2× multi | 5 (2) | n/n | n/n | `blocks_remove_mask` |
| django-15563 | valid_weak | 5 | 1× multi, 2× insert, 2× 1-line | 17 (14) | n/n | n/n | `related`, `related_ids_index`, `parent`, `join_field`, `get_path_to_parent`, `defaultdict` |
| sympy-12096 | valid_weak | 1 | 1× 1-line | 1 (0) | Y/Y | n/n | – |
| django-15375 | fails_on_gold | 1 | 1× multi | 3 (2) | n/n | n/n | `coalesce`, `is_summary` |
| pytest-7324 | fails_on_gold | 3 | 1× insert, 2× 1-line | 3 (1) | n/n | n/n | `IDENT_PREFIX`, `"$"` |
| sympy-16792 | fails_on_gold | 4 | 1× new def, 1× delete, 2× multi | 8 (6) | Y/Y | n/n | – |
| sympy-20428 | fails_on_gold | 1 | 1× 1-line | 1 (0) | n/n | n/n | `is_zero` |
| pylint-4604 | passes_on_base | 3 | 3× insert | 5 (5) | n/n | n/n | `platform`, `python_implementation`, `"PyPy"` |
| sympy-22080 | passes_on_base | 3 | 1× 1-line, 1× multi, 1× insert | 5 (4) | n/n | n/n | `PRECEDENCE`, `0.5`, `"Pow"`, `"Mul"`, `"Mod"` |
| pytest-10051 | not_runnable | 2 | 1× new def, 1× 1-line | 4 (3) | Y/Y | Y/Y | – |
| pytest-10081 | not_runnable | 1 | 1× multi | 3 (2) | Y/Y | n/n | – |
| pytest-7205 | not_runnable | 2 | 1× insert, 1× 1-line | 2 (1) | n/n | n/n | `saferepr`, `_pytest`, `_io`, `maxsize`, `42` |
| django-14787 | no_pick | 1 | 1× 1-line | 1 (0) | Y/Y | n/n | – |
| django-15916 | no_pick | 4 | 1× insert, 1× delete, 2× 1-line | 3 (1) | Y/Y | n/Y | – |
| pylint-6386 | no_pick | 8 | 7× insert, 1× 1-line | 8 (7) | n/Y | n/Y | – |
| pytest-10356 | no_pick | 2 | 1× multi, 1× 1-line | 24 (18) | n/n | n/n | `item`, `mark_attribute`, `mark_lists`, `__dict__`, `__mro__` |
| sympy-13798 | no_pick | 1 | 1× multi | 13 (13) | n/n | n/n | `'\:'`, `'\;'`, `'\quad'` |
| django-14725 | no_blocks | 5 | 3× multi, 2× insert | 9 (7) | n/n | n/n | `'edit_only'` |
| django-15103 | no_blocks | 3 | 2× 1-line, 1× multi | 9 (3) | n/n | n/n | `template` |
| django-15572 | no_blocks | 2 | 2× 1-line | 2 (0) | Y/Y | Y/Y | – |
| django-16100 | no_blocks | 1 | 1× multi | 4 (3) | Y/Y | n/Y | – |
| requests-1142 | no_blocks | 2 | 1× delete, 1× insert | 2 (2) | n/Y | Y/Y | – |
| pylint-4970 | no_blocks | 1 | 1× insert | 2 (2) | Y/Y | Y/Y | – |
| sympy-12489 | no_blocks | 34 | 30× 1-line, 1× delete, 3× multi | 37 (2) | Y/Y | n/n | – |

Of the 21 non-oracle instances: 7 single-hunk, 14 multi-hunk; vocabulary complete on 11; coverage-study reach 4 (7 with
2-sub donors). Note that this study found the coverage-study recognisers generous at hunk level (requests-2931's guard,
django-15315's statement): the 4/7 should be read as an upper bound for the implemented sources.

## Missing capabilities, ranked by instances unlocked

Unlock counts are for the 9 oracle instances (the 21 others in parentheses where the same gap is visible in the table
above). "Unlock" means the test-passing fix identified above enters a source's candidate set; ranking loss is not
modelled.

1. **Corpus and file beam without the alphabetical 400-file cut — 5/9 (15345, 17139, 15315, 15128, 15563), a precondition
   for everything below.** Design, Jev-only: keep `MAX_WORKSPACE_PY_FILES` as a *read* budget but choose which 400 to read
   by code-computed relevance instead of path order: score every `.py` path by (a) overlap between its path segments /
   module name and the code-like words of the issue text (`namesInProse`, sieve/queue.ts:112-131: `mathematica_code` →
   `printing/mathematica.py`, `sylow_subgroup`/`minimal_blocks` → the file that defines them via a one-pass `def` index),
   (b) traceback frames when the issue has one (`frame_in_fix` anchors were in the gold file 3/3, oracle-from-issue.md), (c)
   the F2P test file's imports when a test patch is present; read the top-400 by score, then let the existing file-beam
   Choice run over that list. No new question; the only Jev decision stays the file pick. Also let the donor index and the
   queue vocabulary see *every* file's NAME tokens (tokenising 850 files took 1.7–4 s here) even when only 400 are analysed.

2. **Introspection-derived names — 2/9 (15345, 17139) (+ sympy-20428 `is_zero`, and the `__mro__`/`__dict__` names of
   pytest-10356).** The gold names are not in the file, the tests or the issue, but they are on the objects of the failing
   call: `type(Max(x, 2)).__mro__` → `MinMaxBase`; `dir(rv.exp)` → `is_real` (68 `is_*` attributes on `ImaginaryUnit`).
   Design, Jev-only: the oracle runner already executes the reproduction statement by statement
   (src/synth/oracle/runner.ts); add a `sys.settrace`-free introspection pass that, for the located function, wraps its
   entry to record `type(arg).__mro__` names and `[n for n in dir(arg) if not n.startswith('__')]` for each parameter and
   for attributes read on the failing line (`rv.exp`), bounded (≤ 40 names per object, ≤ 6 objects). Those names join
   `EnumerateOptions.taskIdentifiers` (so `adaptIdentifiers`, the slot vocabulary and the beam vocabulary see them:
   donor/adapt.ts:70-73, fill/state.ts:177, beam/vocab.ts:104) and the queue vocabulary (sieve/queue.ts:137-150). Two
   code-side compositions make them land: an attribute-predicate guard `if not <subject>.<is_attr>: <sibling return>` in
   templates/guards.ts (bodies from `returnDefaults` already include `return rv`), and a dispatch-name production
   `<prefix>_<MroName> = <existing method>` when the file defines names with a shared prefix (`_print_`, `visit_`,
   `_eval_`) — Jev chooses among the ≤ 255 concrete lines, as everywhere else.

3. **`history` source — 1/9 (15315) (+ any "regression since #N" issue).** The gold line is the pre-#31750 body verbatim.
   Design, Jev-only: `git log -S<currentLine> -- <file>` (or the commit/ticket number the issue names, matched against
   `git log --grep`) over the located function; for each of the ≤ 5 most recent commits that touched it, the function's
   body at `commit~1` becomes one statement-level candidate (`replace` of the whole current statement run, deletions as
   `extraEdits`), so the "revert" of a named change is a single option in the set; the tests decide, Jev arbitrates only
   among passers. Requires the statement-level `Site` of item 4 to apply cleanly.

4. **Statement-level replace sites — 1/9 (15315) (+ django-16100, django-14725's 8-line wraps).** `Site.currentLine` is
   one physical line; a multi-line statement is only editable line by line, and 1,143 of 2,171 candidates broke the module.
   Design: when `statementAt(mod, line)` spans several physical lines, emit a second `Site` whose `currentLine` is the
   statement joined onto one logical line and whose candidates carry `delete` `extraEdits` for the continuation lines (the
   composite donor-body unit already does exactly this for statement runs, composite.ts:622-668); sources then see
   `return hash((a, b, c))` whole, and a `collapse_collection_to_element` operator (keep one element of a tuple/list literal)
   yields the gold at depth 1.

5. **Stdlib-sibling callee substitution with the import as `extraEdits` — 1/9 (11618) (+ pytest-7205 `saferepr` if the
   table includes repo modules).** `zip` → `zip_longest(…, fillvalue=0)` + `from itertools import zip_longest` passes F2P.
   Design: a small table of callee families (`zip`/`zip_longest`, `dict`/`defaultdict`/`OrderedDict`, `sorted`/`nlargest`,
   `open`/`Path.open`, `map`/`starmap`, …) in templates/attribute.ts `calleeAlternatives` (attribute.ts:66-79), each
   alternative carrying its import line from `importLinesFor` (imports.ts:185-207) as an `extraEdit` at
   `importInsertLine`, plus the family's characteristic keyword (`fillvalue=0`) as a second draft. Deterministic, ≤ 10
   lines per call.

6. **Depth-2 wraps (template ∘ mutation / template ∘ template) — 1/9 (19954).** `reversed(list(enumerate(rep_blocks)))`
   passes F2P; composite pairs take 10 seeds and 100 pairs (composite.ts:39-41) and compose only mutation on a seed
   (composite.ts:695). Design: allow the wrap templates as `second` sources for seeds that are themselves wraps, and let
   the sketch pool carry a double-wrap production `_(_(span))` (P5 twice) so Jev's Q12 sees the shape as one option; ≤ 30
   extra sketches per site.

7. **Parameter threading with a repo-wide parameter-name pool — 1/9 (15128) (+ django-14725 `edit_only`, pylint-6386
   `metavar`, django-15103 `element_id`).** The composite signature unit is the right shape; its name pool
   (templates/signature.ts:105-125) lacks `exclude`, which 8 other django signatures use. Design: index `def` parameter
   names with defaults across the (whole) corpus once, offer the ≤ 20 most frequent names not already parameters as
   `add_param_from_repo` drafts, and pair the header with the two idiomatic body forms the corpus shows for that name
   (`if exclude is None: exclude = {}` is the body in 5 of the 8 django uses; the comprehension filter is the fix's third
   edit and stays out of reach without a per-name idiom template).

8. **Guard bodies copied from a sibling statement — 0/9 for the tests (requests-2931's second hunk is not test-needed),
   but 3 SWE guard hunks in coverage-study.** Design: in templates/guards.ts add bodies `<subject> = <sibling call>(<subject>)`
   taken from same-file statements of the form `x = f(x)`; cheap and bounded.

Out of reach for any enumerative source, by construction: sympy-11618's 14-line branch, sympy-19954's three coupled
hunks, django-15563's 20-line MTI logic, django-15128's four coupled edits as the gold writes them. Their test-equivalent
one-liners (items 5–6) are the only Jev-only route.

## The budget question

At every gold site the SEEDS phase enumerates 380–790 candidates (four sources × ≤ 254; composite ≤ 100 pairs here since
signature and donor-body units were disabled, see caveats). With the issue-oracle `t_run` of 138–2,169 ms all nine sit at
or under `SIEVE_MAX_T_RUN_MS = 2,000` except sympy-17139 (2,169 ms), so `decideRunPlan` (budget.ts:601-606) chooses SIEVE
when the step's wall allows: the measured sieve cost is 712 runs in 856 s (sympy-12096, 4 lanes, median 4.6 s under
load) and 2,171 runs in 859 s (django-15315, 5 sites, median 1.3 s). One site of 700 candidates is therefore 3–15 minutes
of `python3` at 4 lanes, or ≤ 254 Jev-ranked at $0.0008 per request in RANK mode; the design's 6 + 6 sites make a full
SEEDS pass 5–10× that. The passers the sieve surfaces are few (40 / 712 and 38 / 2,171) and mostly wrong (32 of 40 and 35
of 38 fail F2P), so the guard's clustering and arbitration, not the enumeration, decides the outcome on the two instances
the sources reach non-trivially.

## Caveats

- Composite's donor-body units (composite.ts:622-668) and signature units (composite.ts:464-510) were **disabled** in the
  per-site runs after one call each did not return within 6 and 10 minutes on a 400-file sympy corpus (`donorBlocks`
  walks every def of every corpus file × every 3–5-line window × `adaptIdentifiers`; `callSiteEdits` runs `scopeAt` on
  every statement of every corpus file per header draft). Donor-body units were measured once at sympy-12096's site
  (28.7 s, 48 units, no hit; `out/reach-oracle-9.sympy__sympy-12096.units.json`); signature units did not finish within the
  10-minute cap (`out/log-signature-units-12096.txt`). Neither can produce the gold on these nine (units need ≥ 3-line donor
  windows of a sibling def; signature units need a name in the pool), but the timing is itself a finding for the design's
  repository-class step budget.
- Sites were placed at the gold line by construction; localisation quality (file beam, Q5 anchors, gap slots) is not
  measured here beyond finding 1 and the `functionGapSlots` legality column (legal for 17139 and 2931; class-body and
  module-level gaps have no slot builder).
- "Test-equivalent" means the instance's FAIL_TO_PASS tests pass with the test patch applied; PASS_TO_PASS was not run, so
  the degenerate django-15315 passers may still be rejected by the full evaluator.
- The two sieve runs used the issue-oracle scripts as the criterion, as the design would; their medians (4.6 s, 1.3 s) were
  measured with three enumeration batches running concurrently on the same machine and are 2–5× the unloaded oracle timings.
- n = 9 instances; the classification of the 21 others rests on `coverage-study.json`'s line-level recognisers.

## Reproduce

```
node --env-file=.env node_modules/.bin/tsx experiments/reach/reach-oracle-9.mts            # ≈ 25 min, $0
node --env-file=.env node_modules/.bin/tsx experiments/reach/hunk-subsets.mts               # F2P runs, ≈ 3 min
node --env-file=.env node_modules/.bin/tsx experiments/reach/sieve-at-site.mts --lanes=4    # ≈ 30 min of python3
node --env-file=.env node_modules/.bin/tsx experiments/reach/passers-vs-f2p.mts sympy__sympy-12096
node --env-file=.env node_modules/.bin/tsx experiments/reach/statement-site-15315.mts
python3 experiments/reach/non_oracle_21.py
```
