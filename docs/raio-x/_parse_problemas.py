#!/usr/bin/env python3
"""Parse problemas.html into structured JSON: id, title, severity, scenario, today, why, question, options[], rec, flow, file."""
import re, json, html, sys

src = open('/Users/eryk/Documents/ESTOQUE/docs/raio-x/problemas.html', encoding='utf-8').read()

# Split into dcards
cards = re.split(r'<div class="dcard">', src)[1:]  # first chunk is the header

def clean(s):
    if s is None: return None
    s = re.sub(r'<[^>]+>', '', s)
    return html.unescape(s).strip()

out = []
for c in cards:
    pid = re.search(r'class="idb">(P\d+)</span>', c)
    pid = pid.group(1) if pid else None
    title = re.search(r'class="idb">P\d+</span>(.*?)</h3>', c, re.S)
    title = clean(title.group(1)) if title else None
    sev = re.search(r'<span class="chip (fix|dec|check)">([^<]+)</span>', c)
    sev = sev.group(2) if sev else None
    scn = re.search(r'class="ln scn">(.*?)</p>', c, re.S)
    scn = clean(scn.group(1)) if scn else None
    # "Hoje:" is the first .ln that's not scn/why
    hoje = re.search(r'<p class="ln"><b>Hoje:</b>(.*?)</p>', c, re.S)
    hoje = clean(hoje.group(1)) if hoje else None
    why = re.search(r'class="ln why">(.*?)</p>', c, re.S)
    why = clean(why.group(1)) if why else None
    q = re.search(r'class="q">(.*?)</p>', c, re.S)
    q = clean(q.group(1)) if q else None
    # options
    opts = []
    optblock = re.search(r'<ul class="opts">(.*?)</ul>', c, re.S)
    if optblock:
        for li in re.findall(r'<li class="([^"]*)">.*?<span><b>(.*?)</b>(.*?)</span>\s*</li>', optblock.group(1), re.S):
            cls, bold, rest = li
            opts.append({
                'rec_marked': 'rec' in cls,
                'label': clean(bold),
                'detail': clean(rest).lstrip('— ').strip()
            })
    rec = re.search(r'class="recnote">(.*?)</p>', c, re.S)
    rec = clean(rec.group(1)) if rec else None
    flow = re.search(r'No fluxo:\s*<a[^>]*>(.*?)</a>', c, re.S)
    flow = clean(flow.group(1)) if flow else None
    tema = re.search(r'tema:\s*([^·<]+)', c)
    tema = tema.group(1).strip() if tema else None
    fileref = re.search(r'class="refi">(.*?)</span>', c, re.S)
    fileref = clean(fileref.group(1)) if fileref else None
    out.append({
        'id': pid, 'title': title, 'severity': sev,
        'scenario': scn, 'today': hoje, 'why': why,
        'question': q, 'options': opts, 'rec': rec,
        'flow': flow, 'tema': tema, 'file': fileref
    })

json.dump(out, open('/Users/eryk/Documents/ESTOQUE/docs/raio-x/_problemas.json','w',encoding='utf-8'), ensure_ascii=False, indent=2)
# sanity
no_opts = [p['id'] for p in out if not p['options']]
print(f"parsed {len(out)} problems")
print(f"without options: {len(no_opts)} -> {no_opts[:20]}")
print(json.dumps(out[0], ensure_ascii=False, indent=2)[:800])
