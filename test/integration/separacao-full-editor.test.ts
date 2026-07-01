import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createServiceClient } from "../../src/lib/supabase-server";
import { POST as criarPOST } from "../../src/app/api/wms/full/criar/route";
import { POST as addPOST } from "../../src/app/api/wms/full/[id]/itens/route";
import { DELETE as itemDELETE, PATCH as itemPATCH } from "../../src/app/api/wms/full/[id]/itens/[itemId]/route";
import { POST as iniciarPOST } from "../../src/app/api/wms/separacao/iniciar/route";
import { POST as marcarPOST } from "../../src/app/api/wms/separacao/marcar-item/route";

/**
 * Editor de itens da lane Full (FULL-06) — a matriz de reconciliação de estoque.
 * Cada teste usa um PRODUTO ÚNICO (saldo 100 numa loc picking) → isolamento
 * total contra staging vivo; afterAll limpa pedidos/itens/movs/estoque/produtos.
 *
 * Asserts sobre siso_estoque (saldo/reservado) provam que o ledger sempre fecha:
 * remover/reduzir devolve o estoque, adicionar/aumentar reserva, sem baixa órfã.
 */

const sb = createServiceClient();

let cwbId: string;
let locId: string;
let empresaId: string;
let userId: string;
let sessId: string;
let seq = 0;

const produtos: string[] = []; // wms uuids criados
const pedidos: string[] = [];

async function novoProduto(saldo = 100): Promise<{ wms: string; tiny: number }> {
  const sku = `TESTFULL-${Date.now()}-${++seq}`;
  const tiny = 900000000 + seq * 1000 + (Date.now() % 1000);
  const { data: p, error } = await sb
    .from("siso_produtos")
    .insert({ sku, descricao: `Full editor test ${sku}`, ativo: true })
    .select("id")
    .single();
  if (error) throw new Error(`novoProduto: ${error.message}`);
  const wms = p!.id as string;
  produtos.push(wms);
  await sb.from("siso_produto_empresas").insert({ produto_id: wms, empresa_id: empresaId, tiny_produto_id: tiny, ativo: true });
  const { error: movErr } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: wms,
    p_galpao_id: cwbId,
    p_localizacao_id: locId,
    p_tipo: "E",
    p_quantidade: saldo,
    p_origem_tipo: "inventario_inicial",
    p_origem_id: null,
    p_custo_unitario: 10,
    p_motivo: "seed editor test",
  });
  if (movErr) throw new Error(`seed saldo: ${movErr.message}`);
  return { wms, tiny };
}

async function estoque(wms: string): Promise<{ saldo: number; reservado: number; disponivel: number }> {
  const { data } = await sb
    .from("siso_estoque")
    .select("saldo, reservado, disponivel")
    .eq("produto_id", wms)
    .eq("galpao_id", cwbId)
    .eq("localizacao_id", locId)
    .maybeSingle();
  return {
    saldo: Number(data?.saldo ?? 0),
    reservado: Number(data?.reservado ?? 0),
    disponivel: Number(data?.disponivel ?? 0),
  };
}

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://test${url}`, {
    method,
    headers: { "X-Session-Id": sessId, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function criarFull(wms: string, qty: number): Promise<{ pedidoId: string; itemId: number }> {
  const res = await criarPOST(req("/api/wms/full/criar", "POST", {
    empresa_origem_id: empresaId,
    galpao_id: cwbId,
    items: [{ produto_id: wms, quantidade: qty }],
  }));
  const json = await res.json();
  if (!json.pedido_id) throw new Error(`criarFull falhou: ${JSON.stringify(json)}`);
  pedidos.push(json.pedido_id);
  const { data: item } = await sb.from("siso_pedido_itens").select("id").eq("pedido_id", json.pedido_id).single();
  return { pedidoId: json.pedido_id, itemId: item!.id as number };
}

async function setStatus(pedidoId: string, status: string) {
  await sb.from("siso_pedidos").update({ status_separacao: status }).eq("id", pedidoId);
}

async function iniciarEPicar(pedidoId: string, itemId: number) {
  await iniciarPOST(req("/api/wms/separacao/iniciar", "POST", { pedido_ids: [pedidoId], operador_id: userId }));
  const r = await marcarPOST(req("/api/wms/separacao/marcar-item", "POST", { pedido_item_id: itemId, marcado: true }));
  if (!r.ok) throw new Error(`marcar-item falhou: ${JSON.stringify(await r.json())}`);
}

function addItem(pedidoId: string, wms: string, qty: number) {
  return addPOST(req(`/api/wms/full/${pedidoId}/itens`, "POST", { produto_id: wms, quantidade: qty }), {
    params: Promise.resolve({ id: pedidoId }),
  });
}
function removeItem(pedidoId: string, itemId: number) {
  return itemDELETE(req(`/api/wms/full/${pedidoId}/itens/${itemId}`, "DELETE"), {
    params: Promise.resolve({ id: pedidoId, itemId: String(itemId) }),
  });
}
function patchQty(pedidoId: string, itemId: number, quantidade: number) {
  return itemPATCH(req(`/api/wms/full/${pedidoId}/itens/${itemId}`, "PATCH", { quantidade }), {
    params: Promise.resolve({ id: pedidoId, itemId: String(itemId) }),
  });
}

async function statusDe(pedidoId: string): Promise<string | null> {
  const { data } = await sb.from("siso_pedidos").select("status_separacao").eq("id", pedidoId).single();
  return data?.status_separacao ?? null;
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  cwbId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", cwbId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").eq("cnpj", "34857388000163").single();
  empresaId = e!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "admin-runner").single();
  userId = u!.id as string;
  const { data: s } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: userId, expira_em: new Date(Date.now() + 3600_000).toISOString() })
    .select("id")
    .single();
  sessId = s!.id as string;
});

