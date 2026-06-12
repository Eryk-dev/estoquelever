# Cross → Troca de Equivalência Integrada (pedidos, separação, compras, estoque)

> **Problema:** equivalência hoje é catálogo passivo (módulo cross) + troca manual só em compras.
> Roteamento não consulta equivalentes → pedido vira OC com peça equivalente parada na prateleira
> (compra inflada). Troca depende do conhecimento de UM operador. Sem conceito de qualidade
> (original × importada × tier) nem de aprovação.

## Decisões fechadas (entrevista 2026-06-12)

| # | Decisão | Escolha |
|---|---|---|
| D1 | Pontos de ação | **Todos:** roteamento (webhook), separação (chão), compras (painel), painel de vendas |
| D2 | Regra de aprovação | Escala única ordenada por produto. **Mesmo nível + par verificado = troca livre (auto).** Qualquer diferença de nível = aprovação humana (modal rotula UPGRADE/DOWNGRADE). Upgrade TAMBÉM exige aprovação (senão operador manda original em anúncio de importado sempre). Override por par possível |
| D3 | Lado fiscal | **Troca sempre interna.** NF/Tiny mantêm o SKU vendido; WMS baixa estoque do substituto; ledger registra vínculo. Zero toque no Tiny |
| D4 | Aprovador | Permissão RBAC nova (ex. `vendas.aprovar_troca`), atribuível a qualquer role. Fila própria + card na home |
| D5 | Escala de classificação | Campo único ordenado: `original > primeira_linha > segunda_linha`. Sem classificação = trata como "exige aprovação" |
| D6 | Reserva durante aprovação | **Reserva forte no substituto AO SOLICITAR** (TTL 48h, padrão reserva_guarda FASE 6). Rejeitou/expirou → libera |
| D7 | Troca mista (1 original + 1 equivalente no mesmo pedido) | Permitida **só com aprovação** (sempre humano, mesmo tier igual); modal avisa "cliente receberá peças de marcas diferentes" |
| D8 | Rejeição/timeout | Rejeitou → **re-roteia automático** (OC/transferência). Sem timeout — pendência fica visível na home até decisão |
| D9 | Confiança pra auto-troca | **Só pares VERIFICADOS por humano** (curadoria no cross). OEM compartilhado (regex ruidoso) ou cadeia transitiva não-verificados = sempre aprovação, mesmo com tier igual |
| D10 | Prioridade no roteamento | **Troca local (mesmo nível, verificada, galpão casa) VENCE transferência do original.** Pedido auto-aprova e sai no dia |
| D11 | Backfill da classificação | Eryk popula via SQL direto (padrão de SKU por fornecedor → tier; `sku-fornecedor.ts` já mapeia prefixos). Complemento: classificação inline no modal de aprovação (2 dropdowns) — catálogo se classifica com o uso |

## Schema

```sql
-- 1. Classificação de qualidade (catálogo WMS, não o catálogo cross)
ALTER TABLE siso_produtos ADD COLUMN tier_qualidade text
  CHECK (tier_qualidade IN ('original','primeira_linha','segunda_linha'));
-- NULL = sem classificação = toda troca envolvendo ele exige aprovação

-- 2. Curadoria de pares (por SKU, normalizado sku_a < sku_b — mesmo padrão de siso_produto_links)
CREATE TABLE siso_equivalencias_verificadas (
  id bigserial PRIMARY KEY,
  sku_a text NOT NULL,
  sku_b text NOT NULL,
  status text NOT NULL DEFAULT 'verificado' CHECK (status IN ('verificado','bloqueado')),
  -- 'bloqueado' = override "nunca trocar" mesmo que cluster diga equivalente
  verificado_por uuid REFERENCES siso_usuarios(id),
  verificado_em timestamptz DEFAULT now(),
  observacao text,
  CHECK (sku_a < sku_b),
  UNIQUE (sku_a, sku_b)
);

-- 3. Solicitação de troca (entidade ÚNICA, 3 superfícies)
CREATE TABLE siso_trocas_equivalencia (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id text NOT NULL REFERENCES siso_pedidos(id),
  pedido_item_id bigint NOT NULL,
  produto_vendido_id uuid NOT NULL REFERENCES siso_produtos(id),
  produto_substituto_id uuid NOT NULL REFERENCES siso_produtos(id),
  sku_vendido text NOT NULL,
  sku_substituto text NOT NULL,
  quantidade numeric NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('mesmo_nivel','upgrade','downgrade','sem_classificacao','misto')),
  origem_solicitacao text NOT NULL CHECK (origem_solicitacao IN ('roteamento','separacao','compras','painel')),
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','aprovada','rejeitada','expirada','cancelada')),
  tier_vendido_snapshot text,
  tier_substituto_snapshot text,
  reserva_mov_ids uuid[],            -- R(s) criadas no substituto ao solicitar
  solicitado_por uuid, solicitado_em timestamptz DEFAULT now(),
  decidido_por uuid, decidido_em timestamptz,
  motivo_rejeicao text
);

-- 4. Item aponta pro produto FÍSICO quando trocado
ALTER TABLE siso_pedido_itens
  ADD COLUMN produto_wms_substituto_id uuid REFERENCES siso_produtos(id),
  ADD COLUMN troca_equivalencia_id uuid REFERENCES siso_trocas_equivalencia(id);
```

