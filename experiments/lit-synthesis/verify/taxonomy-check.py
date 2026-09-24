"""Offline recount of the §5.4 fix-shape taxonomy over all QuixBugs Python programs (no Jev)."""
import os, re, tokenize, io, json, collections
ROOT='/tmp/quixbugs'
def code_only(src):
    i=src.find('\n"""'); src = src[:i] if i>0 else src
    return [l for l in src.rstrip().split('\n') if l.strip()!='' and not l.strip().startswith('#')]
def toks(line):
    try:
        return [t.string for t in tokenize.generate_tokens(io.StringIO(line.strip()+'\n').readline) if t.type not in (tokenize.NEWLINE, tokenize.NL, tokenize.ENDMARKER, tokenize.INDENT, tokenize.DEDENT, tokenize.COMMENT) and t.string!='']
    except Exception:
        return re.findall(r"\w+|\*\*=|//=|\*\*|//|<=|>=|==|!=|[-+*/%<>=()\[\]{},:.^&|~]", line)
OPS=set('+ - * / // % ** == != < <= > >= and or not in is & | ^ << >> ~'.split())
def shape(ts): return [('ID' if re.match(r'[A-Za-z_]\w*$',t) and t not in OPS and t not in ('return','if','elif','while','for','yield','in','def','else','not','and','or','is') else 'NUM' if re.match(r'\d',t) else 'STR' if t[0] in '\'"' else t) for t in ts]
cls=collections.Counter(); rows=[]; slot_counts=[]
progs=sorted(f[:-3] for f in os.listdir(f'{ROOT}/python_programs') if f.endswith('.py') and not f.endswith('_test.py'))
for p in progs:
    b=code_only(open(f'{ROOT}/python_programs/{p}.py').read()); f=code_only(open(f'{ROOT}/correct_python_programs/{p}.py').read())
    has_json=os.path.exists(f'{ROOT}/json_testcases/{p}.json')
    if len(b)!=len(f):
        c='inserted_line' if len(f)==len(b)+1 else 'multi_line'; cls[c]+=1; rows.append((p,c,has_json,'','')); continue
    d=[i for i in range(len(b)) if re.sub(r'#.*$','',b[i]).strip()!=re.sub(r'#.*$','',f[i]).strip()]
    if len(d)!=1: cls['multi_line']+=1; rows.append((p,'multi_line',has_json,'','')); continue
    i=d[0]; bt,ft=toks(b[i]),toks(f[i]); bs,fs=shape(bt),shape(ft)
    slots=sum(1 for s in fs if s in ('ID','NUM')) + sum(1 for t in ft if t in OPS)
    slot_counts.append(slots)
    if len(ft)>len(bt): c='fragment_inserted'
    elif len(ft)<len(bt): c='fragment_deleted'
    elif bs==fs:
        diff=[(x,y) for x,y in zip(bt,ft) if x!=y]
        c='operator_change' if all(x in OPS or y in OPS or x.endswith('=') for x,y in diff) else 'ident_num_substituted'
    else: c='reshaped'
    cls[c]+=1; rows.append((p,c,has_json,b[i].strip(),f[i].strip()))
for r in rows: print(r)
print(cls, 'total', sum(cls.values()))
import statistics
print('slots per fixed line (one-line replacements): n', len(slot_counts), 'mean %.2f'%statistics.mean(slot_counts), 'median', statistics.median(slot_counts), 'max', max(slot_counts), '<=6', sum(s<=6 for s in slot_counts), '<=10', sum(s<=10 for s in slot_counts))
print('one-line replacements with json tests:', sum(1 for r in rows if r[2] and r[1] not in ('inserted_line','multi_line')))
