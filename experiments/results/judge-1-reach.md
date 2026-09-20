# Judge 1 (lens: reach) on the four Jev-only synthesis designs, 2026-09-20

Question: which design fixes the most bugs on the difficulty ladder (rung 1 QuixBugs 40, rung 2 ladder 12 tasks /
21 hunks, rung 3 SWE-bench Verified 30) given the *measured* coverage and selection numbers. No live Jev calls
were made for this judgement ($0.00). Every figure below was re-read from the file named, and the contrarian
design's new numbers were recomputed from `contrarian-exhaustive.{truth,all}.jsonl` and
`contrarian-arbitrate.{truth,all}.jsonl` (4,892 / 37,243 runs, 260 s / 1,181 s, gold PASS 35/36, only-gold 25/36,
arbitration 8/10 and 10/14 top-1, `depth_first_search` escape 0.90: all reproduce).

## Scores and ranking (reach, 0–10)

| Rank | Design | Score | Rung 1 predicted (design) | Rung 1 as I read the evidence | Rung 2 (ladder 12) | Rung 3 (SWE 30) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `test-driven-decomposition.md` | **8.0** | 35–37 | 35–37 | **8–10** (only design with a per-task ladder table; goal ledger commits each verified sub-goal) | 3–6, central 4 (9 coverage-reachable instances, 8 of them chained-localised) |
| 2 | `contrarian.md` (Sieve) | **7.5** | 37–39 | **38–39** (the only rung-1 number backed by an end-to-end measurement of the mechanism) | 6–8 (never commits a partial; 3-hunk, coupled and 3-line tasks fail by construction) | 2–4 |
| 3 | `repair-search.md` | **7.0** | 34–36 | 34–36 | 7–9 (mechanism exists: Q-T1 per-test order, base beam B=2 depth 3; no prediction given) | 2–5, central 3 |
| 4 | `grammar-synthesis.md` | **5.0** | 35 ± 2 | 34–36 | 6–8 (vague: "solved when each hunk is individually testable") | 2–4 (list of reachable instances contains an error, below) |

### Justifications

**test-driven-decomposition (8.0).** Its reach argument is the only one that covers all three rungs with the measured
gates in the right order. Rung 1: coverage 40/40 (`coverage-study.md`), localisation D ∪ C top-3 38/40 plus Ochiai
top-5 34/38 (`probe-localization.md`, `lit-search-based-repair.md` §6), Nouls top-3 40/40 at N ≤ 50 and 36–39/40 at
254 (`probe-selection.md`), and the beam of bases that removes the greedy trap (3 of 8 prototype failures over two runs,
`prototype-baseline.md`). Rung 2: the ladder README's verification matrix says every hunk of the five multi-bug tasks
fixes ≥ 1 test alone; a goal ledger that commits one verified cluster per step and re-baselines is exactly what those
tasks need, and its per-task table (inventory/grades/textstats 3/3, account/calendar_utils 2/2, guards 2/2, import,
constant, attribute 1/1 each, `table`/`units` 0–1) follows the template coverage table (`guard_insertion` 2/3,
`add_parameter_default` 2/3, `add_branch_copy` 1/1 reachable only by templates). Rung 3: its per-instance table
matches the chained view (`probe-swebench-understanding.md`: django-16100 file #2, pylint-6386 #17, django-15572 fn 2,
pylint-4970 fn 3) and the coverage nine exactly. Reach cost: K_VERIFY = 3 and ≤ 12 subset runs per step is a tighter
ration than the prototype's 40 (which bound all 8 prototype failures), recovered only by continuing across steps and
at risk of the "2 budget-hit steps → park" rule. Nothing in it is measured end to end (its own risk 3).

