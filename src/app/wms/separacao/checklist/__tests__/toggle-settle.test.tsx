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
// Regressão + hardening: completar a linha PEGAR de um parcial-em-progresso.
//
// Bug original: o operador fazia um parcial (pega 2 de 5, sem loc_zerou). A UI
// mostrava 2 linhas — PEGO ✓ + PEGAR. Clicar no checkbox da PEGAR chamava
// marcar-item (o backend DAVA a baixa correta), mas a tela NUNCA refletia:
//   - handleToggle só fazia invalidate no catch (erro), nunca no sucesso;
//   - o optimistic só flipava separacao_marcado, invisível na linha PEGAR (done
//     fixo em false), e o split PEGO/PEGAR deriva de quantidade_pega/restante;
//   - useRealtimeSeparacao não escuta siso_pedido_itens e refetchOnWindowFocus
//     é false → nada re-buscava.
// Resultado: a linha PEGAR ficava "travada" como se o checkbox não clicasse;
// pior, um 2º clique na linha aparentemente-desmarcada revertia a baixa.
//
// Estes testes cobrem:
//   1. settle no sucesso re-busca o checklist e colapsa o split;
//   2. o optimistic colapsa a linha NA HORA (antes do refetch) e preserva o
//      banner saldo-apareceu (campo `pedidos`);
//   3. depois de concluído, um 2º clique é desmarcação intencional (marcado:false);
//   4. linha concluída exibe a quantidade cheia, nunca "0" (cosmético).
// ──────────────────────────────────────────────────────────────────

type FetchMock = ((url: string, opts?: RequestInit) => Promise<Response>) & {
  mock: { calls: unknown[][] };
};

type Gate = { promise: Promise<void>; resolve: () => void };

const h = vi.hoisted(() => ({
  state: {
    completed: false,
    unmarked: false,
    getCount: 0,
    flag: false, // flag_saldo_apareceu
    gate: null as Gate | null, // bloqueia a re-busca do settle quando setado
  },
  // atribuído no beforeEach
  sisoFetch: null as unknown as FetchMock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("pedidos=P1"),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", nome: "Operador" } }),
  // Delega pro mock controlável definido no beforeEach.
  sisoFetch: (url: string, opts?: RequestInit) => h.sisoFetch(url, opts),
}));

vi.mock("@/hooks/use-realtime-separacao", () => ({
  useRealtimeSeparacao: () => {},
}));
vi.mock("@/hooks/use-presenca-wms", () => ({
  useTrackPresencaWms: () => {},
}));
// ParcialModal não é exercitado aqui (começa fechado) — stub pra evitar a cadeia
// de imports do modal real.
vi.mock("@/components/wms/separacao/parcial-modal", () => ({
  ParcialModal: () => null,
}));

import WmsChecklistPage from "../page";

function jsonOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function deferred(): Gate {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Item normal em parcial-em-progresso: pediu 5, já pegou 2, não marcado.
// saldo/disponivel altos pra que o número "5" só apareça como quantidade exibida.
const baseItem = {
  id: "10",
  pedido_id: "P1",
  produto_id: "999",
  sku: "SKU-1",
  gtin: null,
  descricao: "Produto Teste",
  quantidade: 5,
  separacao_marcado: false,
  separacao_marcado_em: null,
  localizacao: "A-01",
  imagem_url: null,
  empresa_origem_id: "E1",
  saldo: 20,
  disponivel: 20,
  galpao_nome: "CWB",
  compra_status: null,
  quantidade_pega: 2,
  separacao_parcial: false,
  parcial_motivo: null,
  parcial_em: null,
  realocacoes: [],
};

const completedItem = () => ({
  ...baseItem,
  quantidade_pega: baseItem.quantidade,
  separacao_marcado: true,
});
const unmarkedItem = () => ({
  ...baseItem,
  quantidade_pega: null,
  separacao_marcado: false,
});

function currentItem() {
  if (h.state.unmarked) return unmarkedItem();
  if (h.state.completed) return completedItem();
  return { ...baseItem };
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
  h.state.completed = false;
  h.state.unmarked = false;
  h.state.getCount = 0;
  h.state.flag = false;
  h.state.gate = null;
  h.sisoFetch = vi.fn(async (url: string, opts?: RequestInit) => {
    if (url.includes("/separacao/iniciar")) return jsonOk({});
    if (url.includes("/separacao/checklist-items")) {
      h.state.getCount++;
      // Gate opcional: bloqueia a re-busca do settle (2ª GET em diante) pra
      // observar o estado do optimistic ANTES da reconciliação com o servidor.
      if (h.state.gate && h.state.getCount >= 2) {
        await h.state.gate.promise;
      }
      return jsonOk({
        items: [currentItem()],
        pedidos: [
          {
            id: "P1",
            status_separacao: "em_separacao",
            flag_saldo_apareceu: h.state.flag,
          },
        ],
      });
    }
    if (url.includes("/separacao/marcar-item")) {
      const marcado = opts ? JSON.parse(String(opts.body)).marcado : true;
      if (marcado) {
        h.state.completed = true;
        h.state.unmarked = false;
        return jsonOk(completedItem());
      }
      h.state.completed = false;
      h.state.unmarked = true;
      return jsonOk(unmarkedItem());
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

function marcarItemBodies(): Array<{ marcado: boolean }> {
  return h.sisoFetch.mock.calls
    .filter((c) => String(c[0]).includes("/separacao/marcar-item"))
    .map((c) => JSON.parse(String((c[1] as RequestInit | undefined)?.body)));
}

describe("checklist — completar linha PEGAR (settle + optimistic)", () => {
  it("1) re-busca o checklist e colapsa o split PEGO/PEGAR ao marcar a PEGAR", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText(/PEGAR/)).toBeTruthy());
    const getsAntes = h.state.getCount;

    fireEvent.click(screen.getByRole("button", { name: /marcar item/i }));

    await waitFor(() =>
      expect(marcarItemBodies().some((b) => b.marcado === true)).toBe(true),
    );
    // settle re-busca…
    await waitFor(() => expect(h.state.getCount).toBeGreaterThan(getsAntes));
    // …e o split colapsa.
    await waitFor(() => expect(screen.queryByText(/PEGAR/)).toBeNull());
  });

  it("2) optimistic colapsa a linha NA HORA e preserva o banner saldo-apareceu", async () => {
    h.state.flag = true; // banner ligado
    h.state.gate = deferred(); // segura a re-busca do settle
    renderPage();

    await waitFor(() => expect(screen.getByText(/PEGAR/)).toBeTruthy());
    expect(screen.getByText(/Saldo apareceu/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /marcar item/i }));

    // A 2ª GET (settle) começou mas está bloqueada no gate — antes dela
    // resolver, o optimistic já colapsou a PEGAR e manteve o banner.
    await waitFor(() => expect(h.state.getCount).toBe(2));
    expect(screen.queryByText(/PEGAR/)).toBeNull();
    expect(screen.getByText(/Saldo apareceu/)).toBeTruthy();

    h.state.gate.resolve();
    await waitFor(() => expect(screen.queryByText(/PEGAR/)).toBeNull());
  });

  it("3) 2º clique na linha já concluída desmarca (marcado:false), não fica preso", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText(/PEGAR/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /marcar item/i }));

    // Colapsou pra linha "concluída" (checkbox vira "Desmarcar item").
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /desmarcar item/i }),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /desmarcar item/i }));

    await waitFor(() =>
      expect(marcarItemBodies().some((b) => b.marcado === false)).toBe(true),
    );
  });

  it("4) cosmético: item concluído exibe a quantidade cheia, nunca '0'", async () => {
    h.state.completed = true; // já 100% pego/marcado
    renderPage();

    // A célula de quantidade mostra 5 (pedida), não 0.
    await waitFor(() => expect(screen.getByText("5")).toBeTruthy());
    expect(screen.queryByText(/PEGAR/)).toBeNull();
  });
});