**Por que `produto_wms_substituto_id` e NÃO trocar `produto_id`:** `produto_id` é tiny_produto_id
(camada fiscal). O substituto pode nem ter mapping Tiny na empresa do pedido. Mantendo `produto_id`
intocado: NF/Tiny/marketplace 100% puros (D3); só a resolução WMS (reservas, picks, estornos,
devolução) passa a usar o substituto quando presente. Regra: **produto efetivo do item =
`produto_wms_substituto_id ?? resolverProdutoWms(empresa, tiny_produto_id)`**.

## Regra de decisão (função pura, testável)

```
podeTrocar(vendido, substituto):
  par não verificado (ou status='bloqueado')      → bloqueado p/ auto; solicitação vira 'aprovação'
  tier de um dos dois é NULL                       → aprovação (tipo=sem_classificacao)
  tier igual + par verificado                      → LIVRE (auto, zero humano)
  tier diferente                                   → aprovação (tipo=upgrade|downgrade)
  mistura de produtos no mesmo item (parcial)      → aprovação SEMPRE (tipo=misto)
```

## Fluxos

### 1. Roteamento (webhook) — mata a compra inflada na raiz
Em `roteamento.ts`, ANTES de decidir `oc`:
1. Cobertura normal do SKU original por galpão (como hoje).
2. Galpão-casa não cobre com original → tenta cobrir com **substituto verificado mesmo nível**
   (cluster cross ∩ pares verificados ∩ tier igual ∩ saldo live):
   - Cobre → **troca automática**: seta substituto no item, cria R no substituto,
     `decisao_final='propria'`, auto-aprova, evento `troca_equivalente_auto`. (D10: vence transferência.)
3. Só cobre com substituto que **exige aprovação** (tier diferente / não verificado / sem tier) →
   cria `siso_trocas_equivalencia` pendente + reserva forte no substituto (D6), pedido fica
   `pendente` com sugestão nova `troca_equivalente`. Painel mostra modal. Se transferência também
   era possível, modal mostra AMBAS as opções (trocar local × transferir original).
4. Nenhum equivalente → fluxo atual (transferência/OC).
5. Rejeição da troca → libera R do substituto + **re-roteia automático** (D8).

### 2. Separação (chão)
Cascade esgota / `validacao_oc` "esgotado": UI mostra equivalentes do cluster com saldo no galpão
(tier, badge verificado, loc). Operador solicita:
- mesmo nível verificado → executa direto (livre), pick segue na loc do substituto;
- senão → solicitação pendente + R no substituto; item exibe "troca aguardando aprovação";
  aprovou → operador pega na loc indicada; rejeitou → fluxo atual (compras).

