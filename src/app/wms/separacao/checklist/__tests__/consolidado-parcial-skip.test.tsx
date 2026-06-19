import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ──────────────────────────────────────────────────────────────────
// Regressão: um item em separacao_parcial NÃO pode travar a linha consolidada.
//
// Bug original: o wave consolida o mesmo SKU de N pedidos numa linha só
// (item_ids[]). Quando UM desses itens foi parcial via loc_zerou
// (separacao_parcial=true, já marcado), clicar o checkbox loopava TODOS os
// item_ids no marcar-item — que retorna 409 pra parcial. O loop era sequencial
// com abort no 1º erro, então o parcial abortava a linha inteira e os
// pedidos-irmãos normais NUNCA eram marcados → o wave não concluía.
//
// Fix: o toggle pula os itens parciais (espelha o skip do scanner
// bipar-checklist) e marca só os normais. Este teste prova que o parcial ("11")
// nunca chega ao marcar-item e o item normal ("10") é marcado.
// ──────────────────────────────────────────────────────────────────

type FetchMock = ((url: string, opts?: RequestInit) => Promise<Response>) & {
  mock: { calls: unknown[][] };
};

const h = vi.hoisted(() => ({
  state: { item10Marcado: false },
  sisoFetch: null as unknown as FetchMock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("pedidos=P1,P2"),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", nome: "Operador" } }),
  sisoFetch: (url: string, opts?: RequestInit) => h.sisoFetch(url, opts),
}));

vi.mock("@/hooks/use-realtime-separacao", () => ({
  useRealtimeSeparacao: () => {},
}));
vi.mock("@/hooks/use-presenca-wms", () => ({
  useTrackPresencaWms: () => {},
}));
vi.mock("@/components/wms/separacao/parcial-modal", () => ({
  ParcialModal: () => null,
}));

import WmsChecklistPage from "../page";

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function json409(body: unknown) {
  return { ok: false, status: 409, json: async () => body } as unknown as Response;
}

// Mesmo SKU/produto em 2 pedidos do wave → 1 linha consolidada.
// "10": normal, aberto (pediu 5, não marcado).
// "11": parcial via loc_zerou (pediu 5, pegou 5, já marcado + separacao_parcial).
const itemBase = {
  produto_id: "999",
  sku: "SKU-1",
  gtin: null,
  descricao: "Produto Teste",
  localizacao: "A-01",
  imagem_url: null,
  empresa_origem_id: "E1",
  separacao_galpao_id: "G1",
  saldo: 20,
  disponivel: 20,
  galpao_nome: "CWB",
  compra_status: null,
  parcial_motivo: null,
  parcial_em: null,
  realocacoes: [],
};

function itensAtuais() {
  return [
    {
      ...itemBase,
      id: "10",
      pedido_id: "P1",
      quantidade: 5,
      quantidade_pega: h.state.item10Marcado ? 5 : 0,
      separacao_marcado: h.state.item10Marcado,
      separacao_marcado_em: h.state.item10Marcado ? "2026-06-19T00:00:00Z" : null,
      separacao_parcial: false,
    },
    {
      ...itemBase,
      id: "11",
      pedido_id: "P2",
      quantidade: 5,
      quantidade_pega: 5,
      separacao_marcado: true,
      separacao_marcado_em: "2026-06-19T00:00:00Z",
      separacao_parcial: true,
      parcial_motivo: "loc_zerou",
    },
  ];
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

beforeEach(() => {
  cleanup();
  h.state.item10Marcado = false;
  h.sisoFetch = vi.fn(async (url: string, opts?: RequestInit) => {
    if (url.includes("/separacao/iniciar")) return jsonOk({});
    if (url.includes("/separacao/checklist-items")) {
      return jsonOk({
        items: itensAtuais(),
        pedidos: [
          { id: "P1", status_separacao: "em_separacao", flag_saldo_apareceu: false },
          { id: "P2", status_separacao: "em_separacao", flag_saldo_apareceu: false },
        ],
      });
    }
    if (url.includes("/separacao/marcar-item")) {
      const id = String(JSON.parse(String(opts?.body)).pedido_item_id);
      // O parcial 409a — mas o fix deve impedir que ele chegue aqui.
      if (id === "11") {
        return json409({
          error:
            "item está em parcial — cancele a separação inteira (checklist) ou peça pro supervisor desfazer o parcial",
        });
      }
      h.state.item10Marcado = true;
      return jsonOk({});
    }
    return jsonOk({});
  }) as unknown as FetchMock;
});

function renderPage() {
  render(
    <QueryClientProvider client={makeClient()}>
      <WmsChecklistPage />
    </QueryClientProvider>,
  );
}

function marcarItemIds(): string[] {
  return h.sisoFetch.mock.calls
    .filter((c) => String(c[0]).includes("/separacao/marcar-item"))
    .map((c) =>
      String(JSON.parse(String((c[1] as RequestInit | undefined)?.body)).pedido_item_id),
    );
}

describe("checklist — parcial não trava a linha consolidada", () => {
  it("pula o item parcial (409) e marca só o normal da linha", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /marcar item/i })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /marcar item/i }));

    // O item normal "10" é marcado…
    await waitFor(() => expect(marcarItemIds()).toContain("10"));
    // …e o parcial "11" NUNCA chega ao marcar-item (skip, sem 409 abortando).
    expect(marcarItemIds()).not.toContain("11");
  });
});
