import { describe, it, expect, vi } from "vitest";
import { resetarEstadoSeparacaoItens } from "./reset-state";

type SeedItem = {
  id: number;
  pedido_id?: string;
  mov_saida_id: string | null;
  mov_ajuste_loc_zerou_id: string | null;
  separacao_parcial?: boolean;
  quantidade_pega?: number | null;
};

type SeedRealoc = {
  id: string;
  pedido_item_id: number;
  status: "aguardando_picking" | "picado" | "picado_parcial" | "cancelado";
  mov_saida_id: string | null;
};

type SeedLink = {
  id: string;
  pedido_item_id: number;
  mov_id: string;
  qty: number;
  tipo_link: "saida" | "ajuste_loc_zerou";
};

interface SupabaseSeed {
  items: SeedItem[];
  realocs: SeedRealoc[];
  links: SeedLink[];
}

/**
 * Mock chainable supabase client for unit tests.
 *
 * Supports:
 *   .from(table).select(cols).in(col, ids)         → resolves to { data, error: null }
 *   .from(table).update(patch).in(col, ids)        → mutates seed in-memory, resolves { error: null }
 *   .from(table).delete().in(col, ids)             → removes from seed, resolves { error: null }
 *
 * All operations record their calls on the returned `calls` map for assertions.
 */
