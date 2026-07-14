import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createServiceClient } from "../../src/lib/supabase-server";
import { POST as criarFullPOST } from "../../src/app/api/wms/full/criar/route";
import { POST as criarVendaPOST } from "../../src/app/api/wms/vendas/criar/route";
import { POST as addPOST } from "../../src/app/api/wms/full/[id]/itens/route";
import { PATCH as itemPATCH } from "../../src/app/api/wms/full/[id]/itens/[itemId]/route";

/**
 * 2026-07-07 — desmembra kits na criação (venda + Full) e linhas duplicadas
 * na lane Full (`preservar_linhas` / "Separar na ordem da lista").
 *
 * Cada teste usa produtos únicos (saldo 100 em loc picking) → isolamento total
 * contra staging vivo; afterAll limpa pedidos/itens/movs/estoque/kits/produtos.
 */

const sb = createServiceClient();

let cwbId: string;
let locId: string;
let empresaId: string;
let sessId: string;
let seq = 0;

const produtos: string[] = [];
const pedidos: string[] = [];

async function novoProduto(saldo = 100): Promise<{ wms: string; tiny: number; sku: string }> {
  const sku = `TESTFLK-${Date.now()}-${++seq}`;
  const tiny = 910000000 + seq * 1000 + (Date.now() % 1000);
  const { data: p, error } = await sb
    .from("siso_produtos")
    .insert({ sku, descricao: `Full linhas/kits test ${sku}`, ativo: true })
    .select("id")
    .single();
  if (error) throw new Error(`novoProduto: ${error.message}`);
  const wms = p!.id as string;
  produtos.push(wms);
  await sb
    .from("siso_produto_empresas")
    .insert({ produto_id: wms, empresa_id: empresaId, tiny_produto_id: tiny, ativo: true });
  if (saldo > 0) {
    const { error: movErr } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: wms,
      p_galpao_id: cwbId,
      p_localizacao_id: locId,
      p_tipo: "E",
      p_quantidade: saldo,
      p_origem_tipo: "inventario_inicial",
      p_origem_id: null,
      p_custo_unitario: 10,
      p_motivo: "seed full-linhas-kits test",
    });
    if (movErr) throw new Error(`seed saldo: ${movErr.message}`);
  }
  return { wms, tiny, sku };
}

/** Kit = produto sem saldo + composição. eh_kit só DEPOIS da composição (P120). */
async function novoKit(
  componentes: Array<{ wms: string; qty: number }>,
): Promise<{ wms: string; tiny: number }> {
  const k = await novoProduto(0);
  for (const c of componentes) {
    const { error } = await sb.from("siso_produto_kits").insert({
      kit_produto_id: k.wms,
      componente_produto_id: c.wms,
      quantidade: c.qty,
    });
    if (error) throw new Error(`novoKit composicao: ${error.message}`);
  }
  await sb.from("siso_produtos").update({ eh_kit: true }).eq("id", k.wms);
  return { wms: k.wms, tiny: k.tiny };
}

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://test${url}`, {
    method,
    headers: { "X-Session-Id": sessId, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function criarFull(
  items: Array<{ produto_id: string; quantidade: number }>,
  preservarLinhas = false,
): Promise<string> {
  const res = await criarFullPOST(
    req("/api/wms/full/criar", "POST", {
      empresa_origem_id: empresaId,
      galpao_id: cwbId,
      items,
      ...(preservarLinhas ? { preservar_linhas: true } : {}),
    }),
  );
  const json = await res.json();
  if (!json.pedido_id) throw new Error(`criarFull falhou: ${JSON.stringify(json)}`);
  pedidos.push(json.pedido_id);
  return json.pedido_id as string;
}

async function itensDe(pedidoId: string) {
  const { data } = await sb
    .from("siso_pedido_itens")
    .select("id, produto_id, sku, quantidade_pedida, ordem_full, linha")
    .eq("pedido_id", pedidoId)
    .order("ordem_full", { ascending: true });
  return data ?? [];
}

async function reservadoDe(wms: string): Promise<number> {
  const { data } = await sb
    .from("siso_estoque")
    .select("reservado")
    .eq("produto_id", wms)
    .eq("galpao_id", cwbId)
    .eq("localizacao_id", locId)
    .maybeSingle();
  return Number(data?.reservado ?? 0);
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  cwbId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", cwbId)
    .eq("codigo", "A-01-01")
    .single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").eq("cnpj", "34857388000163").single();
  empresaId = e!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "admin-runner").single();
  const { data: s } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: u!.id, expira_em: new Date(Date.now() + 3600_000).toISOString() })
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
    await sb.from("siso_produto_kits").delete().in("kit_produto_id", produtos);
    await sb.from("siso_custo_medio").delete().in("produto_id", produtos);
    await sb.from("siso_movimentacoes").delete().in("produto_id", produtos).not("estorno_de", "is", null);
    await sb.from("siso_movimentacoes").delete().in("produto_id", produtos);
    await sb.from("siso_estoque").delete().in("produto_id", produtos);
    await sb.from("siso_produto_empresas").delete().in("produto_id", produtos);
    await sb.from("siso_produtos").delete().in("id", produtos);
  }
  await sb.from("siso_sessoes").delete().eq("id", sessId);
});

