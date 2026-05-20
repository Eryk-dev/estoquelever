import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";

// ─── Tipos ────────────────────────────────────────────────────────────────

export interface CriarTransferenciaInput {
  galpao_origem_id: string;
  galpao_destino_id: string;
  itens: Array<{
    produto_id: string;
    localizacao_origem_id: string;
    qty: number;
  }>;
  observacoes?: string;
  usuario_id: string;
}

export interface ReceberTransferenciaInput {
  transferencia_id: string;
  itens: Array<{
    transferencia_item_id: string;
    localizacao_destino_id: string;
  }>;
  usuario_id: string;
}

export type StatusTransferencia = "em_transito" | "recebida" | "cancelada";

interface TransferenciaItemRow {
  id: string;
  produto_id: string;
  localizacao_origem_id: string;
  qty: number;
  localizacao_destino_id: string | null;
  mov_saida_id: string | null;
  mov_entrada_id: string | null;
  mov_estorno_id: string | null;
  produto?: { sku: string; descricao: string };
  localizacao_origem?: { codigo: string };
  localizacao_destino?: { codigo: string } | null;
}

interface TransferenciaRow {
  id: string;
  galpao_origem_id: string;
  galpao_destino_id: string;
  status: StatusTransferencia;
  criada_em: string;
  recebida_em: string | null;
  cancelada_em: string | null;
  observacoes: string | null;
  galpao_origem?: { nome: string };
  galpao_destino?: { nome: string };
  criada_por_user?: { nome: string };
  itens?: TransferenciaItemRow[];
}

// ─── Criar ────────────────────────────────────────────────────────────────

/**
 * Cria transferência inter-galpão. Em 3D, par S+E NEUTRO (sem empresa) —
 * estoque migra dum galpão pra outro sem carregar dona.
 */
export async function criarTransferencia(
  input: CriarTransferenciaInput,
): Promise<{ id: string }> {
  if (input.galpao_origem_id === input.galpao_destino_id) {
    throw new Error(
      "transferência inter-galpão exige galpões diferentes (use realocação)",
    );
  }
  if (!input.itens.length) {
    throw new Error("transferência sem itens");
  }
  const sb = createServiceClient();

  // 1) Insere header
  const { data: header, error: errHeader } = await sb
    .from("siso_transferencias_galpao")
    .insert({
      galpao_origem_id: input.galpao_origem_id,
      galpao_destino_id: input.galpao_destino_id,
      criada_por: input.usuario_id,
      observacoes: input.observacoes ?? null,
    })
    .select("id")
    .single();
  if (errHeader || !header) throw errHeader ?? new Error("falha ao criar header");
  const transferenciaId = (header as { id: string }).id;

  // 2) Pra cada item: gera SAÍDA na origem (estoque sai) + insere row
  // Se qualquer movimento falhar (saldo insuficiente), reverte tudo: estornar
  // movs já criadas, deletar itens, deletar header.
  const itensCriados: Array<{ item_id: string; mov_id: string }> = [];
  try {
    for (const item of input.itens) {
      // Insere row do item primeiro (pra ter o id pro mov.origem_id)
      const { data: itemRow, error: errItem } = await sb
        .from("siso_transferencia_galpao_itens")
        .insert({
          transferencia_id: transferenciaId,
          produto_id: item.produto_id,
          localizacao_origem_id: item.localizacao_origem_id,
          qty: item.qty,
        })
        .select("id")
        .single();
      if (errItem || !itemRow) throw errItem ?? new Error("falha ao criar item");
      const itemId = (itemRow as { id: string }).id;

      const mov = await inserirMovimentacao({
        tripla: {
          produto_id: item.produto_id,
          galpao_id: input.galpao_origem_id,
          localizacao_id: item.localizacao_origem_id,
        },
        tipo: "S",
        qty: item.qty,
        origem_tipo: "transferencia_galpao",
        origem_id: transferenciaId,
        usuario_id: input.usuario_id,
        motivo: input.observacoes,
      });

      await sb
        .from("siso_transferencia_galpao_itens")
        .update({ mov_saida_id: mov.id })
        .eq("id", itemId);

      itensCriados.push({ item_id: itemId, mov_id: mov.id });
    }
  } catch (e) {
    // Rollback: estorna cada saída criada
    for (const c of itensCriados) {
      try {
        const item = input.itens[itensCriados.indexOf(c)];
        await inserirMovimentacao({
          tripla: {
            produto_id: item.produto_id,
            galpao_id: input.galpao_origem_id,
            localizacao_id: item.localizacao_origem_id,
          },
          tipo: "E",
          qty: item.qty,
          origem_tipo: "estorno",
          estorno_de: c.mov_id,
          usuario_id: input.usuario_id,
          motivo: "rollback de criação de transferência",
        });
      } catch {
        // best-effort
      }
    }
    await sb
      .from("siso_transferencias_galpao")
      .delete()
      .eq("id", transferenciaId);
    throw e;
  }

  return { id: transferenciaId };
}

