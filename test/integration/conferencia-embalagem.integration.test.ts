import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createServiceClient } from "../../src/lib/supabase-server";
import { POST as biparPOST } from "../../src/app/api/wms/separacao/conferencia/bipar/route";
import { POST as divergenciaPOST } from "../../src/app/api/wms/separacao/conferencia/divergencia/route";
import { POST as voltarEtapaPOST } from "../../src/app/api/wms/separacao/voltar-etapa/route";
import { POST as expedirPOST } from "../../src/app/api/wms/separacao/expedir/route";

/**
 * Conferência de embalagem — bip da etiqueta de envio.
 *
 * Fluxo: embalador bipa (modo embalar → embalado_real_*) → conferente bipa
 * (modo conferir → status 'conferido') → divergência opcional → expedir.
 * Auto-conferência permitida (D5 2026-06-11).
 */

const sb = createServiceClient();

const BARCODE_A = "44990011223344"; // em etiqueta_barcodes (via array)
const BARCODE_B = "44990055667788"; // só no ZPL (via self-heal)
const CHAVE_NF = "35260634857388000163550010000999991000999999";

let cwbId: string;
let userA: string; // embalador (test-runner, admin)
let userB: string; // conferente (operador)
let sessA: string;
let sessB: string;
let seq = 0;

function pedidoId(): string {
  return `74000${String(100 + ++seq)}`;
}

async function seedPedido(opts: {
  status_separacao?: string;
  etiqueta_barcodes?: string[] | null;
  etiqueta_zpl?: string | null;
  chave_acesso_nf?: string | null;
}): Promise<string> {
  const id = pedidoId();
  await sb.from("siso_pedidos").insert({
    id,
    status: "executando",
    numero: id,
    data: "2026-06-11",
    filial_origem: "CWB",
    cliente_nome: "Conf Teste",
    nome_ecommerce: "Mercado Livre",
    status_separacao: opts.status_separacao ?? "embalado",
    separacao_galpao_id: cwbId,
    etiqueta_barcodes: opts.etiqueta_barcodes ?? null,
    etiqueta_zpl: opts.etiqueta_zpl ?? null,
    chave_acesso_nf: opts.chave_acesso_nf ?? null,
  });
  await sb.from("siso_pedido_itens").insert({
    pedido_id: id,
    produto_id: 88000 + seq,
    sku: `CONF-SKU-${seq}`,
    descricao: "Item conferência",
    quantidade_pedida: 2,
  });
  return id;
}

function bipar(codigo: string, modo: "embalar" | "conferir", sessionId: string) {
  return biparPOST(
    new NextRequest("http://test/api/wms/separacao/conferencia/bipar", {
      method: "POST",
      headers: { "X-Session-Id": sessionId, "Content-Type": "application/json" },
      body: JSON.stringify({ codigo, modo }),
    }),
  );
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  cwbId = g!.id;

  const { data: a } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  userA = a!.id;

  // 2º usuário (conferente) — cargo operador dá warehouse perms via fallback
  const { data: bExist } = await sb
    .from("siso_usuarios").select("id").eq("nome", "conf-runner").maybeSingle();
  if (bExist) {
    userB = bExist.id;
  } else {
    const { data: b } = await sb
      .from("siso_usuarios")
      .insert({ nome: "conf-runner", pin: "9898", cargo: "operador", ativo: true })
      .select("id")
      .single();
    userB = b!.id;
  }
  await sb.from("siso_usuario_galpoes").upsert(
    [{ usuario_id: userB, galpao_id: cwbId }],
    { onConflict: "usuario_id,galpao_id", ignoreDuplicates: true },
  );

  const mkSess = async (usuarioId: string) => {
    const { data: s } = await sb
      .from("siso_sessoes")
      .insert({ usuario_id: usuarioId, expira_em: new Date(Date.now() + 3600_000).toISOString() })
      .select("id")
      .single();
    return s!.id as string;
  };
  sessA = await mkSess(userA);
  sessB = await mkSess(userB);
});

afterAll(async () => {
  await sb.from("siso_sessoes").delete().in("id", [sessA, sessB]);
});

