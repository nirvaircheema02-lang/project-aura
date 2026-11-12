import json,sys,re
t=json.load(open('.claude/tmp/tree.json'))
ids=sys.argv[2:]; out=sys.argv[1]
sub={k:t[k] for k in ids}
table={}; n=[0]
def walk(x):
    if x['k']=='v' and x.get('v') and len(x['v'])>400:
        key='s%d'%n[0]; n[0]+=1
        # dedupe
        for kk,vv in table.items():
            if vv==x['v']: key=kk; n[0]-=1; break
        table[key]=x['v']; x['v']='@'+key
    for c in x.get('ch',[]): walk(c)
for v in sub.values(): walk(v)
code=open('.claude/tmp/builder4.js').read()
s='const DATA = '+json.dumps(sub,separators=(',',':'),ensure_ascii=False)+';\nconst TABLE = '+json.dumps(table,separators=(',',':'),ensure_ascii=False)+';\n'+"const AF = Object.getPrototypeOf(async function () {}).constructor;\nreturn await new AF('DATA', 'TABLE', figma.root.getSharedPluginData('fra', 'builder'))(DATA, TABLE);"
open(out,'w').write(s); print(out,len(s))
