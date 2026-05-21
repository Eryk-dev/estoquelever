// src/lib/wms/dashboard-tarefas.ts
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recebe lista possivelmente com nulls/undefined e duplicatas; retorna
 * apenas IDs únicos, em ordem de primeira aparição.
 */
export function dedupNonNullIds(
  ids: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type Executor = {
  id: string;
  nome: string;
  foto_url: string | null;
};

/**
 * Hidrata uma lista de IDs com os dados do usuário, ignorando IDs que
 * não estão no map (usuário deletado ou inacessível). Preserva a ordem
 * de entrada.
 */
export function hidratarExecutores(
  ids: string[],
  usuarios: Map<string, Executor>,
): Executor[] {
  const out: Executor[] = [];
  for (const id of ids) {
    const u = usuarios.get(id);
    if (u) out.push(u);
  }
  return out;
}

export type DashboardTarefasResult = {
  galpao_id: string | null;
  aprovacao: { count: number };
  separacao: { count: number; executores: Executor[] };
  embalagem: { count: number; executores: Executor[] };
  guarda: { count: number; executores: Executor[] };
  compras: { aComprar: number; aReceber: number };
  inventario: { sessoesAtivas: number; executores: Executor[] };
};

/**
 * Monta o payload do quadro de tarefas pendentes da home /wms.
 *
 * Quando `galpao_id` é null, agrega de todos os galpões (modo "Todos").
 * Quando é um uuid, filtra por `separacao_galpao_id` (em pedidos),
 * `galpao_id` (em guarda/inventário). Compras é sempre global.
 */
export async function montarDashboardTarefas(
  sb: SupabaseClient,
  galpao_id: string | null,
): Promise<DashboardTarefasResult> {
  // 6 queries em paralelo. Cada uma retorna { count } e/ou ids de executores.
  const [
    aprovacaoQ,
    separacaoQ,
    embalagemQ,
    guardaQ,
    invSessoesQ,
    invOperadoresQ,
    comprasComprarQ,
    comprasReceberQ,
  ] = await Promise.all([
    // Aprovação pendente
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id", { count: "exact", head: true })
        .eq("status", "pendente");
      if (galpao_id) q = q.eq("separacao_galpao_id", galpao_id);
      return q;
    })(),

    // Separação ativa
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, status_separacao, separacao_operador_id")
        .in("status_separacao", [
          "aguardando_separacao",
          "em_separacao",
          "pendente_realocacao",
          "validacao_oc",
        ]);
      if (galpao_id) q = q.eq("separacao_galpao_id", galpao_id);
      return q;
    })(),

    // Embalagem
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, embalagem_operador_id")
        .eq("status_separacao", "separado");
      if (galpao_id) q = q.eq("separacao_galpao_id", galpao_id);
      return q;
    })(),

    // Guarda
    (() => {
      let q = sb
        .from("siso_wms_pendencias_guarda")
        .select("id, status, iniciada_por")
        .in("status", ["pendente", "em_guarda"]);
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // Inventário — sessões em andamento
    (() => {
      let q = sb
        .from("siso_inventario_sessoes")
        .select("id")
        .eq("status", "em_andamento");
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // Inventário — operadores ativos (party)
    // Filtra sessões em andamento + galpão via inner join
    (() => {
      let q = sb
        .from("siso_inventario_operadores")
        .select(
          "usuario_id, sessao:siso_inventario_sessoes!inner(id, galpao_id, status)",
        )
        .is("finalizado_em", null)
        .eq("sessao.status", "em_andamento");
      if (galpao_id) q = q.eq("sessao.galpao_id", galpao_id);
      return q;
    })(),

    // Compras — a comprar (cross-galpão)
    sb
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .eq("compra_status", "aguardando_compra"),

    // Compras — a receber (cross-galpão).
    // CHECK em siso_ordens_compra: ('aguardando_compra','comprado','parcialmente_recebido','recebido','cancelado').
    // Não há status 'aguardando_recebimento' — 'comprado' é o estado pós-compra aguardando recebimento físico.
    sb
      .from("siso_ordens_compra")
      .select("id", { count: "exact", head: true })
      .in("status", ["comprado", "parcialmente_recebido"]),
  ]);

  type SepRow = { id: string; status_separacao: string; separacao_operador_id: string | null };
  type EmbRow = { id: string; embalagem_operador_id: string | null };
  type GuardaRow = { id: string; status: string; iniciada_por: string | null };
  type InvOpRow = { usuario_id: string };

  const sepRows = (separacaoQ.data ?? []) as SepRow[];
  const embRows = (embalagemQ.data ?? []) as EmbRow[];
  const guardaRows = (guardaQ.data ?? []) as GuardaRow[];
  const invOpRows = (invOperadoresQ.data ?? []) as InvOpRow[];

  const sepIds = dedupNonNullIds(
    sepRows
      .filter((r) => r.status_separacao === "em_separacao")
      .map((r) => r.separacao_operador_id),
  );
  const embIds = dedupNonNullIds(embRows.map((r) => r.embalagem_operador_id));
  const guardaIds = dedupNonNullIds(
    guardaRows
      .filter((r) => r.status === "em_guarda")
      .map((r) => r.iniciada_por),
  );
  const invIds = dedupNonNullIds(invOpRows.map((r) => r.usuario_id));

  // Hidrata avatares em uma query única
  const allIds = dedupNonNullIds([...sepIds, ...embIds, ...guardaIds, ...invIds]);
  const usuariosMap = new Map<string, Executor>();
  if (allIds.length > 0) {
    const { data: usuarios } = await sb
      .from("siso_usuarios")
      .select("id, nome, foto_url")
      .in("id", allIds);
    for (const u of (usuarios ?? []) as Executor[]) {
      usuariosMap.set(u.id, u);
    }
  }

  return {
    galpao_id,
    aprovacao: { count: aprovacaoQ.count ?? 0 },
    separacao: {
      count: sepRows.length,
      executores: hidratarExecutores(sepIds, usuariosMap),
    },
    embalagem: {
      count: embRows.length,
      executores: hidratarExecutores(embIds, usuariosMap),
    },
    guarda: {
      count: guardaRows.length,
      executores: hidratarExecutores(guardaIds, usuariosMap),
    },
    compras: {
      aComprar: comprasComprarQ.count ?? 0,
      aReceber: comprasReceberQ.count ?? 0,
    },
    inventario: {
      sessoesAtivas: (invSessoesQ.data ?? []).length,
      executores: hidratarExecutores(invIds, usuariosMap),
    },
  };
}
