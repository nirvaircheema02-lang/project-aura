import json,glob,re,sys,subprocess
J=glob.glob('projects/*/redesigns/dealers-voice-survey-page-audit-v3-redesign-20261012-104005/judgments')[0]
B=sys.argv[1]
subprocess.run(['node','--experimental-strip-types','.claude/tmp/partial.ts',J,B],capture_output=True)
p=json.load(open(f'{J}/{B}.bundle.json'))['prompt']
d=json.load(open('.claude/tmp/partial.json'))
blocks={}
for m in re.finditer(r'^findingId=(\w+)\n(.*?)(?=^findingId=|\nConstraints from)',p,re.S|re.M): blocks[m.group(1)]=m.group(2)
edits=list(d['edits']); un=list(d['unaddressed'])
for fid in d['missing']:
    b=blocks[fid]
    sel=re.search(r'^stampSelector=(.*)$',b,re.M)
    rt=b.split('resolved targets (the ONLY properties you may change):')[1].split('not to be changed')[0] if 'resolved targets (the ONLY' in b else ''
    n=0
    for m in re.finditer(r'^    - ([\w-]+) = (.+?)(?: \(token (--[\w-]+)\))? — ',rt,re.M):
        if not sel: break
        prop,val,tok=m.groups()
        edits.append({"findingId":fid,"selector":sel.group(1),"expectedMatches":1,"kind":"style","property":prop,"value":val.strip(),"removeValue":None,"dsComponent":None,"dsVariant":None,"dsToken":tok,"rationale":"Applies the resolved target verbatim (audit-measured expectation).","confidence":0.9}); n+=1
    if n==0: un.append({"findingId":fid,"reason":"No resolved target or no mapped element: nothing is changed."})
json.dump({"edits":edits,"unaddressed":un},open('.claude/tmp/ans.json','w'))
print('r3',len(edits),len(un),flush=True)