describe("resolução do bip", () => {
  it("acha pedido por etiqueta_barcodes (match exato no array)", async () => {
    const id = await seedPedido({ etiqueta_barcodes: [BARCODE_A, "44990099887766"] });
    const res = await bipar(BARCODE_A, "conferir", sessB);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.pedido.id).toBe(id);
    expect(json.via).toBe("barcode");
    expect(json.itens).toHaveLength(1);
    expect(json.itens[0].quantidade_pedida).toBe(2);
  });

  it("acha por chave NF 44 dígitos", async () => {
    const id = await seedPedido({ chave_acesso_nf: CHAVE_NF });
    const res = await bipar(CHAVE_NF, "conferir", sessB);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.pedido.id).toBe(id);
    expect(json.via).toBe("chave_nf");
  });

  it("fallback ILIKE no ZPL + self-heal persiste etiqueta_barcodes", async () => {
    // etiqueta "antiga": tem ZPL mas etiqueta_barcodes null
    const id = await seedPedido({ etiqueta_zpl: `^XA^BCN,100,N,N,N^FD${BARCODE_B}^FS^XZ`, etiqueta_barcodes: null });
    const res = await bipar(BARCODE_B, "conferir", sessB);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.pedido.id).toBe(id);
    expect(json.via).toBe("zpl_self_heal");
    // self-heal é fire-and-forget — aguarda persistir
    await new Promise((r) => setTimeout(r, 500));
    const { data: ped } = await sb
      .from("siso_pedidos").select("etiqueta_barcodes").eq("id", id).single();
    expect(ped!.etiqueta_barcodes).toContain(BARCODE_B);
  });

  it("código desconhecido → 404 nao_encontrado", async () => {
    const res = await bipar("CODIGO-INEXISTENTE-XYZ", "conferir", sessB);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("nao_encontrado");
  });

  it("pedido fora de embalado/conferido → 422 status_invalido", async () => {
    await seedPedido({ status_separacao: "separado", etiqueta_barcodes: ["BIP-SEPARADO-01"] });
    const res = await bipar("BIP-SEPARADO-01", "conferir", sessB);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("status_invalido");
    expect(json.status_atual).toBe("separado");
  });
});

describe("modo embalar", () => {
  it("grava embalado_real_por/em sem mudar status; re-bip mesmo user idempotente; outro user → aviso", async () => {
    const id = await seedPedido({ etiqueta_barcodes: ["BIP-EMB-01"] });

    const r1 = await bipar("BIP-EMB-01", "embalar", sessA);
    const j1 = await r1.json();
    expect(r1.status).toBe(200);
    expect(j1.aviso).toBeNull();
    expect(j1.pedido.embalado_real_por).toBe(userA);
    expect(j1.pedido.status_separacao).toBe("embalado");

    // idempotente pro mesmo usuário
    const r2 = await bipar("BIP-EMB-01", "embalar", sessA);
    const j2 = await r2.json();
    expect(j2.aviso).toBeNull();
    expect(j2.pedido.embalado_real_por).toBe(userA);

    // outro usuário não sobrescreve
    const r3 = await bipar("BIP-EMB-01", "embalar", sessB);
    const j3 = await r3.json();
    expect(j3.aviso).toBe("ja_embalado");
    expect(j3.pedido.embalado_real_por).toBe(userA);

    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("status_separacao, embalado_real_por, embalado_real_em")
      .eq("id", id)
      .single();
    expect(ped!.status_separacao).toBe("embalado");
    expect(ped!.embalado_real_por).toBe(userA);
    expect(ped!.embalado_real_em).toBeTruthy();
  });
});

describe("modo conferir", () => {
  it("embalado → conferido com conferido_por/em; re-bip → ja_conferido", async () => {
    const id = await seedPedido({ etiqueta_barcodes: ["BIP-CONF-01"] });
    await bipar("BIP-CONF-01", "embalar", sessA);

    const r1 = await bipar("BIP-CONF-01", "conferir", sessB);
    const j1 = await r1.json();
    expect(j1.aviso).toBeNull();
    expect(j1.pedido.status_separacao).toBe("conferido");
    expect(j1.pedido.conferido_por).toBe(userB);
    expect(j1.pedido.embalado_real_por_nome).toBe("test-runner");

    const r2 = await bipar("BIP-CONF-01", "conferir", sessB);
    const j2 = await r2.json();
    expect(j2.aviso).toBe("ja_conferido");

    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("status_separacao, conferido_por, conferido_em")
      .eq("id", id)
      .single();
    expect(ped!.status_separacao).toBe("conferido");
    expect(ped!.conferido_por).toBe(userB);
  });

  it("auto-conferência permitida: mesmo usuário embala e confere (D5)", async () => {
    const id = await seedPedido({ etiqueta_barcodes: ["BIP-AUTOCONF-01"] });
    await bipar("BIP-AUTOCONF-01", "embalar", sessA);
    const res = await bipar("BIP-AUTOCONF-01", "conferir", sessA);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.aviso).toBeNull();
    expect(json.pedido.status_separacao).toBe("conferido");
    expect(json.pedido.conferido_por).toBe(userA);
    void id;
  });

  it("conferir sem registro de embalador funciona (adoção gradual)", async () => {
    const id = await seedPedido({ etiqueta_barcodes: ["BIP-SEMEMB-01"] });
    const res = await bipar("BIP-SEMEMB-01", "conferir", sessB);
    const json = await res.json();
    expect(json.pedido.status_separacao).toBe("conferido");
    expect(json.pedido.embalado_real_por).toBeNull();
    void id;
  });
});

