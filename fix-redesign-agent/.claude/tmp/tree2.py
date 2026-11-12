import json,re,statistics
raw=json.load(open('.claude/tmp/tree.raw.json'))
def col(c):
    if c is None: return None
    m=re.match(r'rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)',c)
    if not m: return c
    r,g,b=[int(float(m.group(i))) for i in (1,2,3)]; a=float(m.group(4)) if m.group(4) else 1
    h='%02x%02x%02x'%(r,g,b); return h if a>=0.995 else h+'%02x'%round(a*255)
def cs(s): return re.sub(r'rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)',lambda m:'#'+col(m.group(0)),s) if s else None
FF={'DM Sans':'s','Noto Serif':'n','DM Mono':'m'}
def infer(f,kids):
    """kids have ax,ay,w,h absolute. returns (layout dict, kids order) or None"""
    n=len(kids)
    if n==0: return None
    fx,fy,fw,fh=f['ax'],f['ay'],f['w'],f['h']
    def try_dir(d):
        ks=sorted(kids,key=lambda k:(k['ay'],k['ax']) if d=='V' else (k['ax'],k['ay']))
        mains=[]; 
        for i,k in enumerate(ks):
            if i:
                p=ks[i-1]
                gap=(k['ay']-(p['ay']+p['h'])) if d=='V' else (k['ax']-(p['ax']+p['w']))
                if gap<-1.5: return None
                mains.append(gap)
        if mains and max(mains)-min(mains)>2.5: return None
        gap=round(sum(mains)/len(mains)) if mains else 0
        # cross alignment
        if d=='V':
            lo=[k['ax']-fx for k in ks]; ce=[k['ax']+k['w']/2-(fx+fw/2) for k in ks]; hi=[(fx+fw)-(k['ax']+k['w']) for k in ks]
        else:
            lo=[k['ay']-fy for k in ks]; ce=[k['ay']+k['h']/2-(fy+fh/2) for k in ks]; hi=[(fy+fh)-(k['ay']+k['h']) for k in ks]
        spread=lambda a:max(a)-min(a)
        if spread(lo)<=1.6: ca='MIN'; c0=round(lo[0])
        elif spread(ce)<=2.2: ca='CENTER'; c0=0
        elif spread(hi)<=1.6: ca='MAX'; c0=round(hi[0])
        else: return None
        first,last=ks[0],ks[-1]
        if d=='V': p1=first['ay']-fy; p2=(fy+fh)-(last['ay']+last['h']); 
        else: p1=first['ax']-fx; p2=(fx+fw)-(last['ax']+last['w'])
        if p1<-1.5 or p2<-1.5: return None
        L={'d':d,'g':gap,'pa':'MIN','ca':ca}
        if d=='V': L.update(pt=max(0,round(p1)),pb=max(0,round(p2)),pl=max(0,c0) if ca=='MIN' else 0,pr=max(0,c0) if ca=='MAX' else 0)
        else: L.update(pl=max(0,round(p1)),pr=max(0,round(p2)),pt=max(0,c0) if ca=='MIN' else 0,pb=max(0,c0) if ca=='MAX' else 0)
        return L,ks
    if n==1:
        return try_dir('V')
    r1=try_dir('V'); r2=try_dir('H')
    if r1 and r2: return r1 if len(set(round(k['ax']) for k in kids))==1 else r2
    return r1 or r2
