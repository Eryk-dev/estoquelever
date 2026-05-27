import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { estornarMovimentacao } from "./ledger";
import { liberarReserva } from "./reservas";
import { registrarEvento } from "@/lib/historico-service";

/**
 * P3 #7.13 — cancela uma venda manual.
 *
 * Casos:
 *   - Venda em status_separacao='aguardando_separacao'|'aguardando_compra'
 *     (modo separação ainda não picada): libera reservas R (se houver),
 *     marca pedido como 'cancelado'.
 *   - Venda em status='concluido' com movs de baixa_direta (modo baixa
 *     direta): estorna cada mov S, marca pedido como 'cancelado'.
 *   - Venda em separação ativa ('em_separacao', 'separado', 'embalado'):
 *     400 — operador precisa primeiro usar /separacao/voltar-etapa pra
 *     reverter os picks (preserva auditoria).
 *   - Pedido já 'cancelado': retorna { movsEstornadas: 0, reservasLiberadas: 0 }
 *     (idempotente).
 *
 * Nota: `siso_pedidos.id` é text ('MAN-...'). Em modo baixa_direta as movs
 * são gravadas com `origem_id=uuid_aleatorio` + `origem_detalhes.pedido_id_manual=MAN-...`
 * (não em `pedido_id`), então a busca de movs estornáveis acontece via
 * filtro JSONB no `origem_detalhes->>'pedido_id_manual'`.
 */
export async function cancelarVendaManual(input: {
  pedido_id: string;
  usuario_id: string;
  motivo: string;
}): Promise<{ movsEstornadas: number; reservasLiberadas: number }> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do cancelamento é obrigatório (≥3 caracteres)");
  }

  const sb = createServiceClient();

  const { data: pedido, error: pedErr } = await sb
    .from("siso_pedidos")
    .select("id, status, status_separacao")
    .eq("id", input.pedido_id)
    .maybeSingle();
  if (pedErr) {
    throw new Error(`falha lendo pedido: ${pedErr.message}`);
  }
  if (!pedido) {
    throw new Error("pedido não encontrado");
  }
  const p = pedido as {
    id: string;
    status: string;
    status_separacao: string | null;
  };

  // Idempotente: já cancelado
  if (p.status === "cancelado") {
    return { movsEstornadas: 0, reservasLiberadas: 0 };
  }

  // Bloqueia separação ativa — operador precisa voltar etapa antes
  if (["em_separacao", "separado", "embalado"].includes(p.status_separacao ?? "")) {
    throw new Error(
      "pedido em separação ativa — use voltar-etapa antes de cancelar (preserva auditoria de picks)",
    );
  }

  let movsEstornadas = 0;
  let reservasLiberadas = 0;

  // Caminho 1: separação ainda não iniciada — libera R se existirem.
  if (
    p.status_separacao === "aguardando_separacao" ||
    p.status_separacao === "aguardando_compra"
  ) {
    try {
      reservasLiberadas = await liberarReserva({
        pedido_id: input.pedido_id,
        motivo: "cancelamento",
        usuario_id: input.usuario_id,
      });
    } catch (err) {
      // Se falhar a liberação, propaga o erro pra não silenciar inconsistência.
      logger.error("wms.vendas.cancelar", "falha ao liberar reservas", {
        pedido_id: input.pedido_id,
        erro: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Caminho 2: baixa direta — estorna movs S origem_tipo='venda_manual'.
  // Match pelo tag origem_detalhes.pedido_id_manual (siso_pedidos.id é
  // text 'MAN-...', não cabe em siso_movimentacoes.pedido_id na escrita
  // atual do endpoint vendas/criar).
  const { data: movsVenda, error: movsErr } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("origem_tipo", "venda_manual")
    .eq("tipo", "S")
    .filter("origem_detalhes->>pedido_id_manual", "eq", input.pedido_id);
  if (movsErr) {
    throw new Error(`falha lendo movs de venda: ${movsErr.message}`);
  }

  for (const m of (movsVenda ?? []) as Array<{ id: string }>) {
    try {
      await estornarMovimentacao({
        mov_id: m.id,
        usuario_id: input.usuario_id,
        motivo: `Cancelamento venda manual: ${input.motivo}`,
      });
      movsEstornadas++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Idempotência: re-cancelamento encontra mov já estornada
      if (/já foi estornada|já é um estorno/i.test(msg)) {
        continue;
      }
      throw err;
    }
  }

  // Marca pedido cancelado. siso_pedidos não tem cancelado_em — só seta status.
  const { error: updErr } = await sb
    .from("siso_pedidos")
    .update({ status: "cancelado" })
    .eq("id", input.pedido_id);
  if (updErr) {
    throw new Error(`falha ao atualizar status: ${updErr.message}`);
  }

  // Audit fire-and-forget
  registrarEvento({
    pedidoId: input.pedido_id,
    evento: "cancelado",
    usuarioId: input.usuario_id,
    detalhes: {
      motivo: input.motivo,
      movs_estornadas: movsEstornadas,
      reservas_liberadas: reservasLiberadas,
      origem: "cancelarVendaManual",
    },
  }).catch(() => {
    /* fire-and-forget */
  });

  return { movsEstornadas, reservasLiberadas };
}