describe("divergência", () => {
  it("registra tipo+obs em pedido conferido", async () => {
    const id = await seedPedido({ etiqueta_barcodes: ["BIP-DIV-01"] });
    await bipar("BIP-DIV-01", "embalar", sessA);
    await bipar("BIP-DIV-01", "conferir", sessB);

    const res = await divergenciaPOST(
      new NextRequest("http://test/api/wms/separacao/conferencia/divergencia", {
        method: "POST",
        headers: { "X-Session-Id": sessB, "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_id: id, tipo: "produto_errado", observacao: "veio filtro de óleo" }),
      }),
    );
    expect(res.status).toBe(200);

    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("divergencia_tipo, divergencia_obs")
      .eq("id", id)
      .single();
    expect(ped!.divergencia_tipo).toBe("produto_errado");
    expect(ped!.divergencia_obs).toBe("veio filtro de óleo");
  });

  it("tipo inválido → 400; pedido não conferido → 422", async () => {
    const id = await seedPedido({ etiqueta_barcodes: ["BIP-DIV-02"] });
    const r400 = await divergenciaPOST(
      new NextRequest("http://test/api/wms/separacao/conferencia/divergencia", {
        method: "POST",
        headers: { "X-Session-Id": sessB, "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_id: id, tipo: "explodiu" }),
      }),
    );
    expect(r400.status).toBe(400);

    const r422 = await divergenciaPOST(
      new NextRequest("http://test/api/wms/separacao/conferencia/divergencia", {
        method: "POST",
        headers: { "X-Session-Id": sessB, "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_id: id, tipo: "faltou_item" }),
      }),
    );
    expect(r422.status).toBe(422);
  });
});

describe("integração com a máquina de status", () => {
  it("voltar-etapa conferido→embalado limpa conferência e divergência", async () => {
    const id = await seedPedido({ etiqueta_barcodes: ["BIP-VOLTAR-01"] });
    await bipar("BIP-VOLTAR-01", "embalar", sessA);
    await bipar("BIP-VOLTAR-01", "conferir", sessB);
    await divergenciaPOST(
      new NextRequest("http://test/api/wms/separacao/conferencia/divergencia", {
        method: "POST",
        headers: { "X-Session-Id": sessB, "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_id: id, tipo: "faltou_item" }),
      }),
    );

    const res = await voltarEtapaPOST(
      new NextRequest("http://test/api/wms/separacao/voltar-etapa", {
        method: "POST",
        headers: { "X-Session-Id": sessA, "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: [id], novo_status: "embalado" }),
      }),
    );
    expect(res.status).toBe(200);

    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("status_separacao, conferido_por, conferido_em, divergencia_tipo, divergencia_obs, embalado_real_por")
      .eq("id", id)
      .single();
    expect(ped!.status_separacao).toBe("embalado");
    expect(ped!.conferido_por).toBeNull();
    expect(ped!.conferido_em).toBeNull();
    expect(ped!.divergencia_tipo).toBeNull();
    // registro do embalador sobrevive (só limpa voltando pra <= separado)
    expect(ped!.embalado_real_por).toBe(userA);
  });

  it("expedir aceita pedido conferido", async () => {
    const id = await seedPedido({ etiqueta_barcodes: ["BIP-EXP-01"] });
    await bipar("BIP-EXP-01", "conferir", sessB);

    const res = await expedirPOST(
      new NextRequest("http://test/api/wms/separacao/expedir", {
        method: "POST",
        headers: { "X-Session-Id": sessA, "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: [id] }),
      }),
    );
    expect(res.status).toBe(200);

    const { data: ped } = await sb
      .from("siso_pedidos").select("status_separacao").eq("id", id).single();
    expect(ped!.status_separacao).toBe("expedido");
  });
});
