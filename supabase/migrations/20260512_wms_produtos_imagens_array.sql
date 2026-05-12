-- Adiciona array de imagens em siso_produtos.
-- imagem_url permanece como capa (imagens[1]) pra backwards compat com
-- list views que carregam só a primeira via SELECT antigo.
ALTER TABLE siso_produtos
  ADD COLUMN IF NOT EXISTS imagens text[] NOT NULL DEFAULT '{}';

-- Backfill inicial: produtos que já tem imagem_url ganham array de 1
-- elemento. Vão ser sobrescritos quando o sync com Tiny rodar de novo e
-- trouxer a lista completa de anexos.
UPDATE siso_produtos
   SET imagens = ARRAY[imagem_url]
 WHERE imagem_url IS NOT NULL
   AND (imagens IS NULL OR array_length(imagens, 1) IS NULL);

COMMENT ON COLUMN siso_produtos.imagens IS 'URLs de todos os anexos do produto no Tiny (mlstatic etc). imagens[1] = capa (espelha imagem_url).';
