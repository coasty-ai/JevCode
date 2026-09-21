"""Summarise one S6 live drive: strip the capture, measure the mark pairs, read the run's spend, check for key bytes.
   python3 summarize.py <out-dir> <name> <driver-exit> <rows> <cols> <provider> <workspace> <home>
Prints one JSON line (also appended to <out-dir>/results.jsonl) — never a key value, never the workspace's file contents."""
import json, os, re, sys, glob, hashlib

out, name, code, rows, cols, prov, ws, home = sys.argv[1:9]
cap = os.path.join(out, f'{name}.cap'); tim = os.path.join(out, f'{name}.jsonl')
raw = open(cap, 'rb').read() if os.path.exists(cap) else b''
text = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', raw.decode('utf8', 'replace')).replace('\r', '')
open(os.path.join(out, f'{name}.txt'), 'w').write(text)

recs = []
if os.path.exists(tim):
    for line in open(tim):
        try: recs.append(json.loads(line))
        except Exception: pass
marks = {}
for r in recs:
    if r.get('op') == 'mark' and r['arg'] not in marks: marks[r['arg']] = r['t']
def wall(a, b): return (marks[b] - marks[a]) if a in marks and b in marks else None
timeouts = sum(1 for r in recs if r.get('op') == 'timeout')
auto = {'seen': sum(1 for r in recs if r.get('op') == 'auto-review-seen'), 'resolved': sum(1 for r in recs if r.get('op') == 'auto-review-resolved'), 'unresolved': sum(1 for r in recs if r.get('op') == 'auto-review-unresolved')}

# clears after the first dynamic frame (run-smoke.sh `clears`), restores (§14.2)
i = raw.find(b'\x1b[?25l'); tail = raw[i:] if i >= 0 else raw
clears = len(re.findall(rb'\x1b\[[0-9;]*2J(?:\x1b\[[0-9;]*3J)?|\x1b\[[0-9;]*3J|\x1bc|\x1b\[\?1049[hl]', tail))
restores = raw.count(b'\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m')
# splash: frames (BSU brackets) carrying wordmark cells before the brand row; none at or after it
frames = raw.split(b'\x1b[?2026h')[1:]
wm = [k for k, f in enumerate(frames) if b'\xe2\x96\x88\xe2\x96\x88' in f]
brand = [k for k, f in enumerate(frames) if '◆ jevcode'.encode() in f]
first_brand = brand[0] if brand else len(frames)
splash = {'wordmark_frames': len(wm), 'after_brand': sum(1 for k in wm if k >= first_brand), 'frames_before_brand': first_brand}

lines = text.split('\n')
def find(pat): return [l for l in lines if re.search(pat, l)]
jev_lines = find(r'(typesafe · api\.typesafe\.ai|openrouter · openrouter\.ai)')
resolved = find(r'→ resolved ')
replies = [l for l in lines if l.startswith('[jevcode] ')]
step_lines = [l for l in lines if re.match(r'^\[step \d+\] ', l)]
stage_visible = [l for l in step_lines if re.match(r'^\[step \d+\] (?:intent=|context |synth |proposal |risk[= ]|outcome |judge |plan )', l)]
run_start = find(r'^\[run\] start '); run_end = find(r'^\[run\] end ')
mode_items = find(r'^\[ui\] mode ')
wizard = bool(find(r'Pick the provider|Where do you reach Jev'))
wide = [len(l) for l in lines if len(l) > int(cols)]

# the run's spend: generator calls must be 0 in a jev-only run (§1.1)
runs = []
for d in sorted(glob.glob(os.path.join(out, f'{name}-runs', '*/'))):
    rid = os.path.basename(d.rstrip('/'))
    st = {}
    try: st = json.load(open(os.path.join(d, 'state.json')))
    except Exception: pass
    rj = {}
    try: rj = json.load(open(os.path.join(d, 'run.json')))
    except Exception: pass
    st = st.get('state', st)  # state.json is an envelope { checksum, state, version }
    spend = st.get('spend', {})
    lt = st.get('lastTestRun') or {}
    cfg = rj.get('config') if isinstance(rj.get('config'), dict) else {}
    prov_row = cfg.get('decider.provider') if isinstance(cfg, dict) else None
    runs.append({'id': rid, 'mode': rj.get('mode') or st.get('mode'), 'stopReason': st.get('stopReason'), 'step': st.get('step'), 'jevQuestions': st.get('jevQuestions'),
                 'generator': spend.get('generator'), 'jev': spend.get('jev'), 'resolvedJevModel': rj.get('resolvedJevModel'),
                 'lastTestRun': {k: lt.get(k) for k in ('passed', 'failed', 'errors', 'step') if k in lt} if lt else None,
                 'deciderProvider': prov_row.get('value') if isinstance(prov_row, dict) else prov_row})

# key bytes: every non-empty value of the repository .env and the fingerprints only
keys = []
try:
    for l in open(os.path.join(os.getcwd(), '.env')):
        m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$', l)
        if m and len(m.group(2).strip().strip('"\'')) >= 8: keys.append((m.group(1), m.group(2).strip().strip('"\'')))
except Exception: pass
leaks = {}
for path in [cap, tim, os.path.join(out, f'{name}.txt'), os.path.join(out, f'{name}.driver.out')] + glob.glob(os.path.join(out, f'{name}-runs', '**', '*'), recursive=True):
    if not os.path.isfile(path): continue
    b = open(path, 'rb').read()
    for kname, v in keys:
        if v.encode() in b: leaks[os.path.relpath(path, out)] = leaks.get(os.path.relpath(path, out), []) + [kname]

result = {'name': name, 'provider': prov, 'geometry': f'{rows}x{cols}', 'driver_exit': int(code), 'timeouts': timeouts, 'clears_after_first_frame': clears, 'restores': restores,
          'first_frame_ms': marks.get('first-frame'), 'composer_ready_ms': marks.get('composer-ready'), 'splash_settle_ms': wall('first-frame', 'splash-settled'), 'splash': splash,
          'wall_hi_ms': wall('hi-sent', 'hi-reply'), 'wall_facts_ms': wall('facts-sent', 'facts-reply'), 'wall_task_to_run_start_ms': wall('task-sent', 'run-started'),
          'run_ms': wall('run-started', 'run-ended'), 'total_ms': recs[-1]['t'] if recs else None,
          'replies': replies[:12], 'jev_lines': jev_lines, 'resolved_lines': resolved, 'mode_items': mode_items, 'wizard_seen': wizard,
          'run_start': run_start, 'run_end': run_end, 'step_lines': len(step_lines), 'stage_lines_visible': len(stage_visible), 'rows_wider_than_cols': len(wide),
          'auto_review': auto, 'runs': runs, 'key_leaks': leaks}
line = json.dumps(result, ensure_ascii=False)
open(os.path.join(out, 'results.jsonl'), 'a').write(line + '\n')
print(line)
