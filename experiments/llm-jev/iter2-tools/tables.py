#!/usr/bin/env python3
"""Format iter2 metrics JSON into the report tables (iter1 tables.py + warm/deadline/timeline)."""
import json,sys,collections,statistics,math

def wilson(k,n):
    if n==0: return (0.0,0.0)
    z=1.959963985; p=k/n; d=1+z*z/n
    c=(p+z*z/(2*n))/d
    h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return (max(0,c-h),min(1,c+h))

def signp(b,c):
    n=b+c
    if n==0: return 1.0
    return sum(math.comb(n,i) for i in range(b,n+1))/2**n

def med(xs): return statistics.median(xs) if xs else float('nan')
def load(p): return json.load(open(p))
def key(m): return (m['suite'],m['task'])

HDR=['suite','task','pass','stop','wall s','load1','$ tot','$ jev','jevReq','cacheHits','ranked','tested','goals','split','pl0 steps','noPatch','gen to','gen 0tok','gen s','steps']
def row(m):
    return '| '+' | '.join(str(x) for x in [m['suite'],m['task'],m['pass'],m['stop'],f"{m['wall']:.1f}",
        f"{(m['load1'] or 0):.1f}",f"{m['usd']:.6f}",f"{m['jev_usd']:.6f}",m['jevReq'],m['cacheHits'],m['ranked'],
        m['tested'],m['goals'],m['splitGoals'],m['plausible0_steps'],m['nopatch'],m['gt_timeout'],m['gt_zero'],
        f"{m['gsec']:.0f}",m['steps']])+' |'

def table(title,ms):
    print(f'## {title}\n')
    print('| '+' | '.join(HDR)+' |'); print('|'+'---|'*len(HDR))
    for m in ms: print(row(m))
    print()

def summarise(tag,cand):
    print(f"\n### summary — {tag}")
    n=len(cand); k=sum(1 for m in cand if m['pass'])
    lo,hi=wilson(k,n)
    print(f"pass {k}/{n} Wilson [{lo*100:.1f}%, {hi*100:.1f}%]")
    print(f"$ total {sum(m['usd'] for m in cand):.6f} (gen {sum(m['gen_usd'] for m in cand):.6f}, jev {sum(m['jev_usd'] for m in cand):.6f})")
    print(f"median wall {med([m['wall'] for m in cand]):.1f}s; loadavg1 min {min((m['load1'] or 0) for m in cand):.1f} median {med([(m['load1'] or 0) for m in cand]):.1f} max {max((m['load1'] or 0) for m in cand):.1f}")
    print(f"Jev requests {sum(m['jevReq'] for m in cand)} / questions {sum(m['jevQ'] for m in cand)}; cacheHits {sum(m['cacheHits'] for m in cand)} (cached rows {sum(m['cachedRows'] for m in cand)})")
    print(f"ranked {sum(m['ranked'] for m in cand)} / tested {sum(m['tested'] for m in cand)}")
    gs=sum(m['gsamples'] for m in cand); gz=sum(m['gt_zero'] for m in cand); gt=sum(m['gt_timeout'] for m in cand)
    sec=sum(m['gsec'] for m in cand); tsec=sum(m['gsec_timeout'] for m in cand)
    print(f"generator: calls {sum(m['gcalls'] for m in cand)} samples {gs} valid {sum(m['gvalid'] for m in cand)} timeouts {gt} zero-token-timeouts {gz}"
          + (f" = {gz/gs*100:.1f}% of samples" if gs else "")
          + f"; sample-s {sec:.0f} of which timeout-s {tsec:.0f}" + (f" = {tsec/sec*100:.1f}%" if sec else ""))
    print(f"stop reasons: {dict(collections.Counter(m['stop'] for m in cand))}")
    print(f"goals total {sum(m['goals'] for m in cand)}; split goals {sum(m['splitGoals'] for m in cand)}; plausible0 steps {sum(m['plausible0_steps'] for m in cand)}")
    w=collections.Counter()
    for m in cand:
        for kk,v in m['warm'].items():
            if kk=='disabled': w['disabledEvents']+=len(v)
            else: w[kk]+=v
    print(f"warm: {dict(w)}; disabledReasons {[r for m in cand for r in m['warm']['disabled']]}")
    print(f"llm:deadline (zero-token backoff) events {sum(m['dlEvents'] for m in cand)}; deadline shrinks after a zero-token timeout {sum(len(m['dlShrinks']) for m in cand)} {[s for m in cand for s in m['dlShrinks']][:6]}")
    print(f"'nothing ran' batches {sum(m['zeroLaneBatches'] for m in cand)}; transcripts present {sum(1 for m in cand if m['hasTranscript'])}/{n}")
    tt=collections.Counter()
    for m in cand:
        for kk in ('s_total','s_synth','s_gen','s_jev','s_exec','s_harness','s_images'): tt[kk]+=m[kk]
    tot=tt['s_total'] or 1
    print("timeline buckets (Σ ms, share of Σ totalMs): "+", ".join(f"{kk[2:]} {tt[kk]/1000:.1f}s ({tt[kk]/tot*100:.1f}%)" for kk in ('s_total','s_synth','s_gen','s_jev','s_exec','s_harness','s_images')))
    nm=collections.Counter()
    for m in cand:
        for kk,v in m['nextmove'].items(): nm[kk]+=v
    print(f"replan next_move: {dict(nm)}; task_complete asked {sum(m['completeAsked'] for m in cand)}")
    # replan_stop step numbers
    rs=[(m['task'],m['steps'],round(m['wall'],1)) for m in cand if m['stop']=='replan_stop']
    if rs: print(f"replan_stop records (task, steps, wall s): {rs}")

