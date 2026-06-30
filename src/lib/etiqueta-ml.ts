/**
 * Recuperação de etiqueta de envio DIRETO do Mercado Livre (bypassa o Tiny).
 *
 * Vendas Mercado Envios geram a etiqueta no próprio ML. Em alguns canais (ex.:
 * EasyPeasy) o pedido despacha SEM nota fiscal nem agrupamento no Tiny — então
 * todo o caminho de etiqueta via Tiny (agrupamento → expedição → ZPL) fica
 * gated e nunca produz a etiqueta. Aqui buscamos o ZPL direto do ML.
 *
 * Cobre dois cenários:
 *   1. ML já marcou a NF como "expedida" no Tiny (`criarAgrupamento` falha com
 *      "já foi expedida") → chamado por `agrupamento-service.tratarNfJaExpedida`.
 *   2. Pedido ML SEM NF e SEM agrupamento → fallback do caminho de impressão
 *      (`etiqueta-service.resolverZplFallback`) e do retry manual de etiqueta.
 *
 * É no-op (retorna null) quando o pedido não é ML, não tem order id, ou a
 * empresa não tem conexão ML ativa. Idempotente: se já há ZPL cacheado, devolve
 * o cacheado sem tocar o ML.
 */

import { createServiceClient } from "@/lib/supabase-server";
import {
  getActiveMlConnectionForEmpresa,
  obterEtiquetaZplShipment,
} from "@/lib/ml-api";
import { montarBarcodesEtiqueta } from "@/lib/etiqueta-barcode";
import { extrairBarcodesDoRaster } from "@/lib/etiqueta-barcode-raster";
import { isMercadoLivre } from "@/lib/domain-helpers";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "etiqueta-ml";

/**
 * Busca a etiqueta ZPL direto do Mercado Livre e cacheia no pedido (etiqueta_zpl
 * + barcodes da conferência + status 'pendente'). Retorna o ZPL quando recuperou
 * (ou já havia cacheado), ou null quando não é aplicável / o ML não tem etiqueta
 * imprimível (ex.: shipment `buffered` — segurado pela separação futura).
 */
export async function recuperarEtiquetaViaMl(
  pedidoId: string,
): Promise<string | null> {
  const supabase = createServiceClient();

  const { data: p } = await supabase
    .from("siso_pedidos")
    .select("id_pedido_ecommerce, nome_ecommerce, empresa_origem_id, etiqueta_zpl")
    .eq("id", pedidoId)
    .maybeSingle();

  if (!p) return null;
  if (p.etiqueta_zpl) return p.etiqueta_zpl as string; // já cacheada
  if (
    !isMercadoLivre(p.nome_ecommerce) ||
    !p.id_pedido_ecommerce ||
    !p.empresa_origem_id
  ) {
    return null;
  }

  const connId = await getActiveMlConnectionForEmpresa(p.empresa_origem_id);
  if (!connId) return null;

  const res = await obterEtiquetaZplShipment(connId, String(p.id_pedido_ecommerce));
  if (!res?.zpl) return null;

  const doRaster = await extrairBarcodesDoRaster(res.zpl);
  const barcodes = montarBarcodesEtiqueta(res.zpl, [res.trackingNumber, ...doRaster]);

  await supabase
    .from("siso_pedidos")
    .update({
      etiqueta_zpl: res.zpl,
      ...(barcodes.length > 0 ? { etiqueta_barcodes: barcodes } : {}),
    })
    .eq("id", pedidoId);

  // Status via RPC (a coluna etiqueta_status tem quirk de schema-cache no
  // PostgREST). Best-effort: o ZPL já está cacheado mesmo se o status não subir.
  await supabase
    .rpc("siso_set_etiqueta_status", { p_pedido_id: pedidoId, p_status: "pendente" })
    .then(
      () => {},
      () => {},
    );

  logger.info(LOG_SOURCE, "Etiqueta recuperada via ML (sem rota Tiny)", {
    pedidoId,
    shipmentId: String(res.shipmentId),
  });
  return res.zpl;
}
