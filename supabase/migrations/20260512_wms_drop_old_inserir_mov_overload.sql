-- ─── Fix ambiguidade de overload do RPC wms_inserir_movimentacao ──────────
-- O banco tinha 2 overloads (16 args legado + 17 args com p_criado_em).
-- Quando o cliente passa p_criado_em=null, o PG não consegue desambiguar
-- ("Could not choose a best candidate function").
--
-- Solução: dropar o overload de 16 args. O de 17 args com p_criado_em
-- DEFAULT NULL resolve callers antigos sem mudança.
--
-- Validado: wms_reservar_atomico (único caller interno) chama com 16 args
-- e vai cair no overload de 17 com p_criado_em=DEFAULT automaticamente.
-- ──────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.wms_inserir_movimentacao(
  uuid, uuid, uuid, uuid, character, numeric, text, text, jsonb,
  uuid, timestamptz, bigint, numeric, uuid, text, uuid
);
