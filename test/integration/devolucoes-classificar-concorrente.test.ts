import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { classificarDevolucao } from "../../src/lib/wms/devolucoes";

const sb = createServiceClient();
let galpaoId: string, locId: string, produtoId: string, usuarioId: string;

async function novaDevolucao(): Promise<string> {
  // siso_devolucoes_pendentes NÃO tem produto_id/galpao_id/qty — esses vêm via
  // ClassificarInput. As únicas colunas com restrição (status, payload_webhook,
  // criado_em, id) têm DEFAULT (ver CREATE TABLE em 20260605_wms_excecoes_
  // dashboards.sql:7-23), então o insert com só { status } é suficiente — não
  // há NOT NULL sem default que faria o beforeAll quebrar por outra causa.
  const { data: d } = await sb
    .from("siso_devolucoes_pendentes")
    .insert({ status: "aguardando_classificacao" })
    .select("id")
    .single();
  return d!.id;
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).limit(1).single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `TEST-DEV-CLAIM-${Math.random().toString(36).slice(2, 8)}`, descricao: "claim test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();
  usuarioId = u!.id;
});

describe("classificarDevolucao — claim atômico de status", () => {
  it("2 classify concorrentes: exatamente 1 vence, o outro rejeita", async () => {
    const devId = await novaDevolucao();
    const input = {
      devolucao_id: devId,
      classificacao: "integro" as const,
      galpao_id: galpaoId,
      localizacao_id: locId,
      produto_id: produtoId,
      qty: 1,
      usuario_id: usuarioId,
    };
    const results = await Promise.allSettled([
      classificarDevolucao(input),
      classificarDevolucao(input),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rej = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(1);
    expect(rej).toBe(1);

    // movs geradas = exatamente as de 1 classificação (Classe A = 1 mov E).
    const { data: movs } = await sb
      .from("siso_movimentacoes").select("id").eq("devolucao_id", devId);
    expect((movs ?? []).length).toBe(1);
  });
});