### 3. Compras (painel)
Item em `aguardando_compra` com equivalente em estoque → badge "equivalente em estoque" antes de
gerar OC. Comprador solicita troca (mesma entidade/regra). Aprovada → item sai de compras, volta
pro fluxo de separação com substituto.
> **Não substitui** o fluxo existente `equivalente_pendente`/confirmar — aquele é "comprar OUTRO
> SKU" (troca fiscal via Tiny); este é "usar estoque equivalente em vez de comprar". Coexistem.

### 4. Painel de vendas
Card pendente: botão cross atual ganha ação "solicitar/aprovar troca" (hoje é só visual).

## Mecânica de execução (aprovada / auto) — precedente: confirmar-equivalente de compras
1. Libera R vivas do produto **vendido** deste item (`liberarReservasDoProdutoDoItem`, fix P2-CMP-04).
2. R do substituto já existe desde a solicitação (D6) — atualiza `origem_tipo` pra `reserva_pedido`.
3. Seta `produto_wms_substituto_id` + `troca_equivalencia_id` no item.
4. Pick/marcar-item/parcial/realocação resolvem pelo produto efetivo → movs S/L já nascem no
   substituto → estornos (`wms_desmarcar_item_atomico`, voltar-etapa, cancelar, cutover reverso)
   funcionam sem mudança de mecânica (operam sobre mov ids).
5. Custo médio: S sai com custo do substituto — correto fisicamente, nada a fazer.
6. **Devolução:** NF diz SKU vendido; `devolucao-detector` consulta `troca_equivalencia_id` →
   estoque volta no produto FÍSICO (substituto).

### Callers que precisam resolver "produto efetivo" (auditar um a um)
`marcar-item`, `parcial`, `marcar-realocacao`, `realocacao-resolver`, `aprovar` (criação de R),
`execution-worker-wms` (conversão R→L+S — R já estará no substituto, verificar),
`cutover.ts` (reversão), `vendas-cancelamento`, `pedido-cancel-handler`, `devolucao-detector`,
`reservas-picking.buscarReservaPendentePorProduto`.

## Guard-rails (bugs existentes a corrigir junto)
- **`/api/wms/compras/trocar-sku` sem guarda de estado**: permite trocar item já separado/com NF →
  reserva órfã + NF fantasma. Adicionar guard: rejeitar se `status_separacao` avançado,
  `estoque_lancado=true` ou `separacao_parcial=true`.
- Ponte catálogo: cluster cross é por SKU (`siso_produtos_catalogo`); troca exige ambos os SKUs
  resolvíveis em `siso_produtos`. SKU do cluster sem produto WMS → não aparece como opção de troca.

## Permissões / UI
- Novo código no registry (35º): `vendas.aprovar_troca`. Solicitar = permissões existentes do
  contexto (separação/compras/painel). Curadoria de par (verificar/bloquear) = `produtos.editar`.
- **Modal de aprovação compartilhado** (3 superfícies): par lado a lado (foto, SKU, tier, estoque
  por loc), rótulo grande UPGRADE/DOWNGRADE/MISTO/SEM CLASSIFICAÇÃO, dropdowns inline pra
  classificar produto sem tier (D11), aprovar/rejeitar com motivo.
- Home (quadro-tarefas): card "Trocas aguardando aprovação" perm-gated.
- Cross (`/wms/cross/[sku]`): tier visível + botão "verificar equivalência" por par do cluster
  (✓ intercambiáveis / ✗ nunca trocar).

## Fases de implementação (ordem por risco)
1. **Fundação:** schema + tier + curadoria de pares no cross + backfill SQL por fornecedor (Eryk).
2. **Núcleo:** entidade troca + regra pura + mecânica executar/rejeitar/estornar + RBAC + modal +
   card home. Guard do trocar-sku.
3. **Chão:** origem separação (cascade/validacao_oc) + badge em compras.
4. **Roteamento:** auto-troca + sugestão `troca_equivalente` (maior blast radius — por último,
   atrás de testes de cenário).
5. **Cauda:** devolução via vínculo + visibilidade em relatórios/histórico.

## Fora de escopo (flag futuro)
- Disponibilidade de anúncio ML considerando equivalentes (inflar estoque vendável do anúncio).
- Fusão de itens equivalentes no mesmo pedido (hoje 409 no confirmar de compras).
