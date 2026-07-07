import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ──────────────────────────────────────────────────────────────────
// FULL-01: toggle "Full" na tela Nova venda esconde cliente/CPF/canal e
// posta pra /api/wms/full/criar (sem cliente_nome/canal_venda/modo no
// payload — Full nunca é baixa_direta).
// ──────────────────────────────────────────────────────────────────

type FetchMock = ((url: string, opts?: RequestInit) => Promise<Response>) & {
  mock: { calls: unknown[][] };
};

const h = vi.hoisted(() => ({
  push: vi.fn(),
  sisoFetch: null as unknown as FetchMock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", nome: "Operador" } }),
  usePermissoes: () => ({
    can: () => true,
    canAny: () => true,
    permissoes: new Set(),
  }),
  sisoFetch: (url: string, opts?: RequestInit) => h.sisoFetch(url, opts),
}));

// ProdutoCombo real dispara sua própria busca — stub aqui, mas mantém
// useGalpoes/EmpresaLite/GalpaoLite reais (eles usam o sisoFetch mockado
// acima, então o fixture de galpões abaixo já basta).
vi.mock("@/components/wms/ui/modals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/wms/ui/modals")>();
  return {
    ...actual,
    ProdutoCombo: ({ onChange }: { onChange: (p: unknown) => void }) => (
      <button
        type="button"
        onClick={() => onChange({ id: "prod-1", sku: "SKU-1", descricao: "Produto Teste" })}
      >
        escolher-produto
      </button>
    ),
  };
});

import NovaVendaPage from "../page";

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const GALPOES_FIXTURE = [
  {
    id: "g1",
    nome: "CWB",
    descricao: null,
    siso_empresas: [{ id: "e1", nome: "NetAir", cnpj: "111", ativo: true }],
  },
];

beforeEach(() => {
  cleanup();
  h.push.mockClear();
  h.sisoFetch = vi.fn(async (url: string) => {
    if (url.includes("/api/wms/admin/galpoes")) return jsonOk(GALPOES_FIXTURE);
    if (url.includes("/api/wms/vendas/disponibilidade")) {
      return jsonOk({
        total_disponivel: 100,
        sugestao: {
          localizacao_id: "L1",
          localizacao_codigo: "A-01",
          localizacao_tipo: "picking",
          disponivel: 100,
        },
      });
    }
    if (url.includes("/api/wms/full/criar")) {
      return jsonOk({
        pedido_id: "FULL-abc",
        numero: "FULL-abc",
        status: "executando",
        status_separacao: "aguardando_separacao",
        parcial: false,
        itens_parciais: [],
      });
    }
    return jsonOk({});
  }) as unknown as FetchMock;
});

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderPage() {
  return render(
    <QueryClientProvider client={makeClient()}>
      <NovaVendaPage />
    </QueryClientProvider>,
  );
}

describe("Nova venda — toggle Full", () => {
  it("por padrão mostra Cliente/Canal; ativar Full esconde e mostra Conta ML", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByPlaceholderText("Nome do cliente")).toBeTruthy());
    expect(screen.getByText("Como baixar do estoque")).toBeTruthy();
    expect(screen.getByText("Empresa que vende")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Full" }));

    expect(screen.queryByPlaceholderText("Nome do cliente")).toBeNull();
    expect(screen.queryByPlaceholderText("Opcional")).toBeNull();
    expect(screen.queryByText("Como baixar do estoque")).toBeNull();
    expect(screen.queryByText("Empresa que vende")).toBeNull();
    expect(screen.getByText("Conta ML")).toBeTruthy();
  });

  it("submete Full em /api/wms/full/criar sem cliente_nome/canal_venda/modo no payload", async () => {
    const { container } = renderPage();

    await waitFor(() => expect(screen.getByText("NetAir")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Full" }));

    const selects = container.querySelectorAll("select");
    expect(selects.length).toBe(2); // Conta ML + Galpão (Canal escondido)
    fireEvent.change(selects[0], { target: { value: "e1" } });
    fireEvent.change(selects[1], { target: { value: "g1" } });

    fireEvent.click(screen.getByRole("button", { name: "escolher-produto" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Criar Full e mandar pra separação" }),
    );

    await waitFor(() =>
      expect(
        h.sisoFetch.mock.calls.some(([url]) => url === "/api/wms/full/criar"),
      ).toBe(true),
    );

    const call = h.sisoFetch.mock.calls.find(([url]) => url === "/api/wms/full/criar")!;
    const body = JSON.parse(String((call[1] as RequestInit).body));

    expect(body).toMatchObject({
      empresa_origem_id: "e1",
      galpao_id: "g1",
      items: [{ produto_id: "prod-1", quantidade: 1 }],
    });
    expect(body.cliente_nome).toBeUndefined();
    expect(body.canal_venda).toBeUndefined();
    expect(body.modo).toBeUndefined();

    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/wms/separacao-full"));
  });

  it("checkbox 'Separar na ordem da lista' manda preservar_linhas: true no payload", async () => {
    const { container } = renderPage();

    await waitFor(() => expect(screen.getByText("NetAir")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Full" }));

    // Default: desligado → flag ausente.
    const checkbox = container.querySelector(
      "input[type=checkbox]",
    ) as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);

    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "e1" } });
    fireEvent.change(selects[1], { target: { value: "g1" } });
    fireEvent.click(screen.getByRole("button", { name: "escolher-produto" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Criar Full e mandar pra separação" }),
    );

    await waitFor(() =>
      expect(
        h.sisoFetch.mock.calls.some(([url]) => url === "/api/wms/full/criar"),
      ).toBe(true),
    );
    const call = h.sisoFetch.mock.calls.find(([url]) => url === "/api/wms/full/criar")!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.preservar_linhas).toBe(true);
  });
});
