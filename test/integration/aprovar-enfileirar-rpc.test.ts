import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let empresaId: string;

const IDS = ["720000001", "720000002", "720000003"];

beforeAll(async () => {
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  // Ordem-independente: limpa os pedidos fixos deste arquivo + jobs (o harness
  // trunca 1x por run, mas vários arquivos rodam na mesma run).
  await sb.from("siso_fila_execucao").delete().in("pedido_id", IDS);
  await sb.from("siso_pedidos").delete().in("id", IDS);
});

// siso_pedidos tem NOT NULL sem default em numero/data/filial_origem/cliente_nome
// → o insert mínimo precisa supri-los (senão o insert falha e o SELECT vem null).
const pedidoBase = (id: string) => ({
  id, status: "pendente",
  numero: id, data: "2026-06-10", filial_origem: "CWB", cliente_nome: "Teste",
});

describe("wms_aprovar_e_enfileirar", () => {
  it("atualiza pedido + insere job na MESMA tx", async () => {
    const pedidoId = "720000001";
    await sb.from("siso_pedidos").insert(pedidoBase(pedidoId));
    const { error } = await sb.rpc("wms_aprovar_e_enfileirar", {
      p_pedido_id: pedidoId, p_decisao: "propria", p_status_separacao: "aguardando_nf",
      p_empresa_id: empresaId, p_filial_execucao: "CWB",
      p_operador_id: null, p_operador_nome: null, p_marcadores: null,
      p_separacao_galpao_id: null,
    });
    expect(error).toBeNull();
    const { data: ped } = await sb.from("siso_pedidos").select("status, decisao_final").eq("id", pedidoId).single();
    expect((ped as { status: string }).status).toBe("executando");
    expect((ped as { decisao_final: string }).decisao_final).toBe("propria");
    const { data: jobs } = await sb.from("siso_fila_execucao").select("id, tipo, status").eq("pedido_id", pedidoId);
    expect(jobs!.length).toBe(1);
    expect((jobs![0] as { tipo: string }).tipo).toBe("lancar_estoque");
  });

  it("idempotente: 2ª chamada não duplica job (status já executando)", async () => {
    const pedidoId = "720000002";
    await sb.from("siso_pedidos").insert(pedidoBase(pedidoId));
    const args = {
      p_pedido_id: pedidoId, p_decisao: "propria", p_status_separacao: "aguardando_nf",
      p_empresa_id: empresaId, p_filial_execucao: "CWB",
      p_operador_id: null, p_operador_nome: null, p_marcadores: null, p_separacao_galpao_id: null,
    };
    await sb.rpc("wms_aprovar_e_enfileirar", args);
    await sb.rpc("wms_aprovar_e_enfileirar", args);
    const { data: jobs } = await sb.from("siso_fila_execucao").select("id").eq("pedido_id", pedidoId).eq("tipo", "lancar_estoque");
    expect(jobs!.length).toBe(1);
  });

  // ATOMICIDADE (cura do estado-fantasma): se o INSERT da fila falha, o UPDATE
  // de status TAMBÉM rola back. O plano injetava a falha via chk_fila_filial
  // (IN ('CWB','SP')), mas esse CHECK NÃO existe no staging (a tabela foi
  // recriada sem ele na migration 20260310). Usamos a FK existente
  // siso_fila_execucao_empresa_id_fkey: um empresa_id inexistente viola a FK
  // dentro da mesma tx → aborta tudo. Prova que o pedido NÃO ficou 'executando'
  // sem job — o estado fantasma do código antigo.
  it("atômico: INSERT da fila falha → status NÃO muda (sem aprovado-sem-job)", async () => {
    const pedidoId = "720000003";
    await sb.from("siso_pedidos").insert(pedidoBase(pedidoId));
    const { error } = await sb.rpc("wms_aprovar_e_enfileirar", {
      p_pedido_id: pedidoId, p_decisao: "propria", p_status_separacao: "aguardando_nf",
      p_empresa_id: "00000000-0000-0000-0000-000000000000", // viola FK empresa_id
      p_filial_execucao: "CWB",
      p_operador_id: null, p_operador_nome: null, p_marcadores: null, p_separacao_galpao_id: null,
    });
    expect(error).not.toBeNull(); // a tx inteira aborta (FK violation)
    const { data: ped } = await sb.from("siso_pedidos").select("status, decisao_final").eq("id", pedidoId).single();
    expect((ped as { status: string }).status).toBe("pendente"); // UPDATE rolou back junto
    expect((ped as { decisao_final: string | null }).decisao_final).toBeNull();
    const { data: jobs } = await sb.from("siso_fila_execucao").select("id").eq("pedido_id", pedidoId);
    expect((jobs ?? []).length).toBe(0); // nenhum job (nem o que falhou)
  });
});