def paired(C,B,label='candidate vs baseline'):
    common=[k for k in C if k in B]
    b=sum(1 for k in common if C[k]['pass'] and not B[k]['pass'])
    c=sum(1 for k in common if B[k]['pass'] and not C[k]['pass'])
    both=sum(1 for k in common if C[k]['pass'] and B[k]['pass'])
    neither=sum(1 for k in common if not C[k]['pass'] and not B[k]['pass'])
    print(f"\n## paired {label} (n={len(common)}): b={b} c={c} both={both} neither={neither} sign p={signp(b,c):.4f}")
    kc=sum(1 for k in common if C[k]['pass']); kb=sum(1 for k in common if B[k]['pass'])
    lo,hi=wilson(kc,len(common)); lo2,hi2=wilson(kb,len(common))
    print(f"cand pass {kc}/{len(common)} Wilson [{lo*100:.1f}%, {hi*100:.1f}%]")
    print(f"base pass {kb}/{len(common)} Wilson [{lo2*100:.1f}%, {hi2*100:.1f}%]")
    print(f"median wall all: cand {med([C[k]['wall'] for k in common]):.1f}s base {med([B[k]['wall'] for k in common]):.1f}s")
    bs=[k for k in common if C[k]['pass'] and B[k]['pass']]
    if bs:
        ratios=sorted(C[k]['wall']/B[k]['wall'] for k in bs)
        mc=med([C[k]['wall'] for k in bs]); mb=med([B[k]['wall'] for k in bs])
        print(f"median wall both-solved (n={len(bs)}): cand {mc:.1f}s base {mb:.1f}s ratio {mc/mb:.3f}")
        print(f"per-task ratio: min {ratios[0]:.3f} median {med(ratios):.3f} max {ratios[-1]:.3f}; cand slower on {sum(1 for r in ratios if r>1)}/{len(ratios)}")
        print(f"loadavg1 on both-solved: cand median {med([C[k]['load1'] or 0 for k in bs]):.1f} base median {med([B[k]['load1'] or 0 for k in bs]):.1f}")
        print("per-task: "+", ".join(f"{k[1]} {C[k]['wall']:.1f}s(L{C[k]['load1']:.0f})/{B[k]['wall']:.1f}s(L{B[k]['load1']:.0f})={C[k]['wall']/B[k]['wall']:.2f}x" for k in bs))
    print(f"$ total: cand {sum(C[k]['usd'] for k in common):.6f} base {sum(B[k]['usd'] for k in common):.6f}")
    print(f"Jev requests: cand {sum(C[k]['jevReq'] for k in common)} base {sum(B[k]['jevReq'] for k in common)}")
    print(f"discordant: cand-wins {[k[1] for k in common if C[k]['pass'] and not B[k]['pass']]} base-wins {[k[1] for k in common if B[k]['pass'] and not C[k]['pass']]}")

def families(cand):
    fam=collections.Counter(); famq=collections.Counter(); famusd=collections.Counter(); famc=collections.Counter()
    for m in cand:
        for k,v in m['fam'].items(): fam[k]+=v
        for k,v in m['famq'].items(): famq[k]+=v
        for k,v in m['famusd'].items(): famusd[k]+=v
        for k,v in m['famcached'].items(): famc[k]+=v
    print('\n## Jev by question family (pooled)\n')
    print('| family | requests | questions | $ | cached |'); print('|---|---|---|---|---|')
    for k,v in fam.most_common(25): print(f"| `{k}` | {v} | {famq[k]} | {famusd[k]:.6f} | {famc[k]} |")

if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='one':
        cand=load(sys.argv[2]); tag=sys.argv[3] if len(sys.argv)>3 else 'arm'
        table(f'per-task — {tag}',cand); summarise(tag,cand); families(cand)
    elif mode=='pair':
        cand=load(sys.argv[2]); base=load(sys.argv[3])
        tagc=sys.argv[4] if len(sys.argv)>4 else 'candidate'; tagb=sys.argv[5] if len(sys.argv)>5 else 'baseline'
        table(f'per-task — {tagc}',cand); table(f'per-task — {tagb}',base)
        paired({key(m):m for m in cand},{key(m):m for m in base},f'{tagc} vs {tagb}')
        summarise(tagc,cand); summarise(tagb,base)