afterAll(async () => {
  const { data: movs } = await sb.from("siso_movimentacoes").select("id").in("produto_id", produtos);
  const movIds = (movs ?? []).map((m) => m.id as string);
  if (movIds.length > 0) await sb.from("siso_pedido_item_mov_links").delete().in("mov_id", movIds);
  if (pedidos.length > 0) {
    await sb.from("siso_pedido_itens").delete().in("pedido_id", pedidos);
    await sb.from("siso_pedidos").delete().in("id", pedidos);
  }
  if (produtos.length > 0) {
    // ORDEM importa. siso_custo_medio tem DUAS FKs: produto_id→produtos E
    // ultima_movimentacao_id→movimentacoes. Precisa sair ANTES de movimentacoes
    // (senão o delete das movs viola custo_medio_ultima_movimentacao_id_fkey) E
    // antes de produtos.
    await sb.from("siso_custo_medio").delete().in("produto_id", produtos);
    // Movs em duas passadas: estornos (estorno_de setado) antes das base, pra
    // não esbarrar no self-FK estorno_de → movimentacoes.
    await sb.from("siso_movimentacoes").delete().in("produto_id", produtos).not("estorno_de", "is", null);
    await sb.from("siso_movimentacoes").delete().in("produto_id", produtos);
    await sb.from("siso_estoque").delete().in("produto_id", produtos);
    await sb.from("siso_produto_empresas").delete().in("produto_id", produtos);
    await sb.from("siso_produtos").delete().in("id", produtos);
  }
  await sb.from("siso_sessoes").delete().eq("id", sessId);
});

describe("editor Full — add", () => {
  it("adiciona item, reserva parcial, reabre separado→em_separacao (picks anteriores intactos)", async () => {
    const p1 = await novoProduto();
    const p2 = await novoProduto();
    const { pedidoId } = await criarFull(p1.wms, 10);
    await setStatus(pedidoId, "separado");

    const res = await addItem(pedidoId, p2.wms, 5);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.reservado).toBe(5);

    expect((await estoque(p2.wms)).reservado).toBe(5); // R do novo item
    expect((await estoque(p1.wms)).reservado).toBe(10); // R do item anterior intacta
    expect(await statusDe(pedidoId)).toBe("em_separacao"); // reaberto
  });
});