def enc(n,parent=None):
    k=n['k']
    if k=='t':
        o={'k':'t','x':round(n['ax']-parent['ax']),'y':round(n['ay']-parent['ay']),'w':round(n['w']),'h':round(n['h']),'s':n['s'],'f':FF.get(n['ff'],'s'),'z':round(n['z'],1),'wt':n['fw'],'c':col(n['c'])}
        if n.get('op') is not None and n['op']<0.99: o['op']=n['op']
        if n.get('lc'): o['lc']=n['lc']
        if n['ls']: o['l']=round(n['ls'],2)
        if n['lh']: o['L']=round(n['lh'],1)
        if n['ta'] not in ('start','left'): o['a']=n['ta'][0]
        if n['tt']=='uppercase': o['u']=1
        if 'underline' in (n['td'] or ''): o['d']=1
        return o
    if k=='i':
        o={'k':'i','x':round(n['ax']-parent['ax']),'y':round(n['ay']-parent['ay']),'w':round(n['w']),'h':round(n['h'])}
        if n.get('r'): o['r']=n['r']
        if n.get('src'): o['src']=n['src']
        if n.get('fit') and n['fit']!='fill': o['fit']=n['fit']
        if n.get('op') is not None and n['op']<0.99: o['op']=n['op']
        if n.get('mb'): o['mb']=n['mb']
        if n.get('gs'): o['gs']=n['gs']
        if n.get('pos') and n['pos']!='50% 50%': o['pos']=n['pos']
        if n.get('ib') or n.get('ibw'):
            inset=(n.get('ibw') or 0)+(n.get('ipad') or 0)
            tile={'k':'f','n':'Image tile','x':o['x'],'y':o['y'],'w':o['w'],'h':o['h']}
            if n.get('ib'): tile['b']=col(n['ib'])
            if n.get('ibw'): tile['bw']=n['ibw']; tile['bc']=col(n['ibc'])
            if n.get('r'): tile['r']=n['r']
            if n.get('ibb'): tile['bb']=float(n['ibb'])
            if n.get('ish'):
                sh=cs(n['ish']); sh=re.sub(r'#00000000 0px 0px 0px 0px,?\s*','',sh).strip(', ')
                if sh: tile['sh']=sh
            o['x']=inset; o['y']=inset; o['w']=max(1,o['w']-2*inset); o['h']=max(1,o['h']-2*inset); o['r']=9999 if (n.get('r') or 0)>=999 else max(0,(n.get('r') or 0)-inset)
            if not o['r']: o.pop('r')
            if o.get('op') is not None: tile['op']=o.pop('op')
            tile['ch']=[o]; return tile
        return o
    if k=='v':
        if not n.get('v'): return None
        s=n['v']; s=re.sub(r'\s(pathLength|stroke-dasharray|stroke-dashoffset)="[^"]*"','',s); hd=s[:s.find('>')]
        for a in ('width','height'):
            ms=list(re.finditer(r'\s%s="[^"]*"'%a,hd))
            if len(ms)>1: s=s[:ms[1].start()]+s[ms[1].end():]; hd=s[:s.find('>')]
        o={'k':'v','x':round(n['ax']-parent['ax']),'y':round(n['ay']-parent['ay']),'w':round(n['w']),'h':round(n['h']),'v':s}
        if n.get('op') is not None and n['op']<0.99: o['op']=n['op']
        if n['w']>=400 and n['h']>=100: o['bel']=1
        return o
    # frame
    kids=n['kids']
    o={'k':'f','n':n['n'],'w':round(n['w']),'h':round(n['h'])}
    if parent: o['x']=round(n['ax']-parent['ax']); o['y']=round(n['ay']-parent['ay'])
    if n.get('b'): o['b']=col(n['b'])
    if n.get('g'): o['g']=cs(n['g'])
    if n.get('bw'): o['bw']=n['bw']; o['bc']=col(n['bc'])
    if n.get('r'): o['r']=n['r']
    if n.get('sh'):
        sh=cs(n['sh']); sh=re.sub(r'#00000000 0px 0px 0px 0px,?\s*','',sh).strip(', ')
        if sh: o['sh']=sh
    if n.get('cl'): o['cl']=1
    if n.get('bel'): o['bel']=1
    if n.get('op'): o['op']=n['op']
    if n.get('fl'): o['fl']=n['fl']
    if n.get('bb'): o['bb']=n['bb']
    # skip tiny decorative / full-bleed images handled by encoder
    big=[x for x in kids if x['k']=='i' and x['w']>=1400]
    kids=[x for x in kids if not (x['k']=='i' and x['w']>=1400)]
    res=infer(n,kids) if len(kids)>=1 else None
    if not res and len(kids)>=4:
        # cluster rows
        ks=sorted(kids,key=lambda k:(k['ay'],k['ax'])); rows=[]
        for k in ks:
            if rows and abs(rows[-1][0]['ay']-k['ay'])<=3: rows[-1].append(k)
            else: rows.append([k])
        if len(rows)>=2 and all(len(r)>=1 for r in rows) and len(rows)<len(kids):
            synth=[]
            for i,r in enumerate(rows):
                x0=min(k['ax'] for k in r); y0=min(k['ay'] for k in r); x1=max(k['ax']+k['w'] for k in r); y1=max(k['ay']+k['h'] for k in r)
                synth.append({'k':'f','ax':x0,'ay':y0,'w':x1-x0,'h':y1-y0,'n':'Row %d'%(i+1),'kids':r})
            res2=infer(n,synth)
            if res2: kids=synth; res=res2
    if res:
        L,ordered=res; o['al']=L; kids=ordered
    o['ch']=[e for e in (enc(k,n) for k in big+kids) if e]
    for e in o['ch'][:len(big)]: e['abs']=1
    return o
out={}
for sid,v in raw.items():
    root=v['root']; root['ax']=v['ax']; root['ay']=v['ay']
    t=enc(root,None); t['x']=0;t['y']=0; t['w']=v['w']; t['h']=v['h']
    mk=[]
    for m in v.get('masks',[]):
        g=m['m']; h=re.match(r'linear-gradient\((90deg|270deg)?',g); horiz=bool(h and h.group(1))
        st=[]
        for mm in re.finditer(r'rgba?\(([^)]*)\)\s*([\d.]+)?%?',g):
            parts=[float(x) for x in mm.group(1).split(',')]; a=parts[3] if len(parts)>3 else 1.0
            st.append([a,float(mm.group(2)) if mm.group(2) else None])
        if st:
            if st[0][1] is None: st[0][1]=0
            if st[-1][1] is None: st[-1][1]=100
        mk.append({'x':round(m['ax']-v['ax']),'y':round(m['ay']-v['ay']),'w':round(m['w']),'h':round(m['h']),'d':'h' if horiz else 'v','st':st})
    t['mk']=mk
    out[sid]=t
json.dump(out,open('.claude/tmp/tree.json','w'),separators=(',',':'),ensure_ascii=False)
def cnt(n): return 1+sum(cnt(c) for c in n.get('ch',[]))
def auto(n): return (1 if 'al' in n else 0)+sum(auto(c) for c in n.get('ch',[]) if c['k']=='f')
def frames(n): return (1 if n['k']=='f' else 0)+sum(frames(c) for c in n.get('ch',[]))
for k,v in out.items(): print(k,len(json.dumps(v,separators=(',',':'),ensure_ascii=False)),'nodes',cnt(v),'frames',frames(v),'autolayout',auto(v))
