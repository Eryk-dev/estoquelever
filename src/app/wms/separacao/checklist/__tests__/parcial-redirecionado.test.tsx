import { describe, it, expect } from "vitest";

// ──────────────────────────────────────────────────────────────────
// BUG 2 — parcial loc_zerou com NADA pego marcava o item como "completo".
//   loc_zerou=true marca separacao_marcado=true em TODOS os itens (mesmo
//   quantidade_pega=0). A lista renderizava a linha como done/✓, mentindo que
//   foi separado quando nada foi pego. concluir JÁ trava via realocação
//   pendente, então o conserto é só de exibição: o item redirecionado some da
//   lista principal (a linha da Realocação indica onde pegar).
//
// BUG 1b — trocar a loc de um item reordenava a lista (pulava de lugar). O pin
//   de ordenação congela a posição do item trocado pela loc PRÉ-troca.
// ──────────────────────────────────────────────────────────────────

// Mocks só pra o módulo "use client" importar limpo (não renderizamos nada —
// chamamos apenas as funções puras exportadas).
import { vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("pedidos=P1"),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: null }),
  sisoFetch: vi.fn(),
}));
vi.mock("@/hooks/use-realtime-separacao", () => ({ useRealtimeSeparacao: () => {} }));
vi.mock("@/hooks/use-presenca-wms", () => ({ useTrackPresencaWms: () => {} }));
vi.mock("@/components/wms/separacao/parcial-modal", () => ({ ParcialModal: () => null }));

import { consolidar, ordenar, itemRedirecionadoSemPick } from "../page";

type Item = Parameters<typeof itemRedirecionadoSemPick>[0];

function mkItem(over: Partial<Item> & { id: string; produto_id: string }): Item {
  return {
    pedido_id: "P1",
    sku: `SKU-${over.produto_id}`,
    gtin: null,
    descricao: "Produto",
    quantidade: 5,
    separacao_marcado: false,
    separacao_marcado_em: null,
    localizacao: "A-01",
    imagem_url: null,
    imagens: [],
    empresa_origem_id: "E1",
    separacao_galpao_id: "G1",
    saldo: 20,
    disponivel: 20,
    locs_disponiveis: 2,
    galpao_nome: "CWB",
    compra_status: null,
    quantidade_pega: null,
    separacao_parcial: false,
    parcial_motivo: null,
    parcial_em: null,
    realocacoes: [],
    ...over,
  } as Item;
}

const realocAtiva = {
  id: "r1",
  parent_realocacao_id: null,
  localizacao_id: "loc-B",
  localizacao_codigo: "B-02",
  quantidade: 5,
  quantidade_pega: null,
  parcial: false,
  parcial_motivo: null,
  status: "aguardando_picking" as const,
  criado_em: "2026-06-23T00:00:00Z",
};

describe("itemRedirecionadoSemPick (BUG 2)", () => {
  it("TRUE: parcial loc_zerou, nada pego, realocação ativa", () => {
    const it = mkItem({
      id: "1",
      produto_id: "999",
      separacao_marcado: true,
      separacao_parcial: true,
      parcial_motivo: "loc_zerou",
      quantidade_pega: 0,
      realocacoes: [realocAtiva],
    });
    expect(itemRedirecionadoSemPick(it)).toBe(true);
  });

  it("FALSE: item normal (sem parcial)", () => {
    expect(itemRedirecionadoSemPick(mkItem({ id: "1", produto_id: "999" }))).toBe(false);
  });

  it("FALSE: parcial com ALGO pego (qty_pega>0) — vira split PEGO/PEGAR", () => {
    const it = mkItem({
      id: "1",
      produto_id: "999",
      separacao_parcial: true,
      quantidade_pega: 3,
      realocacoes: [realocAtiva],
    });
    expect(itemRedirecionadoSemPick(it)).toBe(false);
  });

  it("FALSE: realocação já picada (qty_pega volta a >0, linha reaparece done)", () => {
    const it = mkItem({
      id: "1",
      produto_id: "999",
      separacao_parcial: true,
      quantidade_pega: 5,
      realocacoes: [{ ...realocAtiva, status: "picado", quantidade_pega: 5 }],
    });
    expect(itemRedirecionadoSemPick(it)).toBe(false);
  });

  it("FALSE: parcial sem cobertura (sem realocação ativa)", () => {
    const it = mkItem({
      id: "1",
      produto_id: "999",
      separacao_parcial: true,
      quantidade_pega: 0,
      realocacoes: [],
    });
    expect(itemRedirecionadoSemPick(it)).toBe(false);
  });
});

describe("consolidar + filtro redirecionado (BUG 2)", () => {
  it("o SKU redirecionado some da lista principal; o normal fica", () => {
    const items = [
      mkItem({ id: "1", produto_id: "111" }), // normal
      mkItem({
        id: "2",
        produto_id: "999",
        separacao_marcado: true,
        separacao_parcial: true,
        parcial_motivo: "loc_zerou",
        quantidade_pega: 0,
        realocacoes: [realocAtiva],
      }),
    ];
    const visiveis = items.filter((it) => !itemRedirecionadoSemPick(it));
    const { itensNormais } = consolidar(visiveis);
    const produtoIds = itensNormais.map((p) => p.produto_id);
    expect(produtoIds).toContain("111");
    expect(produtoIds).not.toContain("999");
  });
});

describe("ordenar com pin (BUG 1b)", () => {
  // 3 produtos: A-01, C-03, E-05. Ordenado por loc → [A, C, E].
  function produtos() {
    const items = [
      mkItem({ id: "1", produto_id: "AAA", localizacao: "A-01" }),
      mkItem({ id: "2", produto_id: "CCC", localizacao: "C-03" }),
      mkItem({ id: "3", produto_id: "EEE", localizacao: "E-05" }),
    ];
    return consolidar(items).itensNormais;
  }

  it("sem pin: ordena pela loc atual", () => {
    const ord = ordenar(produtos(), "localizacao");
    expect(ord.map((p) => p.produto_id)).toEqual(["AAA", "CCC", "EEE"]);
  });

  it("com pin: item que trocou a loc (A-01→Z-99) NÃO pula — fica na posição da loc pré-troca", () => {
    // Simula: produto AAA trocou pra Z-99 (display vira Z-99 no refetch), mas o
    // pin guarda A-01 como sort key → continua em 1º, não vai pro fim.
    const rows = produtos().map((p) =>
      p.produto_id === "AAA" ? { ...p, localizacao: "Z-99" } : p,
    );
    const pin = new Map<string, string | null>([["AAA_norm", "A-01"]]);
    const ord = ordenar(rows, "localizacao", pin);
    expect(ord.map((p) => p.produto_id)).toEqual(["AAA", "CCC", "EEE"]);

    // Sem o pin, AAA (agora Z-99) iria pro fim — prova que o pin é o que segura.
    const semPin = ordenar(rows, "localizacao");
    expect(semPin.map((p) => p.produto_id)).toEqual(["CCC", "EEE", "AAA"]);
  });
});
