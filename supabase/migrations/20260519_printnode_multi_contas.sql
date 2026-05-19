-- PrintNode multi-contas
--
-- Antes: 1 única API key salva em siso_configuracoes['PRINTNODE_API_KEY'].
-- Depois: tabela siso_printnode_contas (N keys com label). siso_galpoes e
-- siso_usuarios ganham `printnode_account_id` (+ _produto) pra lembrar
-- de qual conta usar a key ao enviar print job.
--
-- Migração: a key existente vira conta 'Default', e todas as atribuições
-- existentes apontam pra ela (zero downtime de impressão).

-- ─── Tabela de contas ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS siso_printnode_contas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text NOT NULL UNIQUE,
  api_key       text NOT NULL,
  ativo         boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE siso_printnode_contas IS
  'Contas PrintNode (multi-key). Cada label identifica uma conta com seu próprio conjunto de impressoras.';

CREATE OR REPLACE FUNCTION siso_printnode_contas_touch()
RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_printnode_contas_touch ON siso_printnode_contas;
CREATE TRIGGER trg_printnode_contas_touch
  BEFORE UPDATE ON siso_printnode_contas
  FOR EACH ROW EXECUTE FUNCTION siso_printnode_contas_touch();

-- ─── Colunas account_id em galpões e usuários ─────────────────────────────
ALTER TABLE siso_galpoes
  ADD COLUMN IF NOT EXISTS printnode_account_id uuid
    REFERENCES siso_printnode_contas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS printnode_account_id_produto uuid
    REFERENCES siso_printnode_contas(id) ON DELETE SET NULL;

ALTER TABLE siso_usuarios
  ADD COLUMN IF NOT EXISTS printnode_account_id uuid
    REFERENCES siso_printnode_contas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS printnode_account_id_produto uuid
    REFERENCES siso_printnode_contas(id) ON DELETE SET NULL;

-- Index pra resolver impressora rápido (JOIN com contas)
CREATE INDEX IF NOT EXISTS idx_galpoes_printnode_account
  ON siso_galpoes(printnode_account_id)
  WHERE printnode_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_galpoes_printnode_account_produto
  ON siso_galpoes(printnode_account_id_produto)
  WHERE printnode_account_id_produto IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_printnode_account
  ON siso_usuarios(printnode_account_id)
  WHERE printnode_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_printnode_account_produto
  ON siso_usuarios(printnode_account_id_produto)
  WHERE printnode_account_id_produto IS NOT NULL;

-- ─── Migração de dados ────────────────────────────────────────────────────
-- 1. Se existe PRINTNODE_API_KEY em siso_configuracoes, cria 1 conta "Default"
--    e popula account_id em galpões/usuários que já têm printer atribuído.
-- 2. No fim, deleta a entry de siso_configuracoes (única fonte da verdade
--    passa a ser siso_printnode_contas).

DO $$
DECLARE
  v_old_key text;
  v_conta_id uuid;
BEGIN
  SELECT valor INTO v_old_key
    FROM siso_configuracoes
   WHERE chave = 'PRINTNODE_API_KEY';

  IF v_old_key IS NULL OR length(v_old_key) = 0 THEN
    RAISE NOTICE 'Sem PRINTNODE_API_KEY antiga — pulando migração de dados.';
    RETURN;
  END IF;

  -- Idempotente: se já existe a conta Default, reusa.
  SELECT id INTO v_conta_id
    FROM siso_printnode_contas
   WHERE label = 'Default';

  IF v_conta_id IS NULL THEN
    INSERT INTO siso_printnode_contas (label, api_key, ativo)
    VALUES ('Default', v_old_key, true)
    RETURNING id INTO v_conta_id;
  END IF;

  -- Popula account_id nas linhas que já têm printer_id mas estão sem account_id
  UPDATE siso_galpoes
     SET printnode_account_id = v_conta_id
   WHERE printnode_printer_id IS NOT NULL
     AND printnode_account_id IS NULL;

  UPDATE siso_galpoes
     SET printnode_account_id_produto = v_conta_id
   WHERE printnode_printer_id_produto IS NOT NULL
     AND printnode_account_id_produto IS NULL;

  UPDATE siso_usuarios
     SET printnode_account_id = v_conta_id
   WHERE printnode_printer_id IS NOT NULL
     AND printnode_account_id IS NULL;

  UPDATE siso_usuarios
     SET printnode_account_id_produto = v_conta_id
   WHERE printnode_printer_id_produto IS NOT NULL
     AND printnode_account_id_produto IS NULL;

  -- Single source of truth agora é siso_printnode_contas
  DELETE FROM siso_configuracoes WHERE chave = 'PRINTNODE_API_KEY';

  RAISE NOTICE 'PrintNode multi-key: migração concluída (conta_id=%, key migrada de siso_configuracoes pra siso_printnode_contas).', v_conta_id;
END $$;