function mockSupabase(seed: SupabaseSeed) {
  const calls: {
    selects: Array<{ table: string; cols: string; filter?: { col: string; val: unknown[] } }>;
    updates: Array<{ table: string; patch: Record<string, unknown>; filter?: { col: string; val: unknown[] } }>;
    deletes: Array<{ table: string; filter?: { col: string; val: unknown[] } }>;
  } = { selects: [], updates: [], deletes: [] };

  function pickRows(table: string): Array<Record<string, unknown>> {
    if (table === "siso_pedido_itens") return seed.items as unknown as Array<Record<string, unknown>>;
    if (table === "siso_pedido_item_realocacoes")
      return seed.realocs as unknown as Array<Record<string, unknown>>;
    if (table === "siso_pedido_item_mov_links")
      return seed.links as unknown as Array<Record<string, unknown>>;
    return [];
  }

  function applyFilter<T extends Record<string, unknown>>(
    rows: T[],
    col: string,
    values: unknown[],
  ): T[] {
    return rows.filter((r) => values.includes(r[col]));
  }

  function makeSelectBuilder(table: string, cols: string) {
    const builder = {
      in(col: string, values: unknown[]) {
        calls.selects.push({ table, cols, filter: { col, val: values } });
        const rows = applyFilter(pickRows(table), col, values);
        return Promise.resolve({ data: rows, error: null });
      },
      eq(col: string, value: unknown) {
        calls.selects.push({ table, cols, filter: { col, val: [value] } });
        const rows = applyFilter(pickRows(table), col, [value]);
        return Promise.resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  function makeUpdateBuilder(table: string, patch: Record<string, unknown>) {
    return {
      in(col: string, values: unknown[]) {
        calls.updates.push({ table, patch, filter: { col, val: values } });
        const rows = pickRows(table);
        for (const r of rows) {
          if (values.includes(r[col])) {
            Object.assign(r, patch);
          }
        }
        return Promise.resolve({ data: null, error: null });
      },
      eq(col: string, value: unknown) {
        calls.updates.push({ table, patch, filter: { col, val: [value] } });
        const rows = pickRows(table);
        for (const r of rows) {
          if (r[col] === value) Object.assign(r, patch);
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  function makeDeleteBuilder(table: string) {
    return {
      in(col: string, values: unknown[]) {
        calls.deletes.push({ table, filter: { col, val: values } });
        if (table === "siso_pedido_item_mov_links") {
          seed.links = seed.links.filter((r) => !values.includes((r as Record<string, unknown>)[col]));
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  const client = {
    from(table: string) {
      return {
        select(cols: string) {
          return makeSelectBuilder(table, cols);
        },
        update(patch: Record<string, unknown>) {
          return makeUpdateBuilder(table, patch);
        },
        delete() {
          return makeDeleteBuilder(table);
        },
      };
    },
  };

  return { client, calls, seed };
}

describe("resetarEstadoSeparacaoItens", () => {
  it("cancela realocs aguardando + estorna mov_saida + reseta campos", async () => {
    const { client } = mockSupabase({
      items: [
        {
          id: 1,
          pedido_id: "ped-1",
          mov_saida_id: "mov-1",
          mov_ajuste_loc_zerou_id: "aj-1",
          separacao_parcial: true,
          quantidade_pega: 3,
        },
      ],
      realocs: [
        { id: "r-1", pedido_item_id: 1, status: "aguardando_picking", mov_saida_id: null },
        { id: "r-2", pedido_item_id: 1, status: "picado", mov_saida_id: "mov-2" },
      ],
      links: [],
    });
    const estornar = vi.fn().mockResolvedValue({ id: "estorno-X" });

    const result = await resetarEstadoSeparacaoItens({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
      itemIds: [1],
      usuarioId: "u-1",
      motivo: "encaminhar",
      estornarMov: estornar,
    });

    expect(estornar).toHaveBeenCalledWith({
      mov_id: "mov-1",
      usuario_id: "u-1",
      motivo: expect.stringContaining("encaminhar"),
    });
    expect(estornar).toHaveBeenCalledWith({
      mov_id: "mov-2",
      usuario_id: "u-1",
      motivo: expect.any(String),
    });

    // bug C2 guard: mov_ajuste_loc_zerou_id is NEVER estornada
    const callsWithAjuste = estornar.mock.calls.filter(
      ([arg]) => (arg as { mov_id: string }).mov_id === "aj-1",
    );
    expect(callsWithAjuste).toHaveLength(0);

    expect(result.estornadas.sort()).toEqual(["mov-1", "mov-2"]);
    expect(result.realocsCanceladas).toBe(1); // só a aguardando_picking
  });

  it("idempotência: rodar 2x não estorna 2x", async () => {
    const seed = {
      items: [
        {
          id: 7,
          pedido_id: "ped-7",
          mov_saida_id: null, // já resetada
          mov_ajuste_loc_zerou_id: null,
          separacao_parcial: false,
          quantidade_pega: null,
        },
      ],
      realocs: [
        { id: "r-9", pedido_item_id: 7, status: "cancelado" as const, mov_saida_id: null },
      ],
      links: [],
    };
    const { client } = mockSupabase(seed);
    const estornar = vi.fn().mockResolvedValue({ id: "estorno-N" });

    const result = await resetarEstadoSeparacaoItens({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
      itemIds: [7],
      usuarioId: "u-2",
      motivo: "reiniciar",
      estornarMov: estornar,
    });

    expect(estornar).not.toHaveBeenCalled();
    expect(result.estornadas).toEqual([]);
    expect(result.realocsCanceladas).toBe(0);
  });

  it("dedup: mov_saida_id do item e link de saida do mesmo mov_id não duplica estorno", async () => {
    const { client } = mockSupabase({
      items: [
        {
          id: 2,
          pedido_id: "ped-2",
          mov_saida_id: "mov-shared",
          mov_ajuste_loc_zerou_id: null,
          separacao_parcial: false,
          quantidade_pega: 5,
        },
      ],
      realocs: [],
      links: [
        { id: "lk-1", pedido_item_id: 2, mov_id: "mov-shared", qty: 5, tipo_link: "saida" },
        { id: "lk-2", pedido_item_id: 2, mov_id: "mov-ajuste-only", qty: 2, tipo_link: "ajuste_loc_zerou" },
      ],
    });
    const estornar = vi.fn().mockResolvedValue({ id: "x" });

    const result = await resetarEstadoSeparacaoItens({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
      itemIds: [2],
      usuarioId: "u-3",
      motivo: "voltar_etapa",
      estornarMov: estornar,
    });

    // mov-shared só estornada UMA vez (dedup item.mov_saida_id × link de saida)
    const sharedCalls = estornar.mock.calls.filter(
      ([arg]) => (arg as { mov_id: string }).mov_id === "mov-shared",
    );
    expect(sharedCalls).toHaveLength(1);

    // mov-ajuste-only NUNCA estornada (link tipo='ajuste_loc_zerou' — bug C2)
    const ajusteCalls = estornar.mock.calls.filter(
      ([arg]) => (arg as { mov_id: string }).mov_id === "mov-ajuste-only",
    );
    expect(ajusteCalls).toHaveLength(0);

    expect(result.estornadas).toEqual(["mov-shared"]);
  });

  it("re-throws non-idempotent estorno errors", async () => {
    const { client } = mockSupabase({
      items: [
        {
          id: 1,
          pedido_id: "ped-1",
          mov_saida_id: "mov-x",
          mov_ajuste_loc_zerou_id: null,
          separacao_parcial: true,
          quantidade_pega: 1,
        },
      ],
      realocs: [],
      links: [],
    });
    const estornar = vi.fn().mockRejectedValue(new Error("mov não encontrada"));

    await expect(
      resetarEstadoSeparacaoItens({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase: client as any,
        itemIds: [1],
        usuarioId: "u-1",
        motivo: "encaminhar",
        estornarMov: estornar,
      }),
    ).rejects.toThrow(/não encontrada/);
  });

  it("ignora erros de 'já estornada' sem propagar", async () => {
    const { client } = mockSupabase({
      items: [
        {
          id: 3,
          pedido_id: "ped-3",
          mov_saida_id: "mov-already",
          mov_ajuste_loc_zerou_id: null,
          separacao_parcial: false,
          quantidade_pega: 1,
        },
      ],
      realocs: [],
      links: [],
    });
    const estornar = vi.fn().mockRejectedValue(new Error("mov mov-already já foi estornada"));

    const result = await resetarEstadoSeparacaoItens({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
      itemIds: [3],
      usuarioId: "u-4",
      motivo: "esgotado",
      estornarMov: estornar,
    });

    // Erro de double-estorno é tolerado — mov não entra em `estornadas`
    expect(result.estornadas).toEqual([]);
    expect(estornar).toHaveBeenCalledTimes(1);
  });
});