**contrarian / Sieve (7.5).** Best rung-1 reach, and the only design that *measured* it: with the true line known,
every enumerated gold fix passes when run (35/36), 25/36 programs need no decision at all, and Jev arbitration on
the rest is 10/10 gold-or-equivalent for $0.0008 (Table 0.3); brute force over every line costs a median 23.8 s per
program and still leaves the gold as the only passer on 21/40 (Table 0.2), so the two prototype localisation misses
and two ranking misses vanish. That is worth +2–3 programs over the ranked designs on QuixBugs. It loses on the rest
of the ladder: `plausible` requires *every* F2P test to pass, partials are never committed, and only pairs of
partials from different sites are tried (≤ 10 runs), so the two 3-hunk ladder tasks, `table` and `units` are out of
reach and any SWE instance whose F2P tests need > 2 hunks likewise; its own risk 3 concedes the outer loop "must
decompose per failing test before the sieve". The 4 QuixBugs insertions are counted as reached (39/40 coverage) but
its own JSONL shows the sieve enumerated 0 gap-site candidates (`linesTried` 0 for all four in `truth`; 0 plausible for
3 of 4 in `all`), so that part of the 37–39 prediction is coverage arithmetic, not a sieve measurement. On SWE it
degrades to a Jev-ordered queue of 30–60 runs per step (risk 1), i.e. the design it argues against.

**repair-search (7.0).** The prototype's loop with five measured corrections; every correction is tied to a named
failure and a probe figure (F1–F11), and the per-program QuixBugs table is the most careful in the set (34–36).
Reach is bounded by the same ranked-verification shape as the prototype: compact Nouls in ≤ 254 chunks, verify
p ≥ 0.5 else top-3, ≤ 40 runs per step. Multi-hunk reach exists (Q-T1, base beam depth ≤ 3, `extraEdits`) but is
neither predicted nor measured on the ladder. SWE 2–5 with the honest 6–9/30 ceiling. One number is over-stated
(below), costing ~3 programs of claimed top-3 recall at N = 254.

**grammar-synthesis (5.0).** The sketch layer is measured (Appendix A: shape coverage 39/40, top-1 23–26, top-3
29–31, $0.00019/program) but adds no reach on any measured rung: the concrete mutation + template + donor union already
covers 40/40 QuixBugs (`coverage-study.md`), the design itself runs Round 0 (concrete) first and says the sketch
"is not a precision layer", and on SWE the sketch's slots draw on the same file + tests vocabulary that caps reach at
15/30. Its predicted 35 ± 2 is the concrete route's number. Its SWE reachable-instance list contradicts the coverage
file (below).

## Fatal flaws (claims contradicted by a results file)

| Design | Claim | What the results file says | Severity for reach |
| --- | --- | --- | --- |
| grammar-synthesis §6.3 | `pytest-7205` is one of the 9 fully reachable SWE instances and among the "most likely" solves; `django-16100` omitted | `coverage-study.md` headline names the nine (incl. `django-16100`, not `pytest-7205`); per-instance row for `pytest-7205`: union 1/2, union 2-sub 1/2, vocabulary 0/2 (`saferepr` import is `template_slots_not_in_vocabulary`; `saferepr(x, maxsize=42)` unreachable) | high: the SWE prediction rests on an instance the sources cannot reach |
| contrarian §6 / §0 | insertions counted as reached ("4/4 insertions by statement templates = 39/40") inside the 37–39 prediction | `contrarian-exhaustive.truth.jsonl`: `linesTried` 0, `nCandidates` 0 for all 4 insertion bugs; `.all.jsonl`: 0 plausible for `reverse_linked_list`, `shunting_yard`, `wrap`; the 7 `depth_first_search` passers are all overfits | medium: the sieve never ran a gap-site candidate, so 4 of the predicted programs are unmeasured by the design's own experiment |
| contrarian §3.1 | "1–3 F2P tests in 27 of the 30 instances: lengths 1 for 22, 2–3 for 5, 10 and 21 for two" | `bench/data/swebench-verified-30.json`: 1 for 21, 2 for 4, 3 for 3 (28/30 have 1–3), 10 and 21 for two | low (arithmetic only) |
| repair-search F4 / §3.1 | "fix in the Noul top-3 39/40 at every N", used to justify "verify the top-3" for Q-R2 (compact Nouls) at N = 61–254 | `probe-selection.md`: compact Nouls top-3 40/40/38/36 at N = 10/50/150/254 (39/40 is the full-criteria row, 3× the tokens) | low–medium: the top-3 verify rule misses 4/40 at N = 254, not 1/40 |
| contrarian (structural, vs the brief) | rung-2 reach via "pairs of partials" | `docs/JEV-ONLY.md` success criterion: "multi-hunk ladder tasks solved by the outer loop decomposing per failing test"; ladder README: `account`, `calendar_utils` need 3 independent hunks, `table` 3 coupled | high for rung 2 |

