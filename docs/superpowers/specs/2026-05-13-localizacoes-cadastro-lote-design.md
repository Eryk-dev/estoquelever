# WMS — Cadastro de localizações em lote

**Data:** 2026-05-13
**Módulo:** WMS / Localizações
**Status:** Design aprovado, aguardando plano de implementação

## Problema

Hoje a tela `/wms/localizacoes` cria 1 localização por vez. Ruas de estoque são tipicamente uniformes (rua A com 10 colunas × 10 níveis = 100 locs com mesmo padrão), e cadastrar uma por uma é trabalho repetitivo desnecessário. O operador pede a possibilidade de informar prefixo + ranges horizontal/vertical e gerar todas de uma vez.

## Objetivo

Adicionar modo "cadastro em lote" no form existente de `/wms/localizacoes`: o operador informa prefixo, range horizontal (início/fim) e range vertical (início/fim), e o sistema gera todas as combinações cartesianas como localizações novas. Exemplo: prefixo `A`, horizontal `1–10`, vertical `1–10` → 100 localizações `A-01-01` até `A-10-10`.

## Decisões

| Decisão | Escolha |
|---|---|
| Acesso UI | Toggle "Individual / Em lote" no form atual (não duplica botões) |
| Tratamento de duplicatas | Pular e criar o resto (idempotente); retorna resumo |
| Padding numérico | Mínimo 2 dígitos; cresce automaticamente se range passar de 99; por eixo independente |
| Preview | Obrigatório antes de criar — mostra contagem total, duplicatas, e amostra (primeiras 5 + últimas 5) |
| Arquitetura | Backend gera os códigos (a partir dos params) + 1 bulk upsert ao DB |

## Algoritmo de geração

**Localização:** `src/lib/wms/localizacoes.ts` (mesmo arquivo que já tem `criarLocalizacao`).

Função pura, sem dependência de DB ou React — importável tanto pela API quanto pelo client (pro preview local opcional, embora o preview oficial seja via API pra contar duplicatas no DB).

```ts
export type LoteCodigosInput = {
  prefixo: string;       // ex: "A"
  h_inicio: number;
  h_fim: number;
  v_inicio: number;
  v_fim: number;
  separador?: string;    // default "-"
};

export type LoteCodigosResult = {
  codigos: string[];     // ordem: h externo, v interno (A-01-01, A-01-02, ..., A-01-10, A-02-01, ...)
  total: number;         // = (h_fim - h_inicio + 1) * (v_fim - v_inicio + 1)
};

export function gerarCodigosLote(input: LoteCodigosInput): LoteCodigosResult;
```

### Regras

- **Prefixo:** obrigatório, 1–8 caracteres, somente `[A-Z0-9]` (maiúsculas). Espaço, hífen e underscore não permitidos (separador é fixo entre os 3 segmentos).
- **Ranges:** `h_inicio ≤ h_fim`, `v_inicio ≤ v_fim`, ambos ≥ 1, inteiros.
- **Total máximo:** 5000 localizações por chamada. Proteção contra digitação errada (operador digitar `1–1000` por engano gera 1M).
- **Padding:** `pad = max(2, len(str(fim)))` calculado por eixo independente.
  - Horizontal 1–10 → 2 dígitos: `01..10`
  - Horizontal 1–100 → 3 dígitos: `001..100`
  - Horizontal e vertical podem ter padding diferente no mesmo lote (ex: `B-001-05`).
- **Separador:** default `-` (alinha com placeholder atual `A-12-03`). Parametrizável internamente mas não exposto na UI (sem caso de uso).

### Erros de validação

Mensagens em PT-BR (mesmo idioma do resto do WMS):
- `"prefixo é obrigatório"`
- `"prefixo deve ter entre 1 e 8 caracteres alfanuméricos maiúsculos"`
- `"início não pode ser maior que fim"`
- `"valores devem ser inteiros positivos"`
- `"lote excede 5000 localizações (atual: N)"`

## API

### Novo endpoint: `POST /api/wms/localizacoes/lote`

**Localização:** `src/app/api/wms/localizacoes/lote/route.ts`

**Auth:** `requireAuth(req)` (mesmo padrão do endpoint individual — qualquer usuário autenticado).

**Request body:**
```json
{
  "galpao_id": "uuid",
  "prefixo": "A",
  "h_inicio": 1,
  "h_fim": 10,
  "v_inicio": 1,
  "v_fim": 10,
  "tipo": "picking",
  "preview": false
}
```

