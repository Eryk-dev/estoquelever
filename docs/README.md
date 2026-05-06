# SISO — Documentação

Documentação completa do **Sistema Inteligente de Separação de Ordens** — app Next.js que substitui o workflow n8n para processar pedidos multi-empresa de autopeças.

## Mapa da documentação

| Pasta / arquivo | Quando consultar |
|---|---|
| **[fluxos/](fluxos/)** | Documentação minuciosa de cada fluxo de negócio (entrada de pedido, separação, embalagem, compras, etc.). **Comece aqui** para entender o sistema. |
| **[diagramas/](diagramas/)** | Diagramas Mermaid prontos: ciclo de pedido, máquinas de estado, fluxos visuais. Referência rápida. |
| **[integracoes/](integracoes/)** | Integração com sistemas externos (Tiny ERP, PrintNode, Supabase Realtime). |
| **[api-reference-complete.md](api-reference-complete.md)** | Referência completa de todas as 80+ rotas de API: método, auth, request/response, side effects. |
| **[database-schema.md](database-schema.md)** | Esquema completo do banco: tabelas, colunas, FKs, índices, ER diagram. |
| **[design-changelog/](design-changelog/)** | Brand identity Lever Talents, tokens de design, classes utilitárias. |
| **[wms/](wms/)** | Plano de internalização do controle de estoque (substituir Tiny como fonte de verdade). |
| **[archive/](archive/)** | Documentos históricos / sobrepostos preservados para referência. |

## Para LLMs e novos desenvolvedores

1. Leia o `CLAUDE.md` na raiz do projeto.
2. Leia [`fluxos/README.md`](fluxos/README.md) para entender quais documentos cobrem quais fluxos.
3. Para qualquer mudança em rota de API → atualize `api-reference-complete.md` no mesmo commit.
4. Para qualquer mudança em schema → atualize `database-schema.md` no mesmo commit.
5. Para qualquer mudança em fluxo de negócio → atualize o doc correspondente em `fluxos/` e os diagramas em `diagramas/` no mesmo commit.

## Convenções dos documentos

- **Português** para termos de domínio (pedido, galpão, empresa, separação, decisão).
- **Inglês** para termos técnicos (webhook, token, queue, worker).
- **Referências de código** usam o padrão `caminho/do/arquivo.ts:42` para navegação rápida.
- **Diagramas** usam Mermaid (renderizado pelo GitHub e pela maioria dos viewers de Markdown).
- **Datas** sempre absolutas (`2026-04-15`), nunca relativas (`semana passada`).
