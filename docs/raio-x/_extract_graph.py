#!/usr/bin/env python3
"""Extrai o grafo de relações (108 fluxos x 12 estados compartilhados) de impacto.html + index.html."""
import re, html as h, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
def rd(f): return open(os.path.join(HERE, f), encoding='utf-8').read()
def txt(s): return h.unescape(re.sub(r'<[^>]+>', '', s)).strip()
def fid(href):
    m = re.match(r'(\d{3})', href); return m.group(1) if m else None

# ---------- 1. index.html : fluxos por módulo ----------
idx = rd('index.html').split('</style>',1)[1]
flows = {}           # id -> {...}
modules_order = []
cur_mod = None
# walk through body in order, tracking <h2> module headers and <a class="fl"> rows
for m in re.finditer(r'<h2[^>]*>(.*?)</h2>|<a class="fl" href="([^"]+)">(.*?)</a>', idx, re.S):
    if m.group(1) is not None:
        cur_mod = txt(m.group(1)).split('·')[0].strip()
        if cur_mod not in modules_order: modules_order.append(cur_mod)
    else:
        href, inner = m.group(2), m.group(3)
        i = fid(href)
        title = txt(re.search(r'class="t">(.*?)</div>', inner, re.S).group(1))
        fm = re.search(r'class="f">(.*?)</div>', inner, re.S)
        desc = txt(fm.group(1)) if fm else ''
        def chip(label):
            mm = re.search(r'class="mchip \w+">(\d+)\s*'+label, inner)
            return int(mm.group(1)) if mm else 0
        flows[i] = {
            'id': i, 'file': href, 'title': title, 'desc': desc,
            'module': cur_mod,
            'problems': chip('problema'), 'decisions': chip('decis'), 'check': chip('conferir'),
        }

# ---------- 2. impacto.html : 12 estados compartilhados (hubs) ----------
imp = rd('impacto.html').split('</style>',1)[1]
# hub short names (curados a partir do nm)
SHORT = [
 ('fila de tarefas internas',        'Fila de execução'),
 ('estoque que você aparta',         'Reservas'),
 ('travamentos das prateleiras',     'Locks de contagem'),
 ('nota fiscal de venda e compra',   'Nota fiscal'),
 ('fila de tarefas de guardar',      'Fila de guarda'),
 ('rotina que, quando a mercadoria', 'Reconciliador'),
 ('posição do estoque nas prateleiras','Estoque (saldo)'),
 ('etapa do pedido e quem decide',   'Status do pedido'),
 ('etapa em que cada pedido está na separação','Status separação'),
 ('preço médio de cada peça',        'Custo médio'),
 ('registro de tudo que entra',      'Ledger'),
 ('marcação de estoque já saído',    'Estoque lançado'),
]
def short_for(name):
    low = name.lower()
    for frag, s in SHORT:
        if frag in low: return s
    return name[:24]

# nm headers in order
nm_positions = [(m.start(), txt(m.group(1))) for m in re.finditer(r'<p class="nm">(.*?)</p>', imp, re.S)]
# split body into 12 spine segments by nm position
segs = []
for i,(pos,name) in enumerate(nm_positions):
    end = nm_positions[i+1][0] if i+1 < len(nm_positions) else len(imp)
    segs.append((name, imp[pos:end]))

hubs = []
for hid,(name, seg) in enumerate(segs):
    # writers = links after 'Quem mexe nela' up to 'Quem depende dela'; readers = after that
    wm = re.search(r'Quem mexe nela(.*?)Quem depende dela(.*)', seg, re.S)
    writers, readers = [], []
    if wm:
        writers = [fid(x) for x in re.findall(r'class="np lk" href="([^"]+)"', wm.group(1))]
        readers = [fid(x) for x in re.findall(r'class="np lk" href="([^"]+)"', wm.group(2))]
    # conflicts: each .it block -> severity chip + title
    conflicts = []
    for it in re.findall(r'<div class="it">(.*?)(?=<div class="it">|<div class="col">|<div class="cols">|$)', seg, re.S):
        sev = re.search(r'class="chip (fix|dec|check)"', it)
        ctm = re.search(r'class="ct">(.*?)</div>', it, re.S)
        # title is the span after the chip
        tt = re.search(r'class="chip \w+">[^<]*</span>\s*<span[^>]*>(.*?)</span>', it, re.S)
        title = txt(tt.group(1)) if tt else (txt(ctm.group(1)) if ctm else '')
        if title:
            sevmap = {'fix':'grave','dec':'média','check':'leve'}
            conflicts.append({'sev': sevmap.get(sev.group(1),'') if sev else '', 'title': title})
    hubs.append({
        'hub': hid, 'name': name, 'short': short_for(name),
        'writers': sorted(set(w for w in writers if w)),
        'readers': sorted(set(r for r in readers if r)),
        'conflicts': conflicts,
    })

# ---------- 3. edges + stats ----------
edges = []
for hub in hubs:
    for w in hub['writers']: edges.append({'flow': w, 'hub': hub['hub'], 'type': 'write'})
    for r in hub['readers']: edges.append({'flow': r, 'hub': hub['hub'], 'type': 'read'})

referenced = set(e['flow'] for e in edges)
isolated = sorted(set(flows) - referenced)

# degree per flow
deg = {}
for e in edges:
    deg.setdefault(e['flow'], {'write':0,'read':0})
    deg[e['flow']][e['type']] += 1
for i,f in flows.items():
    d = deg.get(i, {'write':0,'read':0})
    f['writes'] = d['write']; f['reads'] = d['read']; f['degree'] = d['write']+d['read']

data = {
    'meta': {
        'flows': len(flows), 'hubs': len(hubs), 'modules': len(modules_order),
        'edges': len(edges),
        'write_edges': sum(1 for e in edges if e['type']=='write'),
        'read_edges': sum(1 for e in edges if e['type']=='read'),
        'conflicts': sum(len(hb['conflicts']) for hb in hubs),
        'conflicts_grave': sum(1 for hb in hubs for c in hb['conflicts'] if c['sev']=='grave'),
        'isolated': isolated,
    },
    'modules': modules_order,
    'flows': [flows[i] for i in sorted(flows)],
    'hubs': hubs,
    'edges': edges,
}
open(os.path.join(HERE,'_graph-data.json'),'w',encoding='utf-8').write(json.dumps(data, ensure_ascii=False, indent=1))

# ---------- report ----------
print(f"flows={data['meta']['flows']}  hubs={data['meta']['hubs']}  modules={data['meta']['modules']}")
print(f"edges={data['meta']['edges']} (write={data['meta']['write_edges']} read={data['meta']['read_edges']})")
print(f"conflicts={data['meta']['conflicts']} (graves={data['meta']['conflicts_grave']})")
print(f"isolated flows ({len(isolated)}): {isolated}")
print("\nhubs (writers/readers/conflicts):")
for hb in hubs:
    print(f"  {hb['short']:20} W={len(hb['writers']):>2} R={len(hb['readers']):>2} conf={len(hb['conflicts'])}")
print("\nmodules:", len(modules_order))
for mname in modules_order:
    c = sum(1 for f in flows.values() if f['module']==mname)
    print(f"  {c:>2}  {mname}")
print("\ntop coupled flows:")
for f in sorted(flows.values(), key=lambda x:-x['degree'])[:8]:
    print(f"  deg={f['degree']:>2} (w{f['writes']}/r{f['reads']})  {f['id']} {f['title'][:46]}")