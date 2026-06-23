#!/usr/bin/env python3
"""Record answers into _respostas.json and regenerate respostas-problemas.md.
Usage: python3 _record.py '<json>'  where json = {"P002": {"op": "custom", "nota": "..."}, ...}
  op: int (1..n) | 0 (sem ação) | "custom" (decisão fora das opções, ver nota)
Then rebuilds the markdown from _respostas.json + _problemas.json."""
import json, sys

prob = {x['id']: x for x in json.load(open('_problemas.json', encoding='utf-8'))}
reg = json.load(open('_respostas.json', encoding='utf-8'))

updates = json.loads(sys.argv[1])
for pid, a in updates.items():
    x = prob[pid]
    op = a['op']
    nota = a.get('nota', '')
    if op == 0:
        lab = 'SEM AÇÃO / deixar como está'
    elif op == 'custom':
        lab = 'DECISÃO CUSTOM (ver nota)'
    elif isinstance(op, int) and 1 <= op <= len(x['options']):
        lab = x['options'][op-1]['label']
    else:
        raise SystemExit(f'op inválido para {pid}: {op}')
    reg[pid] = {'id': pid, 'title': x['title'], 'severity': x['severity'],
                'status': 'respondido', 'opcao': op, 'opcao_label': lab, 'nota': nota}

json.dump(reg, open('_respostas.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

# rebuild md
respondido = [r for r in reg.values() if r['status'] == 'respondido']
pendente = [r for r in reg.values() if r['status'] == 'pendente']
def opstr(r):
    o = r['opcao']
    return 'sem ação' if o == 0 else ('custom' if o == 'custom' else f'op{o}')
lines = ['# Respostas — Problemas SISO\n',
         f'Total: 185 · respondidos: {len(respondido)} · pendentes: {len(pendente)}\n',
         '> `op` = opção escolhida no card · `sem ação` = deixar como está · `custom` = decisão fora das opções (ver detalhe)\n',
         '\n## Respondidos\n',
         '| ID | Problema | Decisão | Detalhe / observação |',
         '|----|----------|---------|----------------------|']
for r in sorted(respondido, key=lambda z: z['id']):
    lab = (r['opcao_label'] or '').replace('|', '/')
    lines.append(f"| {r['id']} | {r['title'].replace('|','/')} | **{opstr(r)}** — {lab} | {(r['nota'] or '').replace('|','/')} |")
lines.append('\n## Pendentes\n| ID | Problema | Gravidade |\n|----|----------|-----------|')
for r in sorted(pendente, key=lambda z: z['id']):
    lines.append(f"| {r['id']} | {r['title'].replace('|','/')} | {r['severity']} |")
open('respostas-problemas.md', 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print(f"OK · respondidos: {len(respondido)} · pendentes: {len(pendente)}")
print('próximos pendentes:', ', '.join(r['id'] for r in sorted(pendente, key=lambda z: z['id']))[:80])
