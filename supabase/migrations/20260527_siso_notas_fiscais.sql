-- Fix-Final A T5 (R5): Tabela canônica siso_notas_fiscais
-- Resolve: devoluções/vendas/compras não tinham tabela canônica de NF;
--          siso_movimentacoes.nota_fiscal_id ficava NULL ou referenciava
--          bigint do Tiny via origem_detalhes.

BEGIN;

CREATE TABLE IF NOT EXISTS siso_notas_fiscais (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tiny_nota_fiscal_id bigint      NULL,
  chave_acesso        text        UNIQUE,
  numero              text        NULL,
  serie               text        NULL,
  empresa_id          uuid        NULL REFERENCES siso_empresas(id) ON DELETE SET NULL,
  tipo                text        NOT NULL CHECK (tipo IN ('entrada','saida')),
  criada_em           timestamptz NOT NULL DEFAULT now(),
  raw_tiny            jsonb       NULL
);

CREATE INDEX IF NOT EXISTS ix_siso_notas_fiscais_tiny_id   ON siso_notas_fiscais(tiny_nota_fiscal_id) WHERE tiny_nota_fiscal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_siso_notas_fiscais_empresa   ON siso_notas_fiscais(empresa_id);
CREATE INDEX IF NOT EXISTS ix_siso_notas_fiscais_criada_em ON siso_notas_fiscais(criada_em DESC);

-- FK nullable em siso_movimentacoes.nota_fiscal_id (a coluna já existe como UUID)
DO $$ BEGIN
  ALTER TABLE siso_movimentacoes
    ADD CONSTRAINT siso_movimentacoes_nota_fiscal_id_fkey
    FOREIGN KEY (nota_fiscal_id) REFERENCES siso_notas_fiscais(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Realtime publication (cobertura PR-3)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE siso_notas_fiscais;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
