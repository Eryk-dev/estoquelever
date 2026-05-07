-- =====================================================================
-- CROSS MODULE — catálogo de produtos, OEMs, veículos, telemetria
-- Spec: docs/superpowers/specs/2026-05-06-cross-module-design.md
-- =====================================================================

-- Extensão necessária para busca por nome com similaridade trigram
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------
-- siso_produtos_catalogo: cache desnormalizado por SKU
-- ---------------------------------------------------------------------
CREATE TABLE siso_produtos_catalogo (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku               text NOT NULL UNIQUE,
  tiny_id           bigint UNIQUE,
  nome              text NOT NULL,
  descricao         text,
  fornecedor        text,
  marca             text,
  imagem_url        text,
  gtin              text,
  oem               text[] NOT NULL DEFAULT '{}',
  compatibility_v2  jsonb NOT NULL DEFAULT '{}'::jsonb,
  sincronizado_em   timestamptz,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_produtos_catalogo_oem_gin ON siso_produtos_catalogo USING gin (oem);
CREATE INDEX idx_produtos_catalogo_nome_trgm ON siso_produtos_catalogo USING gin (nome gin_trgm_ops);
CREATE INDEX idx_produtos_catalogo_sku_trgm ON siso_produtos_catalogo USING gin (sku gin_trgm_ops);

COMMENT ON TABLE siso_produtos_catalogo IS 'Cache de produtos do Tiny para o módulo Cross. Coluna oem e compatibility_v2 são denormalizados de siso_produto_oems e siso_produto_veiculos via triggers.';

-- ---------------------------------------------------------------------
-- siso_produto_oems: fonte de verdade dos códigos OEM
-- ---------------------------------------------------------------------
CREATE TABLE siso_produto_oems (
  id              bigserial PRIMARY KEY,
  produto_sku     text NOT NULL REFERENCES siso_produtos_catalogo(sku) ON DELETE CASCADE,
  oem_code        text NOT NULL,
  origem          text NOT NULL CHECK (origem IN ('extracao_tiny','manual')),
  adicionado_por  uuid REFERENCES siso_usuarios(id),
  adicionado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_sku, oem_code)
);

CREATE INDEX idx_produto_oems_oem ON siso_produto_oems(oem_code);

COMMENT ON TABLE siso_produto_oems IS 'OEMs por produto. origem=extracao_tiny vem do regex sobre descrição complementar; origem=manual vem do operador via UI Cross.';

-- ---------------------------------------------------------------------
-- siso_produto_veiculos: fonte de verdade da compatibilidade veicular
-- ---------------------------------------------------------------------
CREATE TABLE siso_produto_veiculos (
  id              bigserial PRIMARY KEY,
  produto_sku     text NOT NULL REFERENCES siso_produtos_catalogo(sku) ON DELETE CASCADE,
  marca           text NOT NULL,
  modelo          text NOT NULL,
  ano_inicio      int,
  ano_fim         int,
  variante        text,
  adicionado_por  uuid REFERENCES siso_usuarios(id),
  adicionado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_sku, marca, modelo, ano_inicio, ano_fim, variante)
);

CREATE INDEX idx_produto_veiculos_marca_modelo ON siso_produto_veiculos(marca, modelo);

-- ---------------------------------------------------------------------
-- siso_cross_logs: telemetria de buscas
-- ---------------------------------------------------------------------
CREATE TABLE siso_cross_logs (
  id               bigserial PRIMARY KEY,
  query_tipo       text NOT NULL CHECK (query_tipo IN ('sku','oem','nome','auto')),
  query_texto      text NOT NULL,
  resultado_count  int NOT NULL,
  usuario_id       uuid REFERENCES siso_usuarios(id),
  criado_em        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cross_logs_criado_em ON siso_cross_logs(criado_em DESC);

-- ---------------------------------------------------------------------
-- TRIGGER: recomputa array oem em siso_produtos_catalogo
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siso_recalcular_oems_produto(p_sku text)
RETURNS void AS $$
BEGIN
  UPDATE siso_produtos_catalogo
  SET oem = COALESCE(
    (SELECT array_agg(DISTINCT oem_code ORDER BY oem_code)
     FROM siso_produto_oems
     WHERE produto_sku = p_sku),
    '{}'::text[]
  ),
  atualizado_em = now()
  WHERE sku = p_sku;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION siso_trigger_recalc_oems()
RETURNS trigger AS $$
DECLARE
  v_sku text;
BEGIN
  v_sku := COALESCE(NEW.produto_sku, OLD.produto_sku);
  PERFORM siso_recalcular_oems_produto(v_sku);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recalc_oems_after_change
AFTER INSERT OR DELETE OR UPDATE ON siso_produto_oems
FOR EACH ROW EXECUTE FUNCTION siso_trigger_recalc_oems();

-- ---------------------------------------------------------------------
-- TRIGGER: recomputa compatibility_v2 jsonb em siso_produtos_catalogo
-- Formato compatível com cross para futuras integrações:
--   { "vehicles": [{ "brand", "model", "year_start", "year_end", "variant" }] }
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siso_recalcular_veiculos_produto(p_sku text)
RETURNS void AS $$
BEGIN
  UPDATE siso_produtos_catalogo
  SET compatibility_v2 = COALESCE(
    (SELECT jsonb_build_object('vehicles', jsonb_agg(jsonb_build_object(
       'brand', marca,
       'model', modelo,
       'year_start', ano_inicio,
       'year_end', ano_fim,
       'variant', variante
     ) ORDER BY marca, modelo))
     FROM siso_produto_veiculos
     WHERE produto_sku = p_sku),
    '{"vehicles":[]}'::jsonb
  ),
  atualizado_em = now()
  WHERE sku = p_sku;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION siso_trigger_recalc_veiculos()
RETURNS trigger AS $$
DECLARE
  v_sku text;
BEGIN
  v_sku := COALESCE(NEW.produto_sku, OLD.produto_sku);
  PERFORM siso_recalcular_veiculos_produto(v_sku);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recalc_veiculos_after_change
AFTER INSERT OR DELETE OR UPDATE ON siso_produto_veiculos
FOR EACH ROW EXECUTE FUNCTION siso_trigger_recalc_veiculos();
