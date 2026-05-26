-- Webhook dedup compound (nota_fiscal_id + chave_acesso_nf) [#P6-6.33]
--
-- A tabela siso_webhook_logs já tem dedup via dedup_key generated
-- (tiny_pedido_id:tipo:codigo_situacao). Pra webhooks de NF (tipo='nota_fiscal'),
-- tiny_pedido_id é o idNotaFiscalTiny e codigo_situacao é vazio — logo o dedup
-- key é equivalente a "<idNotaFiscalTiny>:nota_fiscal:". Mas o Tiny pode (em
-- raras situações) re-emitir o mesmo webhook com idNotaFiscalTiny diferente
-- mantendo a mesma chave de acesso (ex: re-emissão depois de cancelamento).
--
-- Esses índices funcionam como lookup auxiliar pro dedup defensivo no código
-- da rota: antes de inserir um novo log de NF, checa se já existe outro com
-- mesma idNotaFiscalTiny OU mesma chaveAcesso já processado.
--
-- Como nota_fiscal_id e chave_acesso_nf NÃO são colunas dedicadas em
-- siso_webhook_logs (vivem dentro de payload jsonb), os índices são GIN
-- expression sobre o jsonb pra suportar busca rápida.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_webhook_logs_dedup_nf_id
  ON siso_webhook_logs ((payload -> 'dados' ->> 'idNotaFiscalTiny'))
  WHERE tipo = 'nota_fiscal'
    AND payload -> 'dados' ->> 'idNotaFiscalTiny' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_logs_dedup_nf_chave
  ON siso_webhook_logs ((payload -> 'dados' ->> 'chaveAcesso'))
  WHERE tipo = 'nota_fiscal'
    AND payload -> 'dados' ->> 'chaveAcesso' IS NOT NULL;

COMMIT;
