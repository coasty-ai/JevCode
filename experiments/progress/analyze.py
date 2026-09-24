#!/usr/bin/env python3
"""Turn results.json into Markdown tables (tables.md) for the probe-progress deliverable."""
import json
import math
import os
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "results.json")))
C = json.load(open(os.path.join(HERE, "candidates.json")))
out = []
P = out.append


def auroc(pairs):
    pos = [p for p, t in pairs if t]; neg = [p for p, t in pairs if not t]
    if not pos or not neg:
        return float("nan")
    wins = sum(1 if p > q else 0.5 if p == q else 0 for p in pos for q in neg)
    return wins / (len(pos) * len(neg))


def brier(pairs):
    return sum((p - (1 if t else 0)) ** 2 for p, t in pairs) / len(pairs)


def acc(pairs, thr):
    return sum(1 for p, t in pairs if (p >= thr) == t) / len(pairs)


def best_thr(pairs):
    best = max((acc(pairs, t / 100), t / 100) for t in range(5, 96, 5))
    return best


def spearman(xs, ys):
    def rank(v):
        s = sorted(range(len(v)), key=lambda i: v[i]); r = [0.0] * len(v); i = 0
        while i < len(s):
            j = i
            while j + 1 < len(s) and v[s[j + 1]] == v[s[i]]:
                j += 1
            for k in range(i, j + 1):
                r[s[k]] = (i + j) / 2 + 1
            i = j + 1
        return r
    rx, ry = rank(xs), rank(ys); n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else float("nan")


meta = R["meta"]
P(f"Run: {meta['date'][:19]}Z, model `{meta['model']}`, {meta['programs']} programs, {meta['candidates']} candidates, {meta['requests']} requests, cost ${meta['costUsd']:.4f}, Jev latency p50 {meta['latencyP50']:.0f} ms, p95 {meta['latencyP95']:.0f} ms.\n")

kinds = Counter(c["labels"]["kind"] for p in C.values() for c in p["candidates"])
P("### Candidate set\n")
P("| kind | n | definition (ground truth computed from the test runs) |\n| --- | --- | --- |")
defs = {"fix": "correct program; every test passes", "buggy_noop": "the buggy original re-applied (no-op edit): results identical to `before`", "partial": "passes strictly more tests than `before`, breaks none, some still fail", "partial_mixed": "passes more tests than `before` but also breaks at least one that passed", "regression": "passes fewer tests than `before`", "lateral": "same pass count as `before` but a different set (broke one, fixed another)", "no_change": "a different program with the same set of passing tests as `before` (actual outputs may differ)"}
noop = sum(1 for p in C.values() for c in p["candidates"] if c["id"] == "buggy_noop")
for k in ["fix", "partial", "partial_mixed", "regression", "lateral", "no_change"]:
    n = kinds[k] - (noop if k == "no_change" else 0)
    P(f"| {k} | {n} | {defs[k]} |")
P(f"| buggy_noop | {noop} | {defs['buggy_noop']} (counted under no_change in the label tables) |")
P("")