// ─── Listar ───────────────────────────────────────────────────────────────

export interface ListarFiltros {
  status?: StatusTransferencia;
  galpao_origem_id?: string;
  galpao_destino_id?: string;
  limit?: number;
}

export async function listarTransferencias(
  filtros: ListarFiltros = {},
): Promise<TransferenciaRow[]> {
  const sb = createServiceClient();
  let q = sb
    .from("siso_transferencias_galpao")
    .select(
      `
        id, galpao_origem_id, galpao_destino_id, status,
        criada_em, recebida_em, cancelada_em, observacoes,
        galpao_origem:siso_galpoes!galpao_origem_id(nome),
        galpao_destino:siso_galpoes!galpao_destino_id(nome),
        criada_por_user:siso_usuarios!criada_por(nome),
        itens:siso_transferencia_galpao_itens(
          id, produto_id, localizacao_origem_id, qty,
          localizacao_destino_id, mov_saida_id, mov_entrada_id, mov_estorno_id,
          produto:siso_produtos(sku, descricao),
          localizacao_origem:siso_localizacoes!localizacao_origem_id(codigo),
          localizacao_destino:siso_localizacoes!localizacao_destino_id(codigo)
        )
      `,
    )
    .order("criada_em", { ascending: false })
    .limit(filtros.limit ?? 100);

  if (filtros.status) q = q.eq("status", filtros.status);
  if (filtros.galpao_origem_id) q = q.eq("galpao_origem_id", filtros.galpao_origem_id);
  if (filtros.galpao_destino_id) q = q.eq("galpao_destino_id", filtros.galpao_destino_id);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as TransferenciaRow[];
}

export async function getTransferencia(
  id: string,
): Promise<TransferenciaRow | null> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_transferencias_galpao")
    .select(
      `
        id, galpao_origem_id, galpao_destino_id, status,
        criada_em, recebida_em, cancelada_em, observacoes,
        galpao_origem:siso_galpoes!galpao_origem_id(nome),
        galpao_destino:siso_galpoes!galpao_destino_id(nome),
        criada_por_user:siso_usuarios!criada_por(nome),
        itens:siso_transferencia_galpao_itens(
          id, produto_id, localizacao_origem_id, qty,
          localizacao_destino_id, mov_saida_id, mov_entrada_id, mov_estorno_id,
          produto:siso_produtos(sku, descricao),
          localizacao_origem:siso_localizacoes!localizacao_origem_id(codigo),
          localizacao_destino:siso_localizacoes!localizacao_destino_id(codigo)
        )
      `,
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as unknown as TransferenciaRow | null;
}

// ─── Receber ──────────────────────────────────────────────────────────────

