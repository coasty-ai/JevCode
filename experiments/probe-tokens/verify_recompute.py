"""Adversarial re-computation of every number in results/probe-token-synthesis.md from out/*.json.
Usage: python3 verify_recompute.py   (run from experiments/probe-tokens)"""
import json, statistics as st, math
L = lambda f: json.load(open(f'out/{f}.json'))
tf, tp, b1, b3, b3g, eb = L('teacher-forced'), L('templates'), L('beam-w1'), L('beam-w3'), L('beam-w3-grammar'), L('edit-beam-w3')
corpus = json.load(open('out/corpus.json'))
print('corpus', len(corpus), {k: sum(1 for c in corpus if c['kind']==k) for k in ('replace','insert')}, 'inserts:', [c['name'] for c in corpus if c['kind']=='insert'])
rows = tf['rows']
print('TF n positions', len(rows), 'lines', len({r['name'] for r in rows}))
acc = lambda rs,k: sum(1 for r in rs if 1<=r['rank']<=k)
mrr = lambda rs: sum(1/r['rank'] for r in rs if r['rank'])/len(rs)
print('TF top1', acc(rows,1), 'top3', acc(rows,3), 'MRR %.3f'%mrr(rows))
for cls in ['identifier','punct','keyword','operator','number','literal','end']:
    rs=[r for r in rows if r['cls']==cls]; print(f'  {cls:11s} n={len(rs):3d} top1={acc(rs,1)} top3={acc(rs,3)} mrr={mrr(rs):.2f} p_truth={st.mean(r["p_truth"] for r in rs):.2f} p_top={st.mean(r["p_top"] for r in rs):.2f}')
# calibration
bands={}
for r in rows: b=min(9,int(r['p_top']*10))/10; bands.setdefault(b,[]).append(r['rank']==1)
for b in sorted(bands): print(f'  band {b:.1f}: n={len(bands[b])} acc={100*sum(bands[b])/len(bands[b]):.0f}%')
hi=[r for r in rows if r['p_top']>=0.9]; print('p_top>=0.9 n', len(hi), 'acc', sum(r['rank']==1 for r in hi))
# per-line ceilings
names=[c['name'] for c in corpus]
all1=sum(1 for n in names if all(r['rank']==1 for r in rows if r['name']==n)); all3=sum(1 for n in names if all(1<=r['rank']<=3 for r in rows if r['name']==n))
print('lines all top1', all1, 'all top3', all3, 'first token top1', acc([r for r in rows if r['pos']==0],1),'/',len([r for r in rows if r['pos']==0]))
# miss analysis: skip-ahead = top1 key corresponds to a token later in the correct line
import re
misses=[r for r in rows if r['rank']!=1]; print('misses', len(misses))
skip=0; same_pos_buggy=0; buggy_else=0; none=0; other=0; other_list=[]
tokrows={}
for r in rows: tokrows.setdefault(r['name'],{})[r['pos']]=r
for r in misses:
    line=tokrows[r['name']]; later_keys={line[p]['truthKey'] for p in line if p>r['pos']}
    if r['top1'] in later_keys: skip+=1
    elif r['top1']=='none_of_these': none+=1
    else: other+=1; other_list.append((r['name'],r['pos'],r['target'],r['top1']))
