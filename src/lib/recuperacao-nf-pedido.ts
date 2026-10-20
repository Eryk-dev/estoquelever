import { createServiceClient } from "./supabase-server";
import { getEmpresaByCnpj } from "./empresa-lookup";
import { getPedido, type TinyNotaFiscal } from "./tiny-api";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { getMlShipmentRecuperacao, type MlShipmentRecuperacao } from "./ml-api";
import { processWebhookWms } from "./webhook-processor-wms";
import { isMercadoLivre } from "./domain-helpers";

const TIPO = "recuperacao_nf_pedido";
const LEASE_MS = 10 * 60 * 1000;

/**
 * ready_to_ship também inclui picked_up/in_hub (já coletado).
 * Aceitar só substatus anteriores à coleta, com remetente e logística conhecidos.
 */
export function envioPermiteRecuperacao(
  envio: MlShipmentRecuperacao | null,
  sellerId: number,
): boolean {
  if (!envio || envio.sender_id !== sellerId || !Number.isSafeInteger(envio.id) || envio.id <= 0) return false;
  const logistica = envio.logistic_type ?? envio.logistic?.type;
  if (!["cross_docking", "xd_drop_off", "drop_off", "self_service"].includes(logistica ?? "")) return false;
  if (["date_shipped", "date_delivered", "date_not_delivered", "date_returned", "date_cancelled"]
    .some((campo) => envio.status_history?.[campo])) return false;
  return envio.status === "ready_to_ship" &&
    ["ready_to_print", "printed", "invoice_pending"].includes(envio.substatus ?? "");
}

export interface NfRecuperacaoInput {
  empresaId: string;
  cnpj: string;
  nf: TinyNotaFiscal;
  urlDanfe?: string;
}

/**
 * A NF autorizada permite encontrar a venda mesmo depois que ela saiu de
 * "aprovado" no Tiny. Não emite NF e não importa envios encerrados ou Full.
 * O log exclusivo por pedido serializa webhook × polling e permite retry.
 */
export async function recuperarPedidoPorNf(input: NfRecuperacaoInput): Promise<string | null> {
  const { nf, empresaId, cnpj } = input;
  if (![6, 7].includes(Number(nf.situacao)) ||
      nf.origem?.tipo !== "venda" || !nf.origem.id ||
      !/^\d{44}$/.test(nf.chaveAcesso ?? "")) return null;

  const sb = createServiceClient();
  const pedidoId = String(nf.origem.id);
  const { data: existente, error: erroExistente } = await sb.from("siso_pedidos")
    .select("id, empresa_origem_id, payload_original")
    .eq("id", pedidoId).maybeSingle();
  if (erroExistente) throw erroExistente;
  if (existente && existente.empresa_origem_id !== empresaId) throw new Error("Empresa do pedido diverge da NF");
  // Só retomar gravação parcial feita por este método. Nunca reabrir pedidos operados.
  const retomar = existente?.payload_original?.recuperacao_nf_pendente === String(nf.id);
  if (existente && !retomar) return pedidoId;

  const empresa = await getEmpresaByCnpj(cnpj);
  if (!empresa || empresa.empresaId !== empresaId) throw new Error("Empresa da NF não encontrada ou inativa");
  if (/bellator/i.test(empresa.empresaNome ?? "")) return null;
  const { data: conn, error: erroConn } = await sb.from("siso_ml_connections")
    .select("id, ml_user_id").eq("empresa_id", empresaId).eq("ativo", true).maybeSingle();
  if (erroConn) throw erroConn;
  if (!conn) return null;
  const { token } = await getValidTokenByEmpresa(empresaId);
  const pedido = await runWithEmpresa(empresaId, () => getPedido(token, pedidoId));
  if (pedido.id !== pedidoId) throw new Error("Pedido retornado pelo Tiny diverge da origem da NF");
  if (!isMercadoLivre(pedido.nomeEcommerce) || !/^\d+$/.test(pedido.idPedidoEcommerce ?? "")) return null;
  const envio = await getMlShipmentRecuperacao(conn.id, pedido.idPedidoEcommerce!);
  if (!envioPermiteRecuperacao(envio, Number(conn.ml_user_id))) return null;

  // Um carrinho pode chegar como pack_id ou order_id: o shipment evita duplicá-lo.
  const { data: duplicados, error: erroDuplicados } = await sb.from("siso_pedidos")
    .select("id").eq("empresa_origem_id", empresaId).neq("id", pedidoId)
    .or(`id_pedido_ecommerce.eq.${pedido.idPedidoEcommerce},ml_shipment_id.eq.${envio!.id}`)
    .limit(1);
  if (erroDuplicados) throw erroDuplicados;
  if (duplicados?.length) return null;

  const agora = new Date().toISOString();
  const { data: novoLog, error: erroLog } = await sb.from("siso_webhook_logs").insert({
    tiny_pedido_id: pedidoId, empresa_id: empresaId, cnpj, tipo: TIPO,
    codigo_situacao: "nf_autorizada", status: "processando",
    payload: { nota_fiscal_id: nf.id, ml_shipment_id: envio!.id },
    criado_em: agora,
  }).select("id").single();
  let logId: string;
  if (erroLog) {
    if (erroLog.code !== "23505") throw erroLog;
    const { data: anterior, error } = await sb.from("siso_webhook_logs")
      .select("id, status, criado_em").eq("tipo", TIPO).eq("tiny_pedido_id", pedidoId).maybeSingle();
    if (error) throw error;
    if (!anterior || (anterior.status !== "erro" &&
        !(anterior.status === "processando" && Date.parse(anterior.criado_em) < Date.now() - LEASE_MS))) return null;
    const { data: claim, error: claimError } = await sb.from("siso_webhook_logs")
      .update({ status: "processando", criado_em: agora, erro: null, processado_em: null })
      .eq("id", anterior.id).eq("status", anterior.status).eq("criado_em", anterior.criado_em)
      .select("id").maybeSingle();
    if (claimError) throw claimError;
    if (!claim) return null;
    logId = claim.id;
  } else {
    logId = novoLog.id;
  }
  try {
    await processWebhookWms({
      webhookLogId: logId, pedido, empresaOrigemId: empresaId,
      galpaoOrigemId: empresa.galpaoId, galpaoOrigemNome: empresa.galpaoNome,
      recuperacaoNf: {
        id: String(nf.id), chaveAcesso: nf.chaveAcesso!,
        urlDanfe: input.urlDanfe, shipmentId: String(envio!.id), retomar,
      },
    });
    return pedidoId;
  } catch (err) {
    await sb.from("siso_webhook_logs").update({
      status: "erro", erro: err instanceof Error ? err.message : String(err),
    }).eq("id", logId);
    throw err;
  }
}
