import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { cancelarTransferencia } from "../../src/lib/wms/transferencias";

const sb = createServiceClient();
let galpaoOrigemId: string, galpaoDestinoId: string, produtoId: string, locOrigemId: string;
let joaoId: string, mariaId: string;

async function novaTransfEmTransito(): Promise<string> {
  const { data: t } = await sb
    .from("siso_transferencias_galpao")
    .insert({
      galpao_origem_id: galpaoOrigemId,
      galpao_destino_id: galpaoDestinoId,
      status: "em_transito",
      criada_por: joaoId,
    })
    .select("id")
    .single();
  await sb.from("siso_transferencia_galpao_itens").insert({
    transferencia_id: t!.id,
    produto_id: produtoId,
    qty: 1,
    localizacao_origem_id: locOrigemId,
    mov_saida_id: null,
  });
  return t!.id;
}

beforeAll(async () => {
  const { data: gs } = await sb.from("siso_galpoes").select("id, nome").eq("ativo", true);
  galpaoOrigemId = gs!.find((g) => g.nome === "CWB")!.id;
  galpaoDestinoId = gs!.find((g) => g.nome === "SP")!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id").eq("galpao_id", galpaoOrigemId).limit(1).single();
  locOrigemId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `TEST-TR-LOCK-${Math.random().toString(36).slice(2, 8)}`, descricao: "lock test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  const { data: us } = await sb.from("siso_usuarios").select("id").limit(2);
  joaoId = us![0].id;
  mariaId = us![1]?.id ?? us![0].id;
});

describe("cancelarTransferencia respeita o lock de recebimento", () => {
  it("Maria (não-recebedora) NÃO cancela enquanto João recebe (<30min)", async () => {
    const tid = await novaTransfEmTransito();
    await sb
      .from("siso_transferencias_galpao")
      .update({
        recebimento_em_andamento_por: joaoId,
        recebimento_em_andamento_em: new Date().toISOString(),
      })
      .eq("id", tid);

    await expect(cancelarTransferencia(tid, mariaId)).rejects.toThrow(
      /recebimento em andamento|TRANSFERENCIA_RECEBIMENTO/i,
    );
    const { data: t } = await sb
      .from("siso_transferencias_galpao").select("status").eq("id", tid).single();
    expect(t?.status).toBe("em_transito"); // não cancelou
  });

  it("João (dono do lock) consegue cancelar", async () => {
    const tid = await novaTransfEmTransito();
    await sb
      .from("siso_transferencias_galpao")
      .update({
        recebimento_em_andamento_por: joaoId,
        recebimento_em_andamento_em: new Date().toISOString(),
      })
      .eq("id", tid);
    await expect(cancelarTransferencia(tid, joaoId)).resolves.toBeDefined();
    const { data: t } = await sb
      .from("siso_transferencias_galpao").select("status").eq("id", tid).single();
    expect(t?.status).toBe("cancelada");
  });

  it("lock stale (>30min) — qualquer um cancela", async () => {
    const tid = await novaTransfEmTransito();
    await sb
      .from("siso_transferencias_galpao")
      .update({
        recebimento_em_andamento_por: joaoId,
        recebimento_em_andamento_em: new Date(Date.now() - 31 * 60_000).toISOString(),
      })
      .eq("id", tid);
    await expect(cancelarTransferencia(tid, mariaId)).resolves.toBeDefined();
    const { data: t } = await sb
      .from("siso_transferencias_galpao").select("status").eq("id", tid).single();
    expect(t?.status).toBe("cancelada");
  });
});
