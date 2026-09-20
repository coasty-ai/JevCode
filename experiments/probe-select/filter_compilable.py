"""stdin: {"lines": [...program lines...], "index": i, "candidates": [...], "mode": "replace"|"insert"}
stdout: JSON list of booleans: does the program compile with candidate substituted (or inserted after line i)?"""
import json, sys, warnings
warnings.simplefilter('ignore')
d = json.load(sys.stdin)
lines, i, mode = d['lines'], d['index'], d.get('mode', 'replace')
out = []
for c in d['candidates']:
    if mode == 'insert':
        new = lines[:i + 1] + c.split('\n') + lines[i + 1:]
    else:
        new = lines[:i] + c.split('\n') + lines[i + 1:]
    try:
        compile('\n'.join(new) + '\n', '<cand>', 'exec')
        out.append(True)
    except Exception:
        out.append(False)
print(json.dumps(out))