Checked and found consistent: test-driven's per-instance SWE table (file/fn/line ranks, `pylint-4604` 2/3 hunks under the
2-sub union), repair-search's F1–F11 table, contrarian's Tables 0.1–0.4 totals, grammar-synthesis Appendix A totals.

## Best ideas to graft into the winner

1. **Contrarian's sieve when tests are cheap**: when `t_run × |candidates| / parallelism` fits the step budget, run every
   candidate at the K = 3 sites instead of ranking (median 3.8 s per QuixBugs program at the true line, 12 s for 3 sites);
   keep Jev ranking only as an *ordering* when the queue exceeds the budget (SWE). Removes `ranking_missed` entirely.
2. **Contrarian's `widened` brute-force phase** over every code line of the located function as the second step on
   single-file workspaces (median 24 s, max 119 s): removes `localisation_missed` (`lis`, `mergesort`) for certain.
3. **Contrarian's behaviour clustering + `Q_arbitrate` (+ paired `Q_general` Nouls)** as the measured overfit guard
   (10/10 and 13/14 gold-or-equivalent; all-overfit set rejected at escape 0.90, max Noul 0.06), and its rule "a plausible
   set whose best Noul < 0.3 is not proposed; move to gap sites" — replaces the unmeasured Q11/Q-V1 guards in the other three.
4. **Repair-search's insert gaps as first-class `Site`s** before/after the top-3 anchors (all four QuixBugs insertion
   neighbours are at D ranks 2–5) with top-3 verification regardless of p (gold statements sit at Noul 0.33–0.39).
5. **Repair-search's global verification queue** keyed by (base passed-count, Noul p) across sites, and its
   shuffle-and-average re-ask when the top-2 margin is < 0.10 on slow oracles (reshuffle moved `kth` 0.48 → 0.14).
6. **Repair-search's `hunk-subsets.py` ($0)**: apply every subset of gold hunks for the 9 reachable SWE instances to learn
   how many hunks the F2P tests actually demand, which decides the multi-hunk reach of any design before spending Jev.
7. **Grammar-synthesis's sketch pool as a size reducer at SWE scale**: median 64 shapes vs 1,641 mutants per line; a Choice over
   shapes then slot fill (S2 92 % at B = 3) is a way to keep candidate sets under 254 where the Noul decay bites — worth
   measuring on the 33 SWE depth-1 lines, not on QuixBugs.
8. **Grammar-synthesis's `edit_class` Choice as a soft source prior** (28–29/40 top-1, 35–36/40 top-2) to reorder
   sources per site, never to gate.

## What this means for the design

Build test-driven decomposition's outer structure (goal ledger, one verified sub-goal per step, park/revert, patch → run
alternation) and replace its rationed inner search with the contrarian sieve where the oracle is cheap: enumerate
everything at the K = 3 sites, run it all, cluster the passers, arbitrate with Jev only among disagreeing clusters, and
widen to brute force on single files before parking. Keep Jev ranking as queue ordering only when a run costs seconds.
Expected reach: QuixBugs 38–39/40 (contrarian's measured rung-1 number plus insertions via gap templates), ladder 9–10/12
(test-driven's per-task table; `table` and `units` remain out), SWE 3–5/30 bounded by the 9/30 coverage ceiling. The
three experiments that most change the numbers are contrarian's hidden-test overfit study (risk 2), repair-search's
`hunk-subsets.py`, and test-driven's `ladder-e2e` run.
