import { createServiceClient } from "@/lib/supabase-server";

// Modelo 3D (Fase 5 Batch C):
// - Empréstimos (saldos devedores entre empresas) deixaram de existir —
//   pool fungível por galpão. Counter `emprestimos.paresComSaldo` removido,
//   RPC `wms_saldos_devedores` foi dropada na Fase 1.
// - Swap/mini-swap também não existem mais.

export interface DashboardGeralResult {
  cobertura: Record<string, number>;
  inventario: {
    sessoesAtivas: number;
    divergenciasPend: number;
    locksAntigos: number;
  };
  reservas: {
    expiraEm6h: number;
  };
  retroativosOrfaos: number;
}

export async function dashboardGeral(): Promise<DashboardGeralResult> {
  const sb = createServiceClient();

  const agora = new Date();
  const em6h = new Date(agora.getTime() + 6 * 3600 * 1000).toISOString();
  const ha1h = new Date(agora.getTime() - 3600 * 1000).toISOString();

  const [
    cobertura,
    sessoesAtivas,
    divergenciasPend,
    reservasExp,
    retroativos,
    locks,
  ] = await Promise.all([
    sb.from("siso_cobertura_estoque").select("status_cobertura"),
    sb.from("siso_inventario_sessoes").select("id").eq("status", "em_andamento"),
    sb
      .from("siso_inventario_divergencias")
      .select("id")
      .eq("status", "pendente"),
    sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .lte("expira_em", em6h)
      .gt("expira_em", agora.toISOString()),
    sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("origem_tipo", "lancamento_retroativo"),
    sb
      .from("siso_localizacao_locks")
      .select("id")
      .is("finalizado_em", null)
      .lt("iniciado_em", ha1h),
  ]);

  const cobByStatus = ((cobertura.data ?? []) as Array<{ status_cobertura: string }>).reduce<
    Record<string, number>
  >((acc, r) => {
    acc[r.status_cobertura] = (acc[r.status_cobertura] ?? 0) + 1;
    return acc;
  }, {});

  // Filtra retroativos sem mov de estorno apontando
  const retroativosIds = ((retroativos.data ?? []) as Array<{ id: string }>).map(
    (r) => r.id,
  );
  let retroativosOrfaos = 0;
  if (retroativosIds.length > 0) {
    const { data: estornos } = await sb
      .from("siso_movimentacoes")
      .select("estorno_de")
      .in("estorno_de", retroativosIds);
    const reconciliados = new Set(
      ((estornos ?? []) as Array<{ estorno_de: string | null }>)
        .map((e) => e.estorno_de)
        .filter((x): x is string => !!x),
    );
    retroativosOrfaos = retroativosIds.filter((id) => !reconciliados.has(id))
      .length;
  }

  return {
    cobertura: cobByStatus,
    inventario: {
      sessoesAtivas: sessoesAtivas.data?.length ?? 0,
      divergenciasPend: divergenciasPend.data?.length ?? 0,
      locksAntigos: locks.data?.length ?? 0,
    },
    reservas: {
      expiraEm6h: reservasExp.data?.length ?? 0,
    },
    retroativosOrfaos,
  };
}