print('skip-ahead', skip, 'none_of_these', none, 'other', other); print(other_list)
# cost, latency
def p50(xs): xs=sorted(xs); return xs[len(xs)//2]
tot=0; calls=0
for k,d in [('tf',tf),('tp',tp),('b1',b1),('b3',b3),('b3g',b3g),('eb',eb)]:
    u=d['usage']; tot+=u['cost']; calls+=u['calls']
    print(f'{k}: calls={u["calls"]} cost={u["cost"]:.4f} sum(row.cost)={sum(r["cost"] for r in d["rows"]):.4f} p50lat={p50(u["lat"]):.0f} inTok/req={u["inTok"]/u["calls"]:.0f}')
print('TOTAL cost %.4f calls %d'%(tot,calls))
# beam
for k,d in [('b1',b1),('b3',b3),('b3g',b3g)]:
    rs=d['rows']; print(k, 'top_exact', sum(r['top_exact'] for r in rs), 'top_pass', sum(r['top_pass'] for r in rs), 'any_exact', sum(r['any_exact'] for r in rs), 'any_pass', sum(r['any_pass'] for r in rs), 'mean_rank_top_exact', sum(r['mean_rank_top_exact'] for r in rs), 'truncated lines', sum(1 for r in rs if r['truncated']>0), 'req/line %.1f'%(d['usage']['calls']/len(rs)), 'wall p50 %.1fs'%(p50([r['wall_ms'] for r in rs])/1000), 'n_verified<=3', all(len(r['verified'])<=3 for r in rs))
print('W3 unfiltered top lines for long targets:', [(r['name'], r['top_line']) for r in b3['rows'] if r['n_target']>=14])
# templates
rs=tp['rows']; cov=[r for r in rs if r['covered']]; unc=[r for r in rs if not r['covered']]
print('tpl covered', len(cov), {s: sum(1 for r in cov if r['covered_by']==s or (s=='line' and r['covered_by'].startswith('line_'))) for s in ['buggy_line','mutant_of_buggy_line','line']})
print('tpl top1', sum(r['template_rank']==1 for r in cov), 'top3', sum(1<=r['template_rank']<=3 for r in cov), 'mean p_truth %.2f'%st.mean(r['p_truth'] for r in cov))
print('uncovered none_of_these', sum(r['top_template']=='none_of_these' for r in unc), '/', len(unc), '; buggy-line template picked:', sum(1 for r in unc if r['top_template']!='none_of_these' and r['top_template']==next((json.dumps(None) for _ in []), None)))
# does top_template equal the buggy line's template? need to recompute template of buggy line: approximate by checking source in pool -- not stored; check top_template text vs a masked buggy line
def mask(line):
    # crude: replace identifiers/numbers/strings/True False None with _ using the same tokenizer semantics approximated
    kw=set('and or not in is if else elif for while return yield lambda def break continue pass import from as del assert with class try except raise global'.split())
    toks=re.findall(r'"[^"]*"|\'[^\']*\'|\d+\.\d*|\.\d+|\d+|[A-Za-z_]\w*|\*\*=|//=|>>=|<<=|->|\*\*|//|==|!=|<=|>=|\+=|-=|\*=|/=|%=|&=|\|=|\^=|<<|>>|[-+*/%<>=&|^~@()\[\]{},:.;]', re.sub(r'#.*$','',line))
    return [ '_' if (re.match(r'[A-Za-z_]',t) and t not in kw) or re.match(r'[\d"\']',t) or t[0]=='.' and len(t)>1 else t for t in toks]
nb=0
for r in unc:
    c=next(c for c in corpus if c['name']==r['name'])
    if c['buggy_line'] and r['top_template']!='none_of_these':
        if re.findall(r'\w+|[^\w\s]', r['top_template'])==[x for x in mask(c['buggy_line'])]: nb+=1
print('uncovered: top template == buggy-line template (recomputed):', nb, '/', len(unc), '; uncovered inserts:', [r['name'] for r in unc if next(c for c in corpus if c['name']==r['name'])['buggy_line'] is None])
print('uncovered top templates:', [(r['name'], r['top_template']) for r in unc])
print('slot seq', sum(r['tf_seq_exact'] for r in rs), 'par', sum(r['tf_par_exact'] for r in rs), 'e2e exact', sum(r['e2e_exact'] for r in rs), 'pass', sum(r['e2e_pass'] for r in rs), 'pool mean %.1f max %d'%(st.mean(r['pool_size'] for r in rs), max(r['pool_size'] for r in rs)), 'slots mean %.1f max %d'%(st.mean(r['n_slots'] for r in rs), max(r['n_slots'] for r in rs)))
print('slot seq failures', [(r['name'], r['tf_seq_line']) for r in rs if not r['tf_seq_exact']])
print('slot par failures', [r['name'] for r in rs if not r['tf_par_exact']])
print('e2e pass but not exact', [r['name'] for r in rs if r['e2e_pass'] and not r['e2e_exact']])
# edit beam
rs=eb['rows']; print('edit n', len(rs), 'stop_top_exact', sum(r['stop_top_exact'] for r in rs), 'stop_top_pass', sum(r['stop_top_pass'] for r in rs), 'stop_any_pass', sum(r['stop_any_pass'] for r in rs), 'any_state_exact', sum(r['any_state_exact'] for r in rs), 'any_state_pass', sum(r['any_state_pass'] for r in rs), 'mean states %.1f'%st.mean(r['states_visited'] for r in rs))
print('edit any_state_pass names', sorted(r['name'] for r in rs if r['any_state_pass']))
# union
union=[]; only={}
for c in corpus:
    n=c['name']; r1=next(r for r in b1['rows'] if r['name']==n); r3=next(r for r in b3['rows'] if r['name']==n); r3g=next(r for r in b3g['rows'] if r['name']==n); t=next(r for r in tp['rows'] if r['name']==n); e=next((r for r in eb['rows'] if r['name']==n), None)
    routes={'W1':r1['any_pass'],'W3':r3['any_pass'],'W3g':r3g['any_pass'],'tpl':t['e2e_pass'],'edit':bool(e and e['any_state_pass'])}
    if any(routes.values()): union.append(n)
    tok_any = routes['W1'] or routes['W3'] or routes['W3g']
    if routes['tpl'] and not tok_any: only.setdefault('tpl_not_token',[]).append(n)
    if routes['edit'] and not tok_any and not routes['tpl']: only.setdefault('edit_only',[]).append(n)
    if not any(routes.values()): only.setdefault('unsolved',[]).append(n)
print('UNION', len(union)); print(only)
print('token-route union (W1|W3|W3g)', sum(1 for c in corpus if any(next(r for r in d['rows'] if r['name']==c['name'])['any_pass'] for d in (b1,b3,b3g))))
print('W3g+tpl+edit union', sum(1 for c in corpus if next(r for r in b3g['rows'] if r['name']==c['name'])['any_pass'] or next(r for r in tp['rows'] if r['name']==c['name'])['e2e_pass'] or any(r['any_state_pass'] for r in eb['rows'] if r['name']==c['name'])))
# argument-order programs: which routes solved them
for n in ['gcd','rpn_eval','next_permutation','shortest_path_lengths']:
    r1=next(r for r in b1['rows'] if r['name']==n); r3=next(r for r in b3['rows'] if r['name']==n); r3g=next(r for r in b3g['rows'] if r['name']==n); t=next(r for r in tp['rows'] if r['name']==n); e=next((r for r in eb['rows'] if r['name']==n), None)
    print(n, 'W1',r1['any_pass'],'W3',r3['any_pass'],'W3g',r3g['any_pass'],'tpl e2e',t['e2e_pass'],'slot seq',t['tf_seq_exact'],'slot par',t['tf_par_exact'],'edit',e and e['any_state_pass'])
# options per program
print('options per request (TF) min/max/mean', min(r['options'] for r in rows), max(r['options'] for r in rows), round(st.mean(r['options'] for r in rows)))
