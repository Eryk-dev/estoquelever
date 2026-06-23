#!/usr/bin/env python3
"""Print the next batch of pending problems formatted for AskUserQuestion.
Usage: python3 _next_batch.py [count]   (default 4, in pending order)"""
import json, sys

prob = {x['id']: x for x in json.load(open('_problemas.json', encoding='utf-8'))}
reg = json.load(open('_respostas.json', encoding='utf-8'))
count = int(sys.argv[1]) if len(sys.argv) > 1 else 4

pending = [pid for pid in sorted(reg) if reg[pid]['status'] == 'pendente']
batch = pending[:count]

for pid in batch:
    x = prob[pid]
    print('\n' + '='*78)
    print(f"{pid}  [{x['severity']}]  {x['title']}")
    print(f"  CENÁRIO: {x['scenario']}")
    print(f"  HOJE: {x['today']}")
    print(f"  {x['why']}")
    print(f"  >> PERGUNTA: {x['question']}")
    for i, o in enumerate(x['options'], 1):
        rec = '  <<< RECOMENDADO' if o['rec_marked'] else ''
        print(f"     op{i}: {o['label']}{rec}")
        print(f"          ({o['detail']})")
print('\n' + '='*78)
print('restantes após este lote:', len(pending) - len(batch))