export async function receberTransferencia(
  input: ReceberTransferenciaInput,
): Promise<void> {
  const sb = createServiceClient();

  const { data: transf, error: errHeader } = await sb
    .from("siso_transferencias_galpao")
    .select("id, status, galpao_destino_id")
    .eq("id", input.transferencia_id)
    .single();
  if (errHeader || !transf) throw new Error("transferência não encontrada");
  const t = transf as {
    id: string;
    status: StatusTransferencia;
    galpao_destino_id: string;
  };
  if (t.status !== "em_transito") {
    throw new Error(
      `transferência não está em trânsito (status: ${t.status})`,
    );
  }

  const { data: itens, error: errItens } = await sb
    .from("siso_transferencia_galpao_itens")
    .select("id, produto_id, qty, mov_entrada_id")
    .eq("transferencia_id", input.transferencia_id);
  if (errItens || !itens) throw new Error("itens não encontrados");
  type ItemRow = {
    id: string;
    produto_id: string;
    qty: number;
    mov_entrada_id: string | null;
  };
  const itensMap = new Map(
    ((itens ?? []) as ItemRow[]).map((i) => [i.id, i]),
  );

  // Valida que veio loc destino pra TODOS os itens não-recebidos
  for (const it of itens as ItemRow[]) {
    if (it.mov_entrada_id) continue;
    const sel = input.itens.find((x) => x.transferencia_item_id === it.id);
    if (!sel) {
      throw new Error(
        `localização de destino faltando pra item ${it.id}`,
      );
    }
  }

  // Pra cada item informado: gera entrada na loc destino
  for (const sel of input.itens) {
    const item = itensMap.get(sel.transferencia_item_id);
    if (!item) throw new Error(`item ${sel.transferencia_item_id} não pertence à transferência`);
    if (item.mov_entrada_id) continue; // já recebido — idempotência

    const mov = await inserirMovimentacao({
      tripla: {
        produto_id: item.produto_id,
        galpao_id: t.galpao_destino_id,
        localizacao_id: sel.localizacao_destino_id,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: "transferencia_galpao",
      origem_id: t.id,
      usuario_id: input.usuario_id,
      motivo: "recebimento de transferência inter-galpão",
    });
    await sb
      .from("siso_transferencia_galpao_itens")
      .update({
        localizacao_destino_id: sel.localizacao_destino_id,
        mov_entrada_id: mov.id,
      })
      .eq("id", sel.transferencia_item_id);
  }

  await sb
    .from("siso_transferencias_galpao")
    .update({
      status: "recebida",
      recebida_por: input.usuario_id,
      recebida_em: new Date().toISOString(),
    })
    .eq("id", t.id);
}

// ─── Cancelar ─────────────────────────────────────────────────────────────

export async function cancelarTransferencia(
  transferenciaId: string,
  usuarioId: string,
): Promise<void> {
  const sb = createServiceClient();
  const { data: transf, error } = await sb
    .from("siso_transferencias_galpao")
    .select("id, status, galpao_origem_id")
    .eq("id", transferenciaId)
    .single();
  if (error || !transf) throw new Error("transferência não encontrada");
  const t = transf as {
    id: string;
    status: StatusTransferencia;
    galpao_origem_id: string;
  };
  if (t.status !== "em_transito") {
    throw new Error(
      `só transferências em trânsito podem ser canceladas (status: ${t.status})`,
    );
  }

  const { data: itens } = await sb
    .from("siso_transferencia_galpao_itens")
    .select(
      "id, produto_id, qty, localizacao_origem_id, mov_saida_id, mov_estorno_id",
    )
    .eq("transferencia_id", transferenciaId);
  type ItemRow = {
    id: string;
    produto_id: string;
    qty: number;
    localizacao_origem_id: string;
    mov_saida_id: string | null;
    mov_estorno_id: string | null;
  };
  for (const it of (itens ?? []) as ItemRow[]) {
    if (it.mov_estorno_id || !it.mov_saida_id) continue;
    const mov = await inserirMovimentacao({
      tripla: {
        produto_id: it.produto_id,
        galpao_id: t.galpao_origem_id,
        localizacao_id: it.localizacao_origem_id,
      },
      tipo: "E",
      qty: it.qty,
      origem_tipo: "estorno",
      estorno_de: it.mov_saida_id,
      usuario_id: usuarioId,
      motivo: "cancelamento de transferência inter-galpão",
    });
    await sb
      .from("siso_transferencia_galpao_itens")
      .update({ mov_estorno_id: mov.id })
      .eq("id", it.id);
  }

  await sb
    .from("siso_transferencias_galpao")
    .update({
      status: "cancelada",
      cancelada_por: usuarioId,
      cancelada_em: new Date().toISOString(),
    })
    .eq("id", transferenciaId);
}