describe("kits desmembram na criação", () => {
  it("Full com kit (2×A + 1×B), qty 2 → itens = componentes (A:4, B:2), sem linha do kit", async () => {
    const a = await novoProduto();
    const b = await novoProduto();
    const kit = await novoKit([
      { wms: a.wms, qty: 2 },
      { wms: b.wms, qty: 1 },
    ]);

    const pedidoId = await criarFull([{ produto_id: kit.wms, quantidade: 2 }]);
    const itens = await itensDe(pedidoId);

    expect(itens.length).toBe(2);
    const porTiny = new Map(itens.map((i) => [Number(i.produto_id), Number(i.quantidade_pedida)]));
    expect(porTiny.get(a.tiny)).toBe(4);
    expect(porTiny.get(b.tiny)).toBe(2);
    expect(porTiny.has(kit.tiny)).toBe(false);
    // Reserva nos componentes
    expect(await reservadoDe(a.wms)).toBe(4);
    expect(await reservadoDe(b.wms)).toBe(2);
  });

  it("Full usa a composição mesmo se o cadastro estiver com eh_kit=false", async () => {
    const componente = await novoProduto();
    const kit = await novoProduto(0);
    const { error } = await sb.from("siso_produto_kits").insert({
      kit_produto_id: kit.wms,
      componente_produto_id: componente.wms,
      quantidade: 2,
    });
    if (error) throw new Error(`composição inconsistente: ${error.message}`);

    const pedidoId = await criarFull([{ produto_id: kit.wms, quantidade: 3 }]);
    const itens = await itensDe(pedidoId);

    expect(itens).toHaveLength(1);
    expect(Number(itens[0].produto_id)).toBe(componente.tiny);
    expect(Number(itens[0].quantidade_pedida)).toBe(6);
    expect(await reservadoDe(componente.wms)).toBe(6);
  });

  it("venda manual (modo separacao) com kit → itens = componentes", async () => {
    const a = await novoProduto();
    const kit = await novoKit([{ wms: a.wms, qty: 3 }]);

    const res = await criarVendaPOST(
      req("/api/wms/vendas/criar", "POST", {
        cliente_nome: "Cliente Teste Kits",
        empresa_origem_id: empresaId,
        galpao_id: cwbId,
        modo: "separacao",
        items: [{ produto_id: kit.wms, quantidade: 2 }],
      }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    pedidos.push(json.pedido_id);

    const itens = await itensDe(json.pedido_id);
    expect(itens.length).toBe(1);
    expect(Number(itens[0].produto_id)).toBe(a.tiny);
    expect(Number(itens[0].quantidade_pedida)).toBe(6); // 3 × 2
  });
});

describe("Full — preservar_linhas (Separar na ordem da lista)", () => {
  it("2 linhas do mesmo produto + flag → 2 rows (linha 1/2, ordem 1/2), reserva agregada", async () => {
    const p = await novoProduto();
    const pedidoId = await criarFull(
      [
        { produto_id: p.wms, quantidade: 1 },
        { produto_id: p.wms, quantidade: 1 },
      ],
      true,
    );

    const itens = await itensDe(pedidoId);
    expect(itens.length).toBe(2);
    expect(itens.map((i) => Number(i.ordem_full))).toEqual([1, 2]);
    expect(itens.map((i) => Number(i.linha))).toEqual([1, 2]);
    expect(itens.every((i) => Number(i.quantidade_pedida) === 1)).toBe(true);
    expect(await reservadoDe(p.wms)).toBe(2); // agregado, não max(linha)
  });

  it("2 linhas do mesmo produto SEM flag → 1 row somada (comportamento clássico)", async () => {
    const p = await novoProduto();
    const pedidoId = await criarFull([
      { produto_id: p.wms, quantidade: 1 },
      { produto_id: p.wms, quantidade: 1 },
    ]);

    const itens = await itensDe(pedidoId);
    expect(itens.length).toBe(1);
    expect(Number(itens[0].quantidade_pedida)).toBe(2);
    expect(Number(itens[0].linha)).toBe(1);
  });

  it("editor add do produto já presente: 409 no clássico, linha nova no preservar_linhas", async () => {
    const p = await novoProduto();

    const classico = await criarFull([{ produto_id: p.wms, quantidade: 1 }]);
    const r409 = await addPOST(
      req(`/api/wms/full/${classico}/itens`, "POST", { produto_id: p.wms, quantidade: 1 }),
      { params: Promise.resolve({ id: classico }) },
    );
    expect(r409.status).toBe(409);

    const preservado = await criarFull([{ produto_id: p.wms, quantidade: 1 }], true);
    const rOk = await addPOST(
      req(`/api/wms/full/${preservado}/itens`, "POST", { produto_id: p.wms, quantidade: 2 }),
      { params: Promise.resolve({ id: preservado }) },
    );
    expect(rOk.status).toBe(200);
    const itens = await itensDe(preservado);
    expect(itens.length).toBe(2);
    expect(itens.map((i) => Number(i.linha)).sort()).toEqual([1, 2]);
  });

  it("set_qty numa linha re-reserva o produto INTEIRO (linhas irmãs não perdem R)", async () => {
    const p = await novoProduto();
    const pedidoId = await criarFull(
      [
        { produto_id: p.wms, quantidade: 2 },
        { produto_id: p.wms, quantidade: 3 },
      ],
      true,
    );
    expect(await reservadoDe(p.wms)).toBe(5);

    const itens = await itensDe(pedidoId);
    const linha1 = itens.find((i) => Number(i.linha) === 1)!;
    const res = await itemPATCH(
      req(`/api/wms/full/${pedidoId}/itens/${linha1.id}`, "PATCH", { quantidade: 4 }),
      { params: Promise.resolve({ id: pedidoId, itemId: String(linha1.id) }) },
    );
    expect(res.status).toBe(200);

    // 4 (linha 1 nova) + 3 (linha 2 intacta) — sem o fix, a R da linha 2 evaporava.
    expect(await reservadoDe(p.wms)).toBe(7);
  });
});