**Response 200:**
```json
{
  "total": 100,
  "criadas": 77,
  "ja_existiam": 23,
  "amostra": {
    "primeiras": ["A-01-01", "A-01-02", "A-01-03", "A-01-04", "A-01-05"],
    "ultimas":   ["A-10-06", "A-10-07", "A-10-08", "A-10-09", "A-10-10"]
  }
}
```

- Se `total ≤ 10`: `amostra.primeiras` = lista completa, `amostra.ultimas` = `[]`.
- `criadas + ja_existiam` sempre = `total`.

**Comportamento:**
1. `requireAuth` → 401 se inválido.
2. Valida body: `galpao_id` e `prefixo` obrigatórios; `tipo` opcional (default `picking`, deve ser `TipoLocalizacao` válido); `preview` boolean (default `false`).
3. Chama `gerarCodigosLote(...)` — propaga erros de validação como `400`.
4. `SELECT codigo FROM siso_localizacoes WHERE galpao_id = $1 AND codigo = ANY($2)` para contar duplicatas (sempre roda, tanto em preview quanto em criar).
5. Monta `amostra` (primeiras 5 + últimas 5 do array `codigos`).
6. Se `preview === true`: retorna sem inserir. `criadas = 0` neste caso? **Não** — retornamos `criadas = total - ja_existiam` (intenção: "seriam criadas tantas"). Decisão consciente: o número da amostra do botão "Criar X" precisa bater com `criadas`.
7. Se `preview === false`: bulk upsert
   ```ts
   await supabase
     .from('siso_localizacoes')
     .upsert(rows, { ignoreDuplicates: true, onConflict: 'galpao_id,codigo' })
     .select('codigo')
   ```
   `criadas` = `result.length`; `ja_existiam` = `total - criadas`. Confirma que bate com a contagem prévia (se não bater por race, log warning mas retorna o real).
8. Erros DB: `wmsErrorResponse` com `source: "wms.localizacoes.lote"`.

### Endpoint individual existente

`POST /api/wms/localizacoes` permanece **inalterado**. Continua atendendo o uso operacional (operador cria 1 loc on-the-fly nos modais de Receber/Ajuste/Transferência).

## UI: `src/app/wms/localizacoes/page.tsx`

### Toggle no form "Nova localização"

No topo do bloco que aparece quando `showForm === true`:

```
( ● Individual ) ( ○ Em lote )
```

Implementação: par de botões pill-style (já existe padrão `wms-tab-*` ou similar; verificar `Tabs` em `src/components/ui/tabs.tsx` ou inline simples com classes existentes).

Estado: `modo: 'individual' | 'lote'` (default `'individual'`).

### Modo `individual` (atual)

Sem mudanças. Os 3 campos (Código, Descrição, Tipo) e botão "Criar" continuam idênticos.

### Modo `lote`

Layout:

```
Prefixo*: [A     ]       Tipo*: [picking ▼]

Horizontal   Início*: [1  ]   Fim*: [10 ]
Vertical     Início*: [1  ]   Fim*: [10 ]

       [ Cancelar ]              [ Visualizar ]
```

- Inputs numéricos (`<input type="number" min="1">`) pros 4 ranges.
- Prefixo é texto, autoUpperCase no `onChange`.
- Descrição NÃO aparece no modo lote (ficaria igual pra 100 locs, não agrega valor; pode editar individualmente depois se precisar).
- "Visualizar" chama `POST /lote` com `preview: true` e abre painel de confirmação inline (substitui o form).

### Painel de preview

Substitui o form depois do clique em "Visualizar":

```
┌─────────────────────────────────────────────┐
│ 100 localizações serão criadas              │
│ 23 já existem (serão puladas)               │
│                                              │
│ Primeiras 5:                                 │
│   A-01-01, A-01-02, A-01-03,                │
│   A-01-04, A-01-05                          │
│ Últimas 5:                                   │
│   A-10-06, A-10-07, A-10-08,                │
│   A-10-09, A-10-10                          │
│                                              │
│       [ Voltar ]       [ Criar 77 ]         │
└─────────────────────────────────────────────┘
```

- "Voltar" preserva os valores do form (não limpa).
- "Criar 77" (`Criar {criadas}`) chama `POST /lote` com `preview: false`.
  - Se `criadas === 0`: botão fica desabilitado, label "Nada a criar".
- Sucesso: toast `"Criadas 77 (23 já existiam)"` → invalida `["wms-locs", galpaoId]` → fecha form → reseta estado.
- Erro: toast com mensagem do backend.

