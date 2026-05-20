# Archive — Designs Dormentes

Esta pasta guarda **designs completos** que **não foram implementados**, junto com a razão. Servem como referência caso a regra de negócio mude no futuro e o modelo precise ser ressuscitado.

Cada documento aqui foi alguma vez pensado como o caminho a seguir — e descartado por motivo registrado. O conhecimento de negócio é preservado mesmo quando o código não vai pro repositório.

---

## 2026-05-20 — Modelo 4D com camada de propriedade contábil

**Arquivos:**
- `2026-05-20-empresa-dona-camada-contabil-design-dormente.html` — design completo da camada contábil paralela
- `2026-05-20-lancamentos-modelo-4d-fluxo.html` — fluxo do modelo 4D original (lançamentos, empréstimos, swaps, mini-swaps)

**O que era:**
Estoque modelado em quatro coordenadas físicas: **(produto, empresa dona, galpão, localização)**. Cada empresa do grupo (NetAir, NetParts, 141AIR, EasyPeasy, Bellator) com saldo próprio em cada prateleira. Acoplado a esse modelo, três mecanismos:

- **Matriz N×N de empréstimo** (direcional credora → devedora) com limites por SKU
- **Swap inter-galpão** — 4 movs casadas que trocam saldo entre empresas em galpões diferentes (zero dívida)
- **Mini-swap intra-galpão** — consolidação pré-onda do saldo de várias empresas em uma loc

A camada contábil estendia o modelo: além do físico 4D, um ledger contábil paralelo com saldo + custo médio por empresa. Algoritmos:

- **Distribuição igual com cascade** pra perdas de inventário (round-robin entre empresas com saldo, pula quem zera)
- **Largest remainder method** pra transferências inter-galpão proporcionais em inteiros

**Por que não foi implementado:**

O operador físico **não consegue distinguir donos de peças idênticas**. Numa cesta com 13 pastilhas EW123 visualmente iguais, ninguém aponta quais são da NetAir e quais são da 141AIR. Isso gerava:

1. **Divergências fictícias de inventário** — operadora conta o total (correto), sistema esperava contagem por dona, não bate
2. **Escolha arbitrária na venda manual** — vendedor forçado a "escolher" dona da peça, sem critério real
3. **Reservas amarradas a coordenada irreal** — roteamento decide trocar dona via swap/empréstimo pra "fazer caber", mas a peça física é sempre a mesma
4. **Complexidade alta com benefício baixo** — swap + mini-swap + matriz N×N existiam só pra "consertar" a dor que o próprio modelo 4D criou

Tentativa intermediária: separar em duas camadas (físico 3D operacional + contábil 3D paralelo atualizado automaticamente). Custo de manter saldo+custo médio por empresa não compensou o ganho fiscal/contábil. **Decisão final:** ledger único 3D com metadata rica nos eventos, sem estado mantido por empresa. Apuração por empresa = report ad-hoc.

**Design ativo que substituiu:**
`docs/superpowers/specs/2026-05-20-ledger-simplificado-design.md`

**Quando ressuscitar:**

Se algum dia a contabilidade exigir saldo formal por CNPJ na operação física (não só em report), ou se um marketplace passar a exigir lastro físico identificado por empresa (improvável), o material aqui está pronto pra ser reativado. Inclui:

- Schema completo das tabelas contábeis
- Algoritmos de distribuição com pseudocódigo e exemplos numéricos
- Catálogo de operações com efeito físico + contábil de cada
- Fluxo de lançamentos em linguagem de negócio (HTML pra validação)

**Código que foi ou será arquivado junto:**
- `src/lib/wms/emprestimos.ts`
- `src/lib/wms/mini-swap.ts`
- `src/lib/wms/mini-swap-types.ts`
- (qualquer arquivo `swap.ts`/`swap-types.ts` se vier a existir)

Esses arquivos vão pra `src/lib/wms/_archive/` quando o plano de implementação do ledger simplificado for executado.
