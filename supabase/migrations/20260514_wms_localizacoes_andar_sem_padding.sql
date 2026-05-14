-- Alinha formato dos códigos de localização com as etiquetas físicas:
-- 3º segmento (andar) sem padding de zero quando 1 dígito.
-- Antes: 'A-01-01' .. 'A-01-09' / 'A-01-10'
-- Depois: 'A-01-1'  .. 'A-01-9'  / 'A-01-10' (≥10 fica natural)
--
-- Prédio (2º segmento) mantém padding 2-dígitos porque vai até 33 e
-- precisa de largura consistente.
--
-- Locs especiais (DEFAULT-PICKING, RECEBIMENTO, QUARENTENA) ficam intactas.

UPDATE siso_localizacoes
SET codigo = split_part(codigo,'-',1)
          || '-' || split_part(codigo,'-',2)
          || '-' || ((split_part(codigo,'-',3))::int)::text
WHERE tipo NOT IN ('recebimento','expedicao','quarentena')
  AND codigo ~ '^[A-Z0-9]+-[0-9]+-0[1-9]$';
