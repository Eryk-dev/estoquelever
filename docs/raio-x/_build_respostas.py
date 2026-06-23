#!/usr/bin/env python3
"""Merge user-given answers with parsed problems -> _respostas.json + respostas-problemas.md.
op=0 means 'sem ação / deixar como está'. op=None means pendente (sem resposta ainda)."""
import json

prob = {x['id']: x for x in json.load(open('_problemas.json', encoding='utf-8'))}

# Answers already given by the user (batch 1: P001-P046, com brancos em P002/P009/P028).
answers = {
 'P001': (1, 'OPCAO 1 VALIDAR'),
 'P003': (1, 'OPCAO 1 TRAVA'),
 'P004': (3, 'mercadoria do pedido não vai mudar — deixar como está'),
 'P005': (2, 'repetir automaticamente se falhar + sistema tolerante a duplicatas'),
 'P006': (1, 'registrar automaticamente todos os erros de separação no histórico'),
 'P007': (2, 'cancelar só o que não foi pego; devolver item pego manualmente'),
 'P008': (1, 'cancelar a tarefa na fila quando o pedido é cancelado'),
 'P010': (0, 'NÃO FAZER NADA'),
 'P011': (0, 'não é possível acontecer; não se preocupar com pedido de item 0 unidades'),
 'P012': (1, 'fazer a consolidação ANTES de marcar como em separação'),
 'P013': (1, 'recarregar tela e mostrar estado real quando a rede voltar'),
 'P014': (1, 'desfazimento tudo-ou-nada'),
 'P015': (1, 'guardar o número exato de estoque do dia da marcação'),
 'P016': (0, 'não mexer; nunca aconteceu e o sistema antigo não tinha essa trava'),
 'P017': (1, 'permitir zero só com confirmação de prateleira vazia'),
 'P018': (2, 'desabilitar o botão por 2s após o primeiro clique'),
 'P019': (1, 'op1'),
 'P020': (0, 'não fazer nada'),
 'P021': (2, 'op2'),
 'P022': (0, 'não fazer nada'),
 'P023': (1, 'opção 1'),
 'P024': (0, 'deixar como está'),
 'P025': (0, 'deixar como está'),
 'P026': (0, 'deixar como está'),
 'P027': (0, 'deixar como está'),
 'P029': (1, 'op1 + botão de confirmação manual (igual inventário: entrada em loc sem etiqueta)'),
 'P030': (0, 'deixar como está'),
 'P031': (1, 'op1'),
 'P032': (0, 'não fazer nada; recebimento pressupõe produto cadastrado; sistema já barra endereço inválido'),
 'P033': (3, 'op3'),
 'P034': (1, 'op1'),
 'P035': (1, 'op1'),
 'P036': (1, 'bloquear a troca quando tem compra ativa'),
 'P037': (1, 'op1'),
 'P038': (1, 'op1'),
 'P039': (2, 'op2'),
 'P040': (2, 'op2'),
 'P041': (1, 'op1'),
 'P042': (1, 'permite cancelamento'),
 'P043': (2, 'op2'),
 'P044': (0, 'isso não vai acontecer; deixar como está'),
 'P045': (2, 'op2'),
 'P046': (1, 'op1'),
}

reg = {}
for pid, x in prob.items():
    op, note = answers.get(pid, (None, None))
    chosen = None
    if op and op >= 1 and op <= len(x['options']):
        chosen = x['options'][op-1]['label']
    elif op == 0:
        chosen = 'SEM AÇÃO / deixar como está'
    reg[pid] = {
        'id': pid, 'title': x['title'], 'severity': x['severity'],
        'status': 'respondido' if op is not None else 'pendente',
        'opcao': op, 'opcao_label': chosen, 'nota': note,
    }

json.dump(reg, open('_respostas.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

# Human-readable markdown
respondido = [r for r in reg.values() if r['status'] == 'respondido']
pendente = [r for r in reg.values() if r['status'] == 'pendente']
lines = ['# Respostas — Problemas SISO\n',
         f'Total: 185 · respondidos: {len(respondido)} · pendentes: {len(pendente)}\n',
         '> `op` = número da opção escolhida no card · `0` = sem ação / deixar como está · `—` = pendente\n',
         '\n## Respondidos\n',
         '| ID | Problema | Decisão | Detalhe |',
         '|----|----------|---------|---------|']
for r in sorted(respondido, key=lambda z: z['id']):
    op = 'sem ação' if r['opcao'] == 0 else f"op{r['opcao']}"
    lab = (r['opcao_label'] or '').replace('|', '/')
    lines.append(f"| {r['id']} | {r['title'].replace('|','/')} | **{op}** — {lab} | {r['nota'].replace('|','/')} |")
lines.append('\n## Pendentes\n')
lines.append('| ID | Problema | Gravidade |')
lines.append('|----|----------|-----------|')
for r in sorted(pendente, key=lambda z: z['id']):
    lines.append(f"| {r['id']} | {r['title'].replace('|','/')} | {r['severity']} |")
open('respostas-problemas.md', 'w', encoding='utf-8').write('\n'.join(lines) + '\n')

print(f"respondidos: {len(respondido)} · pendentes: {len(pendente)}")
print('pendentes:', ', '.join(r['id'] for r in sorted(pendente, key=lambda z: z['id']))[:200])
