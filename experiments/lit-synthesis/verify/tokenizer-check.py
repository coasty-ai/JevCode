"""Compares /tmp/jevonly-ts-tokens.json (hand-written tokenizer) with CPython tokenize on the same lines."""
import json, tokenize, io, re
ROOT='/tmp/quixbugs'
ts=json.load(open('/tmp/jevonly-ts-tokens.json'))
def code_only(src):
    i=src.find('\n"""'); src=src[:i] if i>0 else src
    return [l for l in src.rstrip().split('\n') if l.strip()!='' and not l.strip().startswith('#')]
total=agree=disagree=py_fail=0; ex=[]
for f,tl in ts.items():
    lines=code_only(open(f'{ROOT}/python_programs/{f}').read()); assert len(lines)==len(tl),(f,len(lines),len(tl))
    for line,t in zip(lines,tl):
        total+=1
        try:
            py=[x.string for x in tokenize.generate_tokens(io.StringIO(re.sub(r'#.*$','',line).strip()+'\n').readline) if x.type not in (tokenize.NEWLINE,tokenize.NL,tokenize.ENDMARKER,tokenize.INDENT,tokenize.DEDENT,tokenize.COMMENT) and x.string!='']
        except Exception as e: py_fail+=1; continue
        if py==t: agree+=1
        else: disagree+=1; ex.append((f,line.strip(),py,t))
print(dict(total=total, cpython_tokenizable=total-py_fail, agree=agree, disagree=disagree, cpython_fail=py_fail))
for e in ex[:10]: print(e)