### Estado React

```ts
const [showForm, setShowForm] = useState(false);
const [modo, setModo] = useState<'individual' | 'lote'>('individual');
// individual (já existe):
const [novo, setNovo] = useState({ codigo, descricao, tipo });
// lote:
const [lote, setLote] = useState({
  prefixo: '',
  h_inicio: 1, h_fim: 10,
  v_inicio: 1, v_fim: 10,
  tipo: 'picking' as TipoLocalizacao,
});
const [previewData, setPreviewData] = useState<LotePreviewResponse | null>(null);
// previewData !== null → mostra painel; null → mostra form
```

Mutations:
- `criarLote` (chama API com `preview:false`)
- `previewLote` (chama API com `preview:true`)

Reusa componentes/classes existentes: `Field`, `wms-input`, `wms-select`, `wms-btn wms-btn-primary`, `wms-btn wms-btn-ghost`, `wms-row-3`. Zero CSS novo.

## Testes

**Novo arquivo:** `src/lib/wms/localizacoes.test.ts` (segue convenção `*.test.ts` do projeto: `ledger.test.ts`, `roteamento.test.ts`, etc.)

### Casos a cobrir em `gerarCodigosLote`

| # | Cenário | Esperado |
|---|---|---|
| 1 | Caso canônico: prefixo `A`, h 1–10, v 1–10 | 100 códigos, primeiro `A-01-01`, último `A-10-10` |
| 2 | Ordem: h externo, v interno | `[A-01-01, A-01-02, ..., A-01-10, A-02-01, ...]` |
| 3 | Padding ≥ 2 sempre | h 1–5 → `A-01-01`, não `A-1-01` |
| 4 | Padding cresce com fim | h 1–100, v 1–5 → `A-001-01 ... A-100-05` |
| 5 | Padding por eixo independente | h 1–10, v 1–100 → `A-01-001 ... A-10-100` |
| 6 | Range degenerado | h 5–5, v 3–3 → 1 código `A-05-03` |
| 7 | Inicio > fim | throw `"início não pode ser maior que fim"` |
| 8 | Prefixo vazio | throw `"prefixo é obrigatório"` |
| 9 | Prefixo com caractere inválido | throw |
| 10 | Total > 5000 | throw |
| 11 | Valores não-inteiros | throw |

### Testes de API

Sem precedente forte de route tests no WMS — implementar smoke test mínimo se houver harness; caso contrário, validação manual em staging é aceitável (alinhado com o padrão atual do projeto).

## Banco de dados

**Sem migrations.** A tabela `siso_localizacoes` já tem:
- `UNIQUE(galpao_id, codigo)` — habilita `ON CONFLICT DO NOTHING`
- Trigger / FK / defaults que cobrem o caso

A proteção contra desativar loc com saldo (`siso_estoque.saldo > 0`) já existe em `desativarLocalizacao` e não é afetada por este trabalho.

## Documentação a atualizar

No mesmo commit que entregar a feature:

- `docs/api-reference-complete.md` — adicionar entrada `POST /api/wms/localizacoes/lote`.
- `CLAUDE.md` — adicionar referência ao novo endpoint na seção do WMS (linha de `localizacoes/route.ts`).

## Fora de escopo (decisões explícitas)

- **Edição em lote** (mudar tipo de N locs de uma vez) — diferente caso de uso, fica pra outra feature.
- **Deleção / desativação em lote** — idem.
- **Importação por CSV** — operador pediu UI generativa, não importação.
- **Templates de layout** ("rua A — usual") — premature, sem dados de uso ainda.
- **3+ eixos** (rua-coluna-prateleira-nível) — modelo atual é 3 segmentos; expandir requer revisitar o schema do `codigo`.
- **Edição da descrição em lote** — modo lote não tem campo descrição (cada loc fica com `descricao = null`); operador edita individualmente se precisar.

## Critério de pronto

- [ ] `gerarCodigosLote` implementada com testes passando
- [ ] `POST /api/wms/localizacoes/lote` implementado com auth + validação + bulk upsert idempotente
- [ ] UI com toggle Individual/Lote, form de lote, preview, criar
- [ ] Validação manual em staging: criar lote 10×10 → 100 locs; rodar de novo → 0 criadas, 100 existiam; estender pra 12×10 → 20 criadas, 100 existiam
- [ ] `docs/api-reference-complete.md` atualizado
- [ ] `CLAUDE.md` atualizado
