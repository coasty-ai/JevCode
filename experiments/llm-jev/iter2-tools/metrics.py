#!/usr/bin/env python3
"""iter2 measurement probe: iter1's metrics.py plus warm/deadline/escalation/timeline fields."""
import json, gzip, os, sys, collections, re

def rd(d, name):
    p = os.path.join(d, name)
    if os.path.exists(p+'.gz'): return gzip.open(p+'.gz','rt',errors='replace').read()
    if os.path.exists(p): return open(p,errors='replace').read()
    return ''

def lines(txt):
    for l in txt.splitlines():
        l=l.strip()
        if not l: continue
        try: yield json.loads(l)
        except Exception: pass

FIRE_DL = re.compile(r'deadline (\d+) ms')
GOAL_RE = re.compile(r'goal (\S+) round (\d+)')
WARM_RE = re.compile(r'; warm (\d+)/(\d+)([^·\n]*)')

def analyse(resdir):
    recs=[json.loads(l) for l in open(os.path.join(resdir,'tasks.jsonl')) if l.strip()]
    out=[]
    for r in recs:
        rid=r.get('runId') or ''
        rundir=os.path.join(resdir,'runs',rid)
        la=r.get('loadavg') or [None]
        tim=r.get('timing') or {}
        m={'dir':os.path.basename(resdir),'suite':r['suite'],'task':r['task'],'cond':r['condition'],'pass':r.get('pass'),
           'wall':(r.get('wallMs') or 0)/1000.0,'steps':r.get('steps'),'stop':r.get('stopReason'),
           'usd':sum((r.get('cost') or {}).values()),'gen_usd':(r.get('cost') or {}).get('generator',0),
           'jev_usd':(r.get('cost') or {}).get('jev',0),'jevReq':r.get('jevRequests',0),
           'jevQ':r.get('jevQuestions',0),'patchEmpty':r.get('patchEmpty'),
           'evaluator':r.get('evaluator'),'evalExit':r.get('evalExitCode'),'capFired':r.get('capFired'),'runId':rid,
           'load1':la[0],
           't_gen':tim.get('generatorMs',0),'t_jev':tim.get('jevMs',0),'t_exec':tim.get('execMs',0),'t_harness':tim.get('harnessMs',0)}
        g=r.get('generator') or {}
        m.update({'gcalls':g.get('calls',0),'gsamples':g.get('samples',0),'gvalid':g.get('valid',0),
                  'gtimeouts':g.get('timeouts',0),'gcancelled':g.get('cancelled',0)})
        sy=(r.get('synth') or {})
        v=sy.get('verify') or {}
        m.update({'synthMs':sy.get('synthMs',0),'synthSteps':sy.get('synthSteps',0),
                  'tested_sum':v.get('candidatesTested',0),'passers':v.get('passers',0),'partials':v.get('partials',0)})
        # --- state.json: timing buckets incl totalMs / jevWallMs
        st={}
        try: st=json.loads(rd(rundir,'state.json')).get('state',{})
        except Exception: pass
        stim=st.get('timing') or {}
        m.update({'s_total':stim.get('totalMs',0),'s_synth':stim.get('synthMs',0),'s_gen':stim.get('generatorMs',0),
                  's_jev':stim.get('jevMs',0),'s_exec':stim.get('execMs',0),'s_harness':stim.get('harnessMs',0),
                  'jevWallMs':stim.get('jevWallMs',0),'s_images':stim.get('imagesMs',0)})
        # --- archived step records
        ranked=tested=cacheHits=cachedRows=0
        plausible_steps=0; nopatch=0; goals=set(); splits=set(); arb=0; clusters_max=0
        fam=collections.Counter(); famq=collections.Counter(); famusd=collections.Counter(); famcached=collections.Counter()
        nextmove=collections.Counter(); complete_asked=0
        gt_timeout=0; gt_zero=0; gsec=0.0; gsec_timeout=0.0
        ranked_by_suitephase=collections.Counter()
        for s in lines(rd(rundir,'steps.jsonl')):
            p=s.get('proposal') or {}
            raw=p.get('rawText') or ''
            tr=None
            try:
                o=json.loads(raw); tr=o if o.get('kind')=='search' else o.get('trace')
            except Exception: pass
            if isinstance(tr,dict):
                ranked+=tr.get('candidatesRanked',0); tested+=tr.get('candidatesTested',0)
                ranked_by_suitephase[tr.get('phase')]+=tr.get('candidatesRanked',0)
                if tr.get('plausible',0)==0: plausible_steps+=1
                if tr.get('arbitrated'): arb+=1
                clusters_max=max(clusters_max,tr.get('clusters',0) or 0)
                gid=tr.get('goalId')
                if gid:
                    goals.add(gid)
                    if '.' in str(gid): splits.add(gid)
            k=(p.get('action') or {}).get('kind')
            if k is not None and k!='patch': nopatch+=1
            cacheHits+=s.get('jevCacheHits',0) or 0
            for jr in (s.get('jevRequests') or []):
                if jr.get('cached'): cachedRows+=1
        byhash={}
        for j in lines(rd(rundir,'jev.jsonl')):
            byhash.setdefault(j.get('requestHash'),[]).append(j)
        hashfam={}
        for d in lines(rd(rundir,'decisions.jsonl')):
            h=d.get('requestHash'); i=str(d.get('id') or '')
            base=('candidate_*' if i.startswith('candidate_') else
                  'general_cand_*' if i.startswith('general_cand') else
                  'slot_*' if i.startswith('slot_') else i)
            key=f"{d.get('stage')}|{base}"
            hashfam.setdefault(h,key)
            if d.get('stage')=='replan' and i=='next_move':
                a=d.get('answer') or {}
                nextmove[a.get('choice') or a.get('value') or '?']+=1
            if i=='task_complete': complete_asked+=1
        for h,js in byhash.items():
            key=hashfam.get(h,'unknown')
            for j in js:
                fam[key]+=1; famq[key]+=j.get('questions',0)
                famusd[key]+=((j.get('usage') or {}).get('costUsd') or 0)
                if j.get('cached'): famcached[key]+=1
        for gg in lines(rd(rundir,'generator.jsonl')):
            ms=gg.get('latencyMs') or gg.get('ms') or gg.get('durationMs') or 0
            gsec+=ms/1000.0
            if gg.get('stopReason')=='timeout':
                gt_timeout+=1; gsec_timeout+=ms/1000.0
                if (gg.get('outputTokens') or 0)==0: gt_zero+=1
        m.update({'ranked':ranked,'tested':tested,'cacheHits':cacheHits,'cachedRows':cachedRows,
                  'plausible0_steps':plausible_steps,'nopatch':nopatch,'goals':len(goals),
                  'splitGoals':len(splits),'arbitrated':arb,'clustersMax':clusters_max,
                  'fam':dict(fam),'famq':dict(famq),'famusd':dict(famusd),'famcached':dict(famcached),
                  'nextmove':dict(nextmove),'completeAsked':complete_asked,
                  'rankedByPhase':dict(ranked_by_suitephase),
                  'gt_timeout':gt_timeout,'gt_zero':gt_zero,'gsec':gsec,'gsec_timeout':gsec_timeout})
        # --- transcript (harvested): warm, deadlines, escalation
        tpath=os.path.join(resdir,'transcripts',rid+'.log')
        warm={'offered':0,'screened':0,'fallbacks':0,'restarts':0,'mismatches':0,'coldconfirms':0,
              'disabled':[], 'notes':0, 'scopeUnusable':0, 'invalidations':0}
        dl_events=0; dl_shrink=[]; esc=collections.Counter(); zero_lanes=0
        per_goal_hw={}
        if os.path.exists(tpath):
            txt=open(tpath,errors='replace').read()
            for mo in WARM_RE.finditer(txt):
                warm['notes']+=1
                warm['screened']+=int(mo.group(1)); warm['offered']+=int(mo.group(2))
                rest=mo.group(3)
                for pat,key in (( r'(\d+) fallback',  'fallbacks'),(r'(\d+) restart','restarts'),
                                ( r'(\d+) screen:mismatch','mismatches'),(r'(\d+) cold confirm','coldconfirms'),
                                ( r'(\d+) scope_unusable','scopeUnusable'),(r'(\d+) invalidation','invalidations')):
                    mm=re.search(pat,rest)
                    if mm: warm[key]+=int(mm.group(1))
                dm=re.search(r'warm off: ([^,;·\n]+)',rest)
                if dm: warm['disabled'].append(dm.group(1).strip())
            for ln in txt.splitlines():
                if 'llm:deadline' in ln: dl_events+=1
                if 'llm:fire' in ln:
                    gm=GOAL_RE.search(ln); dm=FIRE_DL.search(ln)
                    if gm and dm:
                        gid=gm.group(1); d=int(dm.group(1))
                        prev=per_goal_hw.get(gid)
                        # only count a shrink when a zero-token timeout had already raised this goal's mark
                        if prev is not None and d<prev['hw'] and prev['hadZeroTimeout']:
                            dl_shrink.append((gid,prev['hw'],d))
                        if prev is None: per_goal_hw[gid]={'hw':d,'hadZeroTimeout':False}
                        else: prev['hw']=max(prev['hw'],d)
                if 'this round timed out with 0 output tokens' in ln:
                    gm=re.search(r'goal (\S+?):',ln)
                    if gm and gm.group(1) in per_goal_hw: per_goal_hw[gm.group(1)]['hadZeroTimeout']=True
                if 'escalat' in ln.lower(): esc[ln.strip()[:160]]+=1
                if 'nothing ran' in ln: zero_lanes+=1
        m['warm']=warm; m['dlEvents']=dl_events; m['dlShrinks']=dl_shrink
        m['escalations']=sum(esc.values()); m['escSamples']=list(esc.keys())[:3]; m['zeroLaneBatches']=zero_lanes
        m['hasTranscript']=os.path.exists(tpath)
        out.append(m)
    return out

if __name__=='__main__':
    allm=[]
    for d in sys.argv[1:]: allm+=analyse(d)
    print(json.dumps(allm))
