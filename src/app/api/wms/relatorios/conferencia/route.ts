import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/wms/relatorios/conferencia
 *
 * Métricas da conferência de embalagem no período.
 *
 * Query params:
 *   - de:  ISO date (default: 7 dias atrás)
 *   - ate: ISO date (default: hoje; inclusivo — soma 1 dia no filtro)
 *   - galpao_id?: filtra por galpão de separação
 *
 * Response:
 *   geral: { embalados_periodo, com_embalador, conferidos, divergencias,
 *            pct_rastreado, pct_conferido }
 *   por_embalador: [{ usuario_id, nome, embalados, conferidos, divergencias,
 *                     taxa_acerto, pct_conferido, por_tipo }]
 *   por_conferente: [{ usuario_id, nome, conferidos, divergencias_encontradas }]
 *
 * Atribuição temporal: embalador conta por embalado_real_em; conferente por
 * conferido_em; total de pacotes do período por embalagem_concluida_em.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const hoje = new Date();
  const de = url.searchParams.get("de") ?? new Date(hoje.getTime() - 7 * 86400_000).toISOString().slice(0, 10);
  const ate = url.searchParams.get("ate") ?? hoje.toISOString().slice(0, 10);
  const galpaoId = url.searchParams.get("galpao_id");

  // `ate` inclusivo: limite superior exclusivo = ate + 1 dia
  const ateExclusivo = new Date(new Date(`${ate}T00:00:00Z`).getTime() + 86400_000)
    .toISOString()
    .slice(0, 10);

  const supabase = createServiceClient();

  const SELECT =
    "id, embalado_real_por, embalado_real_em, conferido_por, conferido_em, divergencia_tipo, separacao_galpao_id";

  // pacotes com embalador registrado no período (métrica do embalador)
  let qEmbalados = supabase
    .from("siso_pedidos")
    .select(SELECT)
    .gte("embalado_real_em", de)
    .lt("embalado_real_em", ateExclusivo);
  if (galpaoId) qEmbalados = qEmbalados.eq("separacao_galpao_id", galpaoId);

  // conferências feitas no período (métrica do conferente)
  let qConferidos = supabase
    .from("siso_pedidos")
    .select(SELECT)
    .gte("conferido_em", de)
    .lt("conferido_em", ateExclusivo);
  if (galpaoId) qConferidos = qConferidos.eq("separacao_galpao_id", galpaoId);

  // total de pacotes que concluíram embalagem (checklist) no período
  let qTotal = supabase
    .from("siso_pedidos")
    .select("id", { count: "exact", head: true })
    .gte("embalagem_concluida_em", de)
    .lt("embalagem_concluida_em", ateExclusivo);
  if (galpaoId) qTotal = qTotal.eq("separacao_galpao_id", galpaoId);

  const [embaladosRes, conferidosRes, totalRes] = await Promise.all([
    qEmbalados,
    qConferidos,
    qTotal,
  ]);

  const erro = embaladosRes.error ?? conferidosRes.error ?? totalRes.error;
  if (erro) {
    return NextResponse.json({ error: erro.message }, { status: 500 });
  }

  type Row = {
    id: string;
    embalado_real_por: string | null;
    conferido_por: string | null;
    conferido_em: string | null;
    divergencia_tipo: string | null;
  };
  const embalados = (embaladosRes.data ?? []) as Row[];
  const conferidos = (conferidosRes.data ?? []) as Row[];

  // ── por embalador ──
  interface EmbAgg {
    embalados: number;
    conferidos: number;
    divergencias: number;
    por_tipo: Record<string, number>;
  }
  const porEmbalador = new Map<string, EmbAgg>();
  for (const r of embalados) {
    if (!r.embalado_real_por) continue;
    const agg = porEmbalador.get(r.embalado_real_por) ?? {
      embalados: 0,
      conferidos: 0,
      divergencias: 0,
      por_tipo: {},
    };
    agg.embalados++;
    if (r.conferido_em) {
      agg.conferidos++;
      if (r.divergencia_tipo) {
        agg.divergencias++;
        agg.por_tipo[r.divergencia_tipo] = (agg.por_tipo[r.divergencia_tipo] ?? 0) + 1;
      }
    }
    porEmbalador.set(r.embalado_real_por, agg);
  }

  // ── por conferente ──
  const porConferente = new Map<string, { conferidos: number; divergencias_encontradas: number }>();
  for (const r of conferidos) {
    if (!r.conferido_por) continue;
    const agg = porConferente.get(r.conferido_por) ?? { conferidos: 0, divergencias_encontradas: 0 };
    agg.conferidos++;
    if (r.divergencia_tipo) agg.divergencias_encontradas++;
    porConferente.set(r.conferido_por, agg);
  }

  // ── nomes ──
  const usuarioIds = [...new Set([...porEmbalador.keys(), ...porConferente.keys()])];
  const nomes = new Map<string, string>();
  if (usuarioIds.length > 0) {
    const { data: usuarios } = await supabase
      .from("siso_usuarios")
      .select("id, nome")
      .in("id", usuarioIds);
    for (const u of usuarios ?? []) nomes.set(u.id, u.nome);
  }

  const totalEmbaladosPeriodo = totalRes.count ?? 0;
  const totalConferidos = conferidos.length;
  const totalDivergencias = conferidos.filter((r) => r.divergencia_tipo).length;

  return NextResponse.json({
    periodo: { de, ate },
    geral: {
      embalados_periodo: totalEmbaladosPeriodo,
      com_embalador: embalados.length,
      conferidos: totalConferidos,
      divergencias: totalDivergencias,
      pct_rastreado: totalEmbaladosPeriodo > 0 ? embalados.length / totalEmbaladosPeriodo : null,
      pct_conferido: totalEmbaladosPeriodo > 0 ? totalConferidos / totalEmbaladosPeriodo : null,
    },
    por_embalador: [...porEmbalador.entries()]
      .map(([usuario_id, agg]) => ({
        usuario_id,
        nome: nomes.get(usuario_id) ?? usuario_id,
        ...agg,
        pct_conferido: agg.embalados > 0 ? agg.conferidos / agg.embalados : null,
        taxa_acerto: agg.conferidos > 0 ? 1 - agg.divergencias / agg.conferidos : null,
      }))
      .sort((a, b) => b.embalados - a.embalados),
    por_conferente: [...porConferente.entries()]
      .map(([usuario_id, agg]) => ({
        usuario_id,
        nome: nomes.get(usuario_id) ?? usuario_id,
        ...agg,
      }))
      .sort((a, b) => b.conferidos - a.conferidos),
  });
}
