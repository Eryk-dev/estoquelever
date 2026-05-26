import { describe, it, expect } from "vitest";
import { calcularExpiraEm, estornarReservaIndividual } from "./reservas";
import type { EstornarReservaInput, EstornarReservaDeps } from "./reservas";

describe("calcularExpiraEm", () => {
  it("default 48h adiciona 48h ao now", () => {
    const now = new Date("2026-01-01T10:00:00Z");
    const r = calcularExpiraEm({ now, horas: 48 });
    expect(r.toISOString()).toBe("2026-01-03T10:00:00.000Z");
  });

  it("ttl custom 12h", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(calcularExpiraEm({ now, horas: 12 }).toISOString()).toBe(
      "2026-01-01T12:00:00.000Z",
    );
  });

  it("default sem opts usa 48h", () => {
    const before = Date.now();
    const r = calcularExpiraEm();
    const diff = r.getTime() - before;
    expect(diff).toBeGreaterThan(48 * 3600 * 1000 - 1000);
    expect(diff).toBeLessThan(48 * 3600 * 1000 + 1000);
  });
});

// ---------------------------------------------------------------------------
// Helpers pra montar stubs in-memory alinhados com o estilo do projeto
// (sem vi.mock — deps injetadas via _deps opcional, como roteamento.ts usa
// buscarLinha callback).
// ---------------------------------------------------------------------------

const R_ID_1 = "00000000-0000-4000-8000-000000000001";
const R_ID_2 = "00000000-0000-4000-8000-000000000002";
const R_ID_MISSING = "00000000-0000-4000-8000-000000000000";
const L_EXISTENTE_ID = "00000000-0000-4000-8000-000000000999";
const L_NOVO_ID = "00000000-0000-4000-8000-000000000aaa";

/** Reserva em memória (simula linha em siso_movimentacoes tipo='R'). */
const reservaStub = {
  produto_id: "00000000-0000-4000-8000-000000000011",
  galpao_id: "00000000-0000-4000-8000-000000000022",
  localizacao_id: "00000000-0000-4000-8000-000000000033",
  quantidade: 3,
};

/** Constrói deps stub para estornarReservaIndividual. */
function makeDeps(opts: {
  /** Se true, pré-popula um L com estorno_de=R_ID_2 (test de idempotência). */
  lExistenteParaId2?: boolean;
  /** IDs de R que existem no stub (default: R_ID_1 existe). */
  reservasExistentes?: string[];
  /** Guarda o id de L criado pelo inserirMovimentacao stub. */
  insertedL?: { id?: string };
}): EstornarReservaDeps {
  const {
    lExistenteParaId2 = false,
    reservasExistentes = [R_ID_1],
    insertedL = {},
  } = opts;

  return {
    buscarLExistente: async (reserva_id: string) => {
      if (lExistenteParaId2 && reserva_id === R_ID_2) {
        return L_EXISTENTE_ID;
      }
      return null;
    },
    buscarReservaOriginal: async (reserva_id: string) => {
      if (reservasExistentes.includes(reserva_id)) {
        return { ...reservaStub };
      }
      return null;
    },
    inserirL: async () => {
      const id = L_NOVO_ID;
      insertedL.id = id;
      return id;
    },
  };
}

describe("estornarReservaIndividual", () => {
  it("insere L com estorno_de = reserva_id e retorna o id do L", async () => {
    const insertedL: { id?: string } = {};
    const deps = makeDeps({ insertedL });

    const input: EstornarReservaInput = {
      reserva_id: R_ID_1,
      motivo: "rollback_aprovacao",
    };
    const novoLId = await estornarReservaIndividual(input, deps);

    // Retorna um uuid válido
    expect(novoLId).toMatch(/^[0-9a-f-]{36}$/i);
    // O inserirL stub foi chamado (insertedL.id preenchido)
    expect(insertedL.id).toBe(L_NOVO_ID);
    expect(novoLId).toBe(L_NOVO_ID);
  });

  it("é idempotente: se já existe L com estorno_de=reserva_id, retorna o id existente sem criar novo", async () => {
    const insertedL: { id?: string } = {};
    const deps = makeDeps({ lExistenteParaId2: true, insertedL });

    const input: EstornarReservaInput = {
      reserva_id: R_ID_2,
      motivo: "rollback_aprovacao",
    };
    const id = await estornarReservaIndividual(input, deps);

    expect(id).toBe(L_EXISTENTE_ID);
    // inserirL NÃO deve ter sido chamado
    expect(insertedL.id).toBeUndefined();
  });

  it("lança se reserva_id não corresponde a nenhuma R em siso_movimentacoes", async () => {
    const deps = makeDeps({ reservasExistentes: [] });

    const input: EstornarReservaInput = {
      reserva_id: R_ID_MISSING,
      motivo: "rollback_aprovacao",
    };
    await expect(estornarReservaIndividual(input, deps)).rejects.toThrow(
      /reserva.*n[ãa]o.*encontrada/i,
    );
  });
});
