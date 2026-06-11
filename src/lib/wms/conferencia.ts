/**
 * Conferência de embalagem — resolução do bip da etiqueta de envio.
 *
 * O operador bipa o barcode da etiqueta (ML: shipment/QR do ZPL; Shopee:
 * codigoRastreio; DANFE: chave NF 44 dígitos) e precisamos achar o pedido.
 *
 * Cadeia de matching (mais forte → mais fraco):
 *   1. etiqueta_barcodes @> [codigo]  (extraídos do ZPL + rastreio Tiny)
 *   2. chave_acesso_nf = codigo       (quando é 44 dígitos — DANFE)
 *   3. id_pedido_ecommerce = codigo   (nº do pedido ML/Shopee impresso na etiqueta)
 *   4. etiqueta_zpl ILIKE %codigo%    (etiquetas antigas sem barcodes; self-heal)
 */

import type { createServiceClient } from "@/lib/supabase-server";
import { montarBarcodesEtiqueta } from "@/lib/etiqueta-barcode";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "conferencia";

type SupabaseClient = ReturnType<typeof createServiceClient>;

export const PEDIDO_CONFERENCIA_SELECT =
  "id, numero, nome_ecommerce, id_pedido_ecommerce, status_separacao, " +
  "embalado_real_por, embalado_real_em, conferido_por, conferido_em, " +
  "divergencia_tipo, divergencia_obs, empresa_origem_id, separacao_galpao_id, etiqueta_zpl";

export interface PedidoConferencia {
  id: string;
  numero: string | null;
  nome_ecommerce: string | null;
  id_pedido_ecommerce: string | null;
  status_separacao: string | null;
  embalado_real_por: string | null;
  embalado_real_em: string | null;
  conferido_por: string | null;
  conferido_em: string | null;
  divergencia_tipo: string | null;
  divergencia_obs: string | null;
  empresa_origem_id: string | null;
  separacao_galpao_id: string | null;
  etiqueta_zpl: string | null;
}

export type ViaResolucao = "barcode" | "chave_nf" | "pedido_ecommerce" | "zpl_self_heal";

export type ResolverResultado =
  | { ok: true; pedido: PedidoConferencia; via: ViaResolucao }
  | { ok: false; erro: "codigo_vazio" | "nao_encontrado" | "ambiguo" };

/** Chave de acesso de NF-e: exatamente 44 dígitos. */
export function ehChaveNf(codigo: string): boolean {
  return /^\d{44}$/.test(codigo);
}

/** Escapa curingas de LIKE/ILIKE (% _ \) pro fallback no ZPL bruto. */
export function escaparLike(codigo: string): string {
  return codigo.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function resolverPedidoPorBarcode(
  supabase: SupabaseClient,
  codigoRaw: string,
): Promise<ResolverResultado> {
  const codigo = (codigoRaw ?? "").trim();
  if (codigo.length < 4) return { ok: false, erro: "codigo_vazio" };

  // 1. Match exato no array de barcodes
  const { data: porBarcode } = await supabase
    .from("siso_pedidos")
    .select(PEDIDO_CONFERENCIA_SELECT)
    .contains("etiqueta_barcodes", [codigo])
    .limit(2)
    .returns<PedidoConferencia[]>();
  if (porBarcode && porBarcode.length === 1) {
    return { ok: true, pedido: porBarcode[0], via: "barcode" };
  }
  if (porBarcode && porBarcode.length > 1) return { ok: false, erro: "ambiguo" };

  // 2. Chave NF (DANFE)
  if (ehChaveNf(codigo)) {
    const { data: porChave } = await supabase
      .from("siso_pedidos")
      .select(PEDIDO_CONFERENCIA_SELECT)
      .eq("chave_acesso_nf", codigo)
      .limit(2)
      .returns<PedidoConferencia[]>();
    if (porChave && porChave.length === 1) {
      return { ok: true, pedido: porChave[0], via: "chave_nf" };
    }
    if (porChave && porChave.length > 1) return { ok: false, erro: "ambiguo" };
  }

  // 3. Nº do pedido no marketplace (escopo: pedidos na bancada, evita casar
  //    pedido antigo do mesmo comprador)
  const { data: porEcommerce } = await supabase
    .from("siso_pedidos")
    .select(PEDIDO_CONFERENCIA_SELECT)
    .eq("id_pedido_ecommerce", codigo)
    .in("status_separacao", ["separado", "embalado", "conferido"])
    .limit(2)
    .returns<PedidoConferencia[]>();
  if (porEcommerce && porEcommerce.length === 1) {
    return { ok: true, pedido: porEcommerce[0], via: "pedido_ecommerce" };
  }
  if (porEcommerce && porEcommerce.length > 1) return { ok: false, erro: "ambiguo" };

  // 4. Fallback: etiqueta antiga sem etiqueta_barcodes — procura o código no
  //    ZPL bruto (janela 30d) e se acha, self-heal: persiste os barcodes.
  const corte = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: porZpl } = await supabase
    .from("siso_pedidos")
    .select(PEDIDO_CONFERENCIA_SELECT)
    .ilike("etiqueta_zpl", `%${escaparLike(codigo)}%`)
    .in("status_separacao", ["separado", "embalado", "conferido"])
    .gte("criado_em", corte)
    .limit(2)
    .returns<PedidoConferencia[]>();
  if (porZpl && porZpl.length === 1) {
    const pedido = porZpl[0];
    const barcodes = montarBarcodesEtiqueta(pedido.etiqueta_zpl, [codigo]);
    supabase
      .from("siso_pedidos")
      .update({ etiqueta_barcodes: barcodes })
      .eq("id", pedido.id)
      .then(({ error }) => {
        if (error) {
          logger.warn(LOG_SOURCE, "Self-heal de etiqueta_barcodes falhou", {
            pedidoId: pedido.id,
            error: error.message,
          });
        }
      });
    return { ok: true, pedido, via: "zpl_self_heal" };
  }
  if (porZpl && porZpl.length > 1) return { ok: false, erro: "ambiguo" };

  return { ok: false, erro: "nao_encontrado" };
}
