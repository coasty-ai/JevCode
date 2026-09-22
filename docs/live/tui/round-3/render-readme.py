"""Print the README measurement table from results.jsonl (one row per live drive). python3 render-readme.py <out-dir>"""
import json, sys
out = sys.argv[1]
rows = [json.loads(l) for l in open(f'{out}/results.jsonl') if l.strip()]
def ms(v): return '—' if v is None else f'{v} ms'
def s(v): return '—' if v is None else f'{v / 1000:.1f} s'
print('| run | provider (served) | geometry | driver exit · timeouts | clears · restores | first frame | splash settled | `hi` → `[jevcode]` | facts reply | task → `[run] start` | run (steps · stop · Jev $ · generator calls) | `[step N]` rows · stage rows | key bytes |')
print('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for r in rows:
    run = r['runs'][0] if r['runs'] else None
    served = (run or {}).get('resolvedJevModel') or '—'
    prov = f"`{r['provider']}` → {run['deciderProvider'] if run and run.get('deciderProvider') else '?'} (`{served}`)"
    gen = (run or {}).get('generator') or {}
    jev = (run or {}).get('jev') or {}
    runtxt = f"{s(r['run_ms'])}: {run['step']} steps · `{run['stopReason']}` · ${jev.get('costUsd', 0):.3f} · {gen.get('calls', '?')} generator calls" if run else '—'
    leaks = 'none' if not r['key_leaks'] else 'LEAK: ' + ', '.join(r['key_leaks'])
    print(f"| `{r['name']}` | {prov} | {r['geometry']} | {r['driver_exit']} · {r['timeouts']} | {r['clears_after_first_frame']} · {r['restores']} | {ms(r['first_frame_ms'])} | {ms(r['splash_settle_ms'])} ({r['splash']['wordmark_frames']} wordmark frames, {r['splash']['after_brand']} after the brand row) | **{ms(r['wall_hi_ms'])}** | {ms(r['wall_facts_ms'])} | {ms(r['wall_task_to_run_start_ms'])} | {runtxt} | {r['step_lines']} · {r['stage_lines_visible']} | {leaks} |")
hi = sorted(r['wall_hi_ms'] for r in rows if r['wall_hi_ms'] is not None)
facts = sorted(r['wall_facts_ms'] for r in rows if r['wall_facts_ms'] is not None)
task = sorted(r['wall_task_to_run_start_ms'] for r in rows if r['wall_task_to_run_start_ms'] is not None)
allw = sorted(hi + facts + task)
def p95(v): return v[min(len(v) - 1, max(0, -(-95 * len(v) // 100) - 1))] if v else None
print()
print(f"Intake wall times (Enter → the first `[jevcode]` / `[run] start` frame): `hi` {hi}, facts {facts}, task {task} ms — max {max(allw) if allw else '—'} ms, p95 {p95(allw)} ms over {len(allw)} intakes; gate p95 < 1500 ms (TUI-DESIGN-2 §9).")
