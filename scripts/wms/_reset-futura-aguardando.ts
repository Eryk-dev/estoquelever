/**
 * One-off: volta TODOS os pedidos da pista FUTURA pra `aguardando_separacao`
 * ("Para separar"), revertendo qualquer pick/encaixotamento feito em teste.
 *
 * Replica o caminho BACKWARD do endpoint /api/wms/separacao/voltar-etapa
 * (mesmos helpers testados): estorna a S do pick + recria a R + reverte o
 * cutover (estoque_lancado=false). Além disso limpa as colunas novas de
 * encaixotamento (quantidade_encaixotada / encaixotado_em) que o helper de
 * reset não conhece.
 *
 * Idempotente: re-rodar não faz nada (alvo vazio). Pedidos com status NULL
 * ficam de fora (não estão em fila de separação).
 *
 * Rodar: tsx scripts/wms/_reset-futura-aguardando.ts
 */

import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { resetarEstadoSeparacaoItens } from "../../src/lib/separacao/reset-state";
import { reverterCutoverSeRetrocedeu } from "../../src/lib/wms/cutover";

const USUARIO_ID = "d1330e92-699d-4530-a079-6103bb0435bf"; // Eryk (admin)

async function main() {
  const sb = createServiceClient();

  // 1. Alvo: pedidos futura fora de aguardando_separacao (status não-nulo).
  const { data: alvos, error } = await sb
    .from("siso_pedidos")
    .select("id, status_separacao")
    .eq("separacao_futura", true)
    .not("status_separacao", "is", null)
    .neq("status_separacao", "aguardando_separacao");
  if (error) throw error;

  const ids = (alvos ?? []).map((p) => p.id as string);
  const porStatus = (alvos ?? []).reduce<Record<string, number>>((acc, p) => {
    const s = p.status_separacao as string;
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Alvo: ${ids.length} pedidos futura → aguardando_separacao`, porStatus);
  if (ids.length === 0) {
    console.log("Nada a fazer.");
    return;
  }

  // 2. Status + limpa timestamps das etapas posteriores (igual voltar-etapa backward).
  const { error: upErr } = await sb
    .from("siso_pedidos")
    .update({
      status_separacao: "aguardando_separacao",
      separacao_iniciada_em: null,
      separacao_concluida_em: null,
      separacao_operador_id: null,
      embalagem_concluida_em: null,
      conferido_por: null,
      conferido_em: null,
      divergencia_tipo: null,
      divergencia_obs: null,
      embalado_real_por: null,
      embalado_real_em: null,
      encaixotado_em: null,
    })
    .in("id", ids);
  if (upErr) throw upErr;

  // 3. Limpa o encaixotamento por item (coluna nova, fora do helper de reset).
  const { data: itensRaw } = await sb
    .from("siso_pedido_itens")
    .select("id")
    .in("pedido_id", ids);
  const itemIds = (itensRaw ?? []).map((i) => i.id as number);
  await sb
    .from("siso_pedido_itens")
    .update({ quantidade_encaixotada: 0 })
    .in("pedido_id", ids);

  // 4. Estorna a S do pick + recria a R (SEP-06). No-op pros itens sem pick.
  const reset = await resetarEstadoSeparacaoItens({
    supabase: sb,
    itemIds,
    usuarioId: USUARIO_ID,
    motivo: "voltar_etapa",
    recriarReservas: true,
  });
  console.log("Reset de itens:", reset);

  // 5. Reverte o cutover (estorna S residual + flip estoque_lancado=false) por pedido.
  let revertidos = 0;
  const falhas: string[] = [];
  for (const id of ids) {
    const r = await reverterCutoverSeRetrocedeu(id, "aguardando_separacao", "voltar_etapa", USUARIO_ID).catch(
      () => ({ reverted: false, motivo: "rpc_error" as const }),
    );
    if (r.reverted) revertidos++;
    if (r.motivo === "rpc_error") falhas.push(id);
  }
  console.log(`Cutover revertido em ${revertidos} pedidos. Falhas RPC: ${falhas.length}`, falhas);

  // 6. Verificação final.
  const { count: aindaFora } = await sb
    .from("siso_pedidos")
    .select("*", { count: "exact", head: true })
    .eq("separacao_futura", true)
    .not("status_separacao", "is", null)
    .neq("status_separacao", "aguardando_separacao");
  console.log(`✔ Pedidos futura ainda fora de aguardando_separacao: ${aindaFora ?? "?"}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERRO:", e);
    process.exit(1);
  });