# ---------------- Part 1 ----------------
rows = R["noulRows"]
P("### Part 1. Nouls from test results\n")
P("| Noul | variant | n | positives | acc @0.5 | best thr (acc) | Brier | AUROC | wrong @0.5 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
wrong_rows = []
for q in ["program_correct", "made_progress", "broke_something"]:
    for v in ["counts", "raw", "both"]:
        pairs = [(r["p"][q], r["truth"][q]) for r in rows if r["variant"] == v]
        bt = best_thr(pairs)
        wrongs = [r for r in rows if r["variant"] == v and (r["p"][q] >= 0.5) != r["truth"][q]]
        wrong_rows += [(q, v, r) for r in wrongs]
        P(f"| {q} | {v} | {len(pairs)} | {sum(1 for _, t in pairs if t)} | {acc(pairs, 0.5):.3f} | {bt[1]:.2f} ({bt[0]:.3f}) | {brier(pairs):.3f} | {auroc(pairs):.3f} | {len(wrongs)} |")
P("")
P("Accuracy at 0.5 by candidate kind (counts / raw / both):\n")
P("| kind | n | program_correct | made_progress | broke_something |\n| --- | --- | --- | --- | --- |")
for k in ["fix", "partial", "partial_mixed", "regression", "lateral", "no_change"]:
    cells = []
    n = 0
    for q in ["program_correct", "made_progress", "broke_something"]:
        parts = []
        for v in ["counts", "raw", "both"]:
            sub = [r for r in rows if r["variant"] == v and r["kind"] == k]
            n = len(sub)
            parts.append(f"{sum(1 for r in sub if (r['p'][q] >= 0.5) == r['truth'][q])}/{len(sub)}")
        cells.append(" / ".join(parts))
    P(f"| {k} | {n} | " + " | ".join(cells) + " |")
P("")
P("Every answer wrong at 0.5:\n")
P("| Noul | variant | program | candidate | kind | before | after | truth | p |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
for q, v, r in wrong_rows:
    prog = C[r["program"]]; cand = next(c for c in prog["candidates"] if c["id"] == r["cand"])
    P(f"| {q} | {v} | {r['program']} | {r['cand']} | {r['kind']} | {prog['before']['passed']}/{prog['before']['total']} | {cand['after']['passed']}/{cand['after']['total']} | {r['truth'][q]} | {r['p'][q]:.2f} |")
P("")
P("Distribution of p for the `made_progress` Noul on partial candidates (the hard positives), by variant:\n")
P("| program | candidate | before | after | p counts | p raw | p both | broke: p counts / raw / both |\n| --- | --- | --- | --- | --- | --- | --- | --- |")
for p in C.values():
    for c in p["candidates"]:
        if c["labels"]["kind"].startswith("partial"):
            ps = {r["variant"]: r for r in rows if r["program"] == p["program"] and r["cand"] == c["id"]}
            P(f"| {p['program']} | {c['id']} | {p['before']['passed']}/{p['before']['total']} | {c['after']['passed']}/{c['after']['total']} | {ps['counts']['p']['made_progress']:.2f} | {ps['raw']['p']['made_progress']:.2f} | {ps['both']['p']['made_progress']:.2f} | {ps['counts']['p']['broke_something']:.2f} / {ps['raw']['p']['broke_something']:.2f} / {ps['both']['p']['broke_something']:.2f} |")
P("")

# ---------------- Part 4 ----------------
P("### Part 4. Score calibration: `closeness` (5 levels) vs true fraction of passing tests\n")
levels = ["nothing_works", "mostly_broken", "half_way", "nearly_correct", "correct"]
def bin_of(f):
    if f == 0: return 0
    if f < 0.4: return 1
    if f <= 0.6: return 2
    if f < 1: return 3
    return 4
P("Rows: true pass fraction bins (0 | (0,0.4) | [0.4,0.6] | (0.6,1) | 1). Cells: how often each level was the argmax; last columns: mean expected level (sum p·k, 0..4) and mean true fraction.\n")
for v in ["counts", "raw", "both"]:
    sub = [r for r in rows if r["variant"] == v]
    P(f"Variant `{v}` (n={len(sub)}):\n")
    P("| true bin | n | " + " | ".join(levels) + " | mean E[level] | mean true fraction | argmax = bin |\n| --- | --- | " + " | ".join("---" for _ in levels) + " | --- | --- | --- |")
    hits = 0
    for b in range(5):
        bs = [r for r in sub if bin_of(r["true_fraction"]) == b]
        if not bs:
            continue
        am = Counter(max(range(5), key=lambda i: r["score_probs"][i]) for r in bs)
        hit = am[b]; hits += hit
        P(f"| {levels[b]} | {len(bs)} | " + " | ".join(str(am[i]) for i in range(5)) + f" | {sum(r['score_expected'] for r in bs) / len(bs):.2f} | {sum(r['true_fraction'] for r in bs) / len(bs):.2f} | {hit}/{len(bs)} |")
    sp = spearman([r["score_expected"] for r in sub], [r["true_fraction"] for r in sub])
    P(f"\nargmax level equals true bin: {hits}/{len(sub)} ({hits / len(sub):.3f}); Spearman(E[level], true fraction) = {sp:.3f}; mean |E[level]/4 − true fraction| = {sum(abs(r['score_expected'] / 4 - r['true_fraction']) for r in sub) / len(sub):.3f}\n")

# ---------------- Part 2 ----------------
mv = R["moveRows"]
P("### Part 2. Choice over the next move\n")
opts = ["keep_and_stop", "keep_and_continue", "revert_and_try_next_candidate", "revert_and_relocalise", "widen_search", "none_of_these"]
P(f"n = {len(mv)}; chosen matches the expected move: {sum(1 for r in mv if r['ok'])}/{len(mv)} ({sum(1 for r in mv if r['ok']) / len(mv):.3f}); mean p on the expected move {sum(r['p_expected'] for r in mv) / len(mv):.2f}.\n")
P("Confusion (rows: expected move for the case; columns: Jev's argmax):\n")
P("| expected | n | " + " | ".join(opts) + " |\n| --- | --- | " + " | ".join("---" for _ in opts) + " |")
for e in opts[:-1]:
    sub = [r for r in mv if r["expected"][0] == e and len(r["expected"]) == 1]
    if not sub: continue
    c = Counter(r["chosen"] for r in sub)
    P(f"| {e} | {len(sub)} | " + " | ".join(str(c[o]) for o in opts) + " |")
sub = [r for r in mv if len(r["expected"]) > 1]
if sub:
    c = Counter(r["chosen"] for r in sub)
    P(f"| partial_mixed (continue or try_next) | {len(sub)} | " + " | ".join(str(c[o]) for o in opts) + " |")
P("\nBy candidate kind:\n")
P("| kind | n | correct | mean p(expected) |\n| --- | --- | --- | --- |")
for k in ["fix", "partial", "partial_mixed", "regression", "lateral", "no_change"]:
    sub = [r for r in mv if r["kind"] == k]
    P(f"| {k} | {len(sub)} | {sum(1 for r in sub if r['ok'])}/{len(sub)} | {sum(r['p_expected'] for r in sub) / len(sub):.2f} |")
P("\nEvery miss:\n")
P("| program | candidate | kind | before | after | search (remaining, untried lines) | expected | chosen | p(expected) | p(chosen) |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
for r in mv:
    if not r["ok"]:
        prog = C[r["program"]]; cand = next(c for c in prog["candidates"] if c["id"] == r["cand"])
        P(f"| {r['program']} | {r['cand']} | {r['kind']} | {prog['before']['passed']}/{prog['before']['total']} | {cand['after']['passed']}/{cand['after']['total']} | {r['search']['candidates_remaining_for_this_line']}, {r['search']['untried_suspicious_lines']} | {'/'.join(r['expected'])} | {r['chosen']} | {r['p_expected']:.2f} | {r['probs'][r['chosen']]:.2f} |")
P("\nPartial candidates, full distribution:\n")
P("| program | candidate | before | after | " + " | ".join(opts) + " |\n| --- | --- | --- | --- | " + " | ".join("---" for _ in opts) + " |")
for r in mv:
    if r["kind"].startswith("partial"):
        prog = C[r["program"]]; cand = next(c for c in prog["candidates"] if c["id"] == r["cand"])
        P(f"| {r['program']} | {r['cand']} | {prog['before']['passed']}/{prog['before']['total']} | {cand['after']['passed']}/{cand['after']['total']} | " + " | ".join(f"{r['probs'].get(o, 0):.2f}" for o in opts) + " |")
P("")

# ---- Part 2b: variant B (code-computed deltas in state), code-routed move, noise ----
R2 = json.load(open(os.path.join(HERE, "results2.json")))
mb = R2["moveB"]
P("### Part 2b. Variant B: `after.newly_passing_tests` / `after.newly_failing_tests` computed by code, option descriptions name them\n")
P(f"n = {len(mb)}; chosen matches expected: {sum(1 for r in mb if r['ok'])}/{len(mb)} ({sum(1 for r in mb if r['ok']) / len(mb):.3f}); mean p on the expected move {sum(r['p_expected'] for r in mb) / len(mb):.2f}; requests {R2['meta']['requests']}, cost ${R2['meta']['costUsd']:.4f} (incl. the noise repeats), p50 {R2['meta']['latencyP50']:.0f} ms.\n")
P("| kind | n | variant A correct | variant A mean p(expected) | variant B correct | variant B mean p(expected) |\n| --- | --- | --- | --- | --- | --- |")
for k in ["fix", "partial", "partial_mixed", "regression", "lateral", "no_change"]:
    sa = [r for r in mv if r["kind"] == k]; sb = [r for r in mb if r["kind"] == k]
    P(f"| {k} | {len(sa)} | {sum(1 for r in sa if r['ok'])}/{len(sa)} | {sum(r['p_expected'] for r in sa) / len(sa):.2f} | {sum(1 for r in sb if r['ok'])}/{len(sb)} | {sum(r['p_expected'] for r in sb) / len(sb):.2f} |")
P("\nPartial candidates under variant B:\n")
P("| program | candidate | before | after | newly passing / failing | p(keep_and_continue) | p(revert_and_try_next_candidate) |\n| --- | --- | --- | --- | --- | --- | --- |")
for r in mb:
    if r["kind"].startswith("partial"):
        prog = C[r["program"]]; cand = next(c for c in prog["candidates"] if c["id"] == r["cand"])
        P(f"| {r['program']} | {r['cand']} | {prog['before']['passed']}/{prog['before']['total']} | {cand['after']['passed']}/{cand['after']['total']} | {len(cand['labels']['newly_passing'])} / {len(cand['labels']['newly_failing'])} | {r['probs'].get('keep_and_continue', 0):.2f} | {r['probs'].get('revert_and_try_next_candidate', 0):.2f} |")
# code-routed move from the three Nouls (variant both, thresholds 0.5) + search numbers
def route(pc, pp, pb, search):
    if pc >= 0.5: return "keep_and_stop"
    if pp >= 0.5 and pb < 0.5: return "keep_and_continue"
    if search["candidates_remaining_for_this_line"] > 0: return "revert_and_try_next_candidate"
    if search["untried_suspicious_lines"] > 0: return "revert_and_relocalise"
    return "widen_search"
P("\nCode-routed move (no Choice at all: the three Nouls of Part 1, variant `both`, thresholded at 0.5, then an if-chain over `search` in code):\n")
P("| variant of the Nouls | n | routed move matches expected |\n| --- | --- | --- |")
for v in ["counts", "raw", "both"]:
    ok = 0
    for r in mv:
        nr = next(x for x in rows if x["program"] == r["program"] and x["cand"] == r["cand"] and x["variant"] == v)
        m = route(nr["p"]["program_correct"], nr["p"]["made_progress"], nr["p"]["broke_something"], r["search"])
        ok += m in r["expected"]
    P(f"| {v} | {len(mv)} | {ok}/{len(mv)} ({ok / len(mv):.3f}) |")
rp = R2["repeats"]
P("\nNoise: the 13 partial candidates asked 3 more times (state `both` + `edit` + `search`; Nouls and move variant A in one request). Spread = max − min over the 3 repeats.\n")
P("| program | candidate | made_progress (3 repeats) | broke_something (3 repeats) | p(keep_and_continue) (3 repeats) | spread of p(keep_and_continue) |\n| --- | --- | --- | --- | --- | --- |")
by = defaultdict(list)
for r in rp: by[(r["program"], r["cand"])].append(r)
spreads = []
for (pg, cd), rs in by.items():
    rs.sort(key=lambda r: r["rep"])
    ks = [r["p_keep_and_continue"] for r in rs]; spreads.append(max(ks) - min(ks))
    mp_s = " / ".join("%.2f" % r["made_progress"] for r in rs); bs_s = " / ".join("%.2f" % r["broke_something"] for r in rs); ks_s = " / ".join("%.2f" % k for k in ks)
    P(f"| {pg} | {cd} | {mp_s} | {bs_s} | {ks_s} | {max(ks) - min(ks):.2f} |")
P(f"\nMean spread of p(keep_and_continue) over repeats: {sum(spreads) / len(spreads):.3f}; max {max(spreads):.2f}. Noul spread: made_progress max {max(max(r['made_progress'] for r in rs) - min(r['made_progress'] for r in rs) for rs in by.values()):.2f}, broke_something max {max(max(r['broke_something'] for r in rs) - min(r['broke_something'] for r in rs) for rs in by.values()):.2f}.\n")

# ---------------- Part 3 ----------------
at = R["attackRows"]
P("### Part 3. Which failing test to attack first\n")
n = len(at)
def mrr(key): return sum(1 / r[key] for r in at) / n
rand_top1 = sum(1 / r["n_failing"] for r in at) / n
rand_tie = sum(r["lengths"].count(min(r["lengths"])) / len(r["lengths"]) for r in at) / n  # random baseline when ties count as hits
P(f"n = {n} programs with ≥ 2 failing tests (up to 10 offered). 'Simplest' = shortest JSON serialisation of the input (ties broken by list order).\n")
P("| question | top-1 = simplest | MRR of simplest | random top-1 baseline | mean p(argmax) | none_of_these mass |\n| --- | --- | --- | --- | --- | --- |")
for key, probs in [("neutral", "neutral_probs"), ("explicit", "explicit_probs")]:
    top1 = sum(1 for r in at if r[f"{key}_rank_of_simplest"] == 1)
    P(f"| {key} | {top1}/{n} ({top1 / n:.2f}) | {mrr(f'{key}_rank_of_simplest'):.3f} | {rand_top1:.2f} | {sum(max(r[probs].values()) for r in at) / n:.2f} | {sum(r[probs].get('none_of_these', 0) for r in at) / n:.2f} |")
# rank correlation between chosen-probability and input length
sp_n = []; sp_e = []
for r in at:
    keys = [k for k in r["neutral_probs"] if k != "none_of_these"]
    ids = [int(k.split("_")[-1]) for k in keys]
    prog = C[r["program"]]
    fails = [t for t in prog["before"]["tests"] if t["status"] != "pass"][:10]
    # compact separators: match the probe's JSON.stringify length (json.dumps default adds spaces)
    lens = {f"failing_test_{t['id']}": len(json.dumps(t["input"], separators=(",", ":"))) for t in fails}
    if len(keys) >= 3 and len(set(lens.values())) > 1:
        sp_n.append(spearman([r["neutral_probs"][k] for k in keys], [-lens[k] for k in keys]))
        sp_e.append(spearman([r["explicit_probs"][k] for k in keys], [-lens[k] for k in keys]))
    r["_lens"] = lens
P(f"\nMean per-program Spearman(p, −input length) over programs with ≥ 3 failing tests and unequal lengths (n={len(sp_n)}): neutral {sum(sp_n) / len(sp_n):.2f}, explicit {sum(sp_e) / len(sp_e):.2f}.\n")
tie_n = sum(1 for r in at if r["neutral_choice"] in r["_lens"] and r["_lens"][r["neutral_choice"]] == min(r["_lens"].values()))
tie_e = sum(1 for r in at if r["explicit_choice"] in r["_lens"] and r["_lens"][r["explicit_choice"]] == min(r["_lens"].values()))
P(f"Counting ties as hits (argmax input length equals the minimum length): neutral {tie_n}/{n} ({tie_n / n:.2f}), explicit {tie_e}/{n} ({tie_e / n:.2f}). Programs where every input has the same length: {sum(1 for r in at if len(set(r['_lens'].values())) == 1)}. Random top-1 baseline when ties count as hits: {rand_tie:.2f}.\n")
P("| program | failing offered | input lengths (chars) | neutral choice | rank of simplest (neutral) | explicit choice | rank of simplest (explicit) |\n| --- | --- | --- | --- | --- | --- | --- |")
for r in at:
    P(f"| {r['program']} | {r['n_failing']} | {','.join(str(x) for x in r['lengths'])} | {r['neutral_choice']} ({max(r['neutral_probs'].values()):.2f}) | {r['neutral_rank_of_simplest']} | {r['explicit_choice']} ({max(r['explicit_probs'].values()):.2f}) | {r['explicit_rank_of_simplest']} |")
P("")

open(os.path.join(HERE, "tables.md"), "w").write("\n".join(out) + "\n")
print("\n".join(out))