describe("editor Full — remove", () => {
  it("remove item NÃO picado → libera R, disponível volta, linha some", async () => {
    const p = await novoProduto();
    const { pedidoId, itemId } = await criarFull(p.wms, 10);
    expect((await estoque(p.wms)).reservado).toBe(10);

    const res = await removeItem(pedidoId, itemId);
    expect(res.status).toBe(200);

    const st = await estoque(p.wms);
    expect(st.reservado).toBe(0);
    expect(st.saldo).toBe(100);
    expect(st.disponivel).toBe(100);
    const { data: item } = await sb.from("siso_pedido_itens").select("id").eq("id", itemId).maybeSingle();
    expect(item).toBeNull();
  });

  it("remove item PICADO → estorna S (saldo volta +qty), libera R, linha some", async () => {
    const p = await novoProduto();
    const { pedidoId, itemId } = await criarFull(p.wms, 10);
    await iniciarEPicar(pedidoId, itemId);
    // Após pick: 10 saíram do saldo.
    expect((await estoque(p.wms)).saldo).toBe(90);

    const res = await removeItem(pedidoId, itemId);
    expect(res.status).toBe(200);

    const st = await estoque(p.wms);
    expect(st.saldo).toBe(100); // S estornada — saldo devolvido
    expect(st.reservado).toBe(0);
    const { data: item } = await sb.from("siso_pedido_itens").select("id").eq("id", itemId).maybeSingle();
    expect(item).toBeNull();
  });
});

describe("editor Full — set_qty", () => {
  it("↑ (5→7): reserva +2 e reabre", async () => {
    const p = await novoProduto();
    const { pedidoId, itemId } = await criarFull(p.wms, 5);
    await setStatus(pedidoId, "separado");

    const res = await patchQty(pedidoId, itemId, 7);
    expect(res.status).toBe(200);
    expect((await estoque(p.wms)).reservado).toBe(7);
    expect(await statusDe(pedidoId)).toBe("em_separacao");
  });

  it("↓ abaixo do picado (5→2, 5 picado): desmarca, saldo volta +5, R clampada a 2, reabre", async () => {
    const p = await novoProduto();
    const { pedidoId, itemId } = await criarFull(p.wms, 5);
    await iniciarEPicar(pedidoId, itemId);
    await setStatus(pedidoId, "separado");
    expect((await estoque(p.wms)).saldo).toBe(95); // 5 picados

    const res = await patchQty(pedidoId, itemId, 2);
    expect(res.status).toBe(200);

    const st = await estoque(p.wms);
    expect(st.saldo).toBe(100); // desmarcou → saldo devolvido
    expect(st.reservado).toBe(2); // R clampada à nova qty
    expect(await statusDe(pedidoId)).toBe("em_separacao");
    const { data: item } = await sb.from("siso_pedido_itens").select("quantidade_pedida, quantidade_pega").eq("id", itemId).single();
    expect(Number(item!.quantidade_pedida)).toBe(2);
    expect(item!.quantidade_pega).toBeNull();
  });

  it("↓ acima do picado (2 picado, 5→3): libera R excedente, SEM estorno de S", async () => {
    const p = await novoProduto();
    // Constrói picado=2/qty=5: cria 2, pica 2, aumenta pra 5.
    const { pedidoId, itemId } = await criarFull(p.wms, 2);
    await iniciarEPicar(pedidoId, itemId);
    expect((await estoque(p.wms)).saldo).toBe(98); // 2 picados
    await patchQty(pedidoId, itemId, 5); // ↑ reserva +3
    expect((await estoque(p.wms)).reservado).toBe(3);

    const res = await patchQty(pedidoId, itemId, 3); // ↓ mas ≥ picado(2)
    expect(res.status).toBe(200);

    const st = await estoque(p.wms);
    expect(st.saldo).toBe(98); // S dos 2 picados INTACTA — sem estorno
    expect(st.reservado).toBe(1); // 3 − 2 picado = 1 reservado
  });
});

describe("editor Full — guards", () => {
  it("editar Full FECHADO → 400", async () => {
    const p = await novoProduto();
    const { pedidoId, itemId } = await criarFull(p.wms, 5);
    await sb.from("siso_pedidos").update({ status_separacao: "separado", fechado_em: new Date().toISOString() }).eq("id", pedidoId);

    const resPatch = await patchQty(pedidoId, itemId, 3);
    expect(resPatch.status).toBe(400);
    const resDel = await removeItem(pedidoId, itemId);
    expect(resDel.status).toBe(400);
  });

  it("double-tap remove picado: 2ª chamada é coerente (item já removido), sem estado inconsistente", async () => {
    const p = await novoProduto();
    const { pedidoId, itemId } = await criarFull(p.wms, 4);
    await iniciarEPicar(pedidoId, itemId);

    const res1 = await removeItem(pedidoId, itemId);
    expect(res1.status).toBe(200);
    const res2 = await removeItem(pedidoId, itemId);
    expect(res2.status).not.toBe(200); // item já não existe

    // Estado consistente: saldo devolvido uma única vez.
    expect((await estoque(p.wms)).saldo).toBe(100);
  });
});
