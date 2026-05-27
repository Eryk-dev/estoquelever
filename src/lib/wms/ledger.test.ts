import { describe, it, expect } from "vitest";
import { calcularPosteriores, validarCoerencia, inserirMovimentacao } from "./ledger";

describe("calcularPosteriores", () => {
  it("entrada (E): incrementa saldo, reservado inalterado", () => {
    const r = calcularPosteriores({ tipo: "E", qty: 10, saldoAnterior: 5, reservadoAnterior: 2 });
    expect(r).toEqual({ saldo_posterior: 15, reservado_posterior: 2 });
  });

  it("saída (S): decrementa saldo, reservado inalterado", () => {
    const r = calcularPosteriores({ tipo: "S", qty: 3, saldoAnterior: 10, reservadoAnterior: 4 });
    expect(r).toEqual({ saldo_posterior: 7, reservado_posterior: 4 });
  });

  it("reserva (R): saldo inalterado, reservado +qty", () => {
    const r = calcularPosteriores({ tipo: "R", qty: 2, saldoAnterior: 10, reservadoAnterior: 1 });
    expect(r).toEqual({ saldo_posterior: 10, reservado_posterior: 3 });
  });

  it("liberação (L): saldo inalterado, reservado -qty", () => {
    const r = calcularPosteriores({ tipo: "L", qty: 2, saldoAnterior: 10, reservadoAnterior: 5 });
    expect(r).toEqual({ saldo_posterior: 10, reservado_posterior: 3 });
  });
});

describe("validarCoerencia", () => {
  it("rejeita saída com saldo insuficiente", () => {
    expect(() =>
      validarCoerencia({ tipo: "S", qty: 10, saldoAnterior: 5, reservadoAnterior: 0 }),
    ).toThrow(/saldo insuficiente/i);
  });

  it("rejeita reserva quando reservado_posterior > saldo_posterior", () => {
    expect(() =>
      validarCoerencia({ tipo: "R", qty: 5, saldoAnterior: 10, reservadoAnterior: 8 }),
    ).toThrow(/reservado.*saldo/i);
  });

  it("rejeita liberação maior que reservado", () => {
    expect(() =>
      validarCoerencia({ tipo: "L", qty: 10, saldoAnterior: 10, reservadoAnterior: 5 }),
    ).toThrow(/libera|reservado/i);
  });

  it("aceita movimento válido", () => {
    expect(() =>
      validarCoerencia({ tipo: "E", qty: 1, saldoAnterior: 0, reservadoAnterior: 0 }),
    ).not.toThrow();
  });
});

describe("inserirMovimentacao · uuid validation (defensiva)", () => {
  // Triplas com uuids válidos pra não falhar antes da validação do campo testado.
  const triplaOk = {
    produto_id: "00000000-0000-4000-8000-000000000001",
    galpao_id: "00000000-0000-4000-8000-000000000002",
    localizacao_id: "00000000-0000-4000-8000-000000000003",
  };

  it("NÃO valida pedido_id como uuid — coluna é text por design (aceita 'MAN-...' de venda manual)", async () => {
    // Migration 20260526_movimentacoes_origem_id_pedido_id_text.sql tornou
    // siso_movimentacoes.pedido_id TEXT (era uuid). `MAN-...` agora cabe
    // direto na coluna; antes a validação defensiva impedia. P6 E.19 popula
    // pedido_id em vendas/criar baixa_direta — esse teste protege a remoção
    // do assertUuidLike contra reintrodução acidental.
    let caughtMsg = "";
    try {
      await inserirMovimentacao({
        tripla: triplaOk,
        tipo: "S",
        qty: 1,
        origem_tipo: "venda_manual",
        pedido_id: "MAN-abc-123",
      });
    } catch (err) {
      caughtMsg = err instanceof Error ? err.message : String(err);
    }
    // Deve falhar APENAS por createServiceClient() faltar env (chamada bate
    // no DB) — NÃO por validação de uuid.
    expect(caughtMsg).not.toMatch(/pedido_id/);
  });

  it("NÃO valida origem_id como uuid — coluna é text por design (regressão checkbox separação)", async () => {
    // Convenção: quando origem_tipo ∈ {reserva_pedido, liberacao_reserva},
    // origem_id carrega siso_pedidos.id (Tiny ID, text). Validar como uuid
    // quebrou o checkbox de marcar-item após o cutover WMS_AS_SOURCE.
    let caughtMsg = "";
    try {
      await inserirMovimentacao({
        tripla: triplaOk,
        tipo: "L",
        qty: 1,
        origem_tipo: "liberacao_reserva",
        origem_id: "937897149",
      });
    } catch (e) {
      caughtMsg = e instanceof Error ? e.message : String(e);
    }
    expect(caughtMsg).not.toMatch(/origem_id.*esperava uuid/);
  });

  it("throws quando empresa_vendedora_id é text não-uuid", async () => {
    await expect(
      inserirMovimentacao({
        tripla: triplaOk,
        tipo: "S",
        qty: 1,
        origem_tipo: "nf_venda",
        empresa_vendedora_id: "netair",
      }),
    ).rejects.toThrow(/empresa_vendedora_id.*esperava uuid/);
  });

  it("throws quando tripla.produto_id é número (Tiny ID) em vez de uuid", async () => {
    await expect(
      inserirMovimentacao({
        tripla: {
          produto_id: "9077486999",
          galpao_id: triplaOk.galpao_id,
          localizacao_id: triplaOk.localizacao_id,
        },
        tipo: "S",
        qty: 1,
        origem_tipo: "venda_manual",
      }),
    ).rejects.toThrow(/tripla.produto_id.*esperava uuid.*9077486999/);
  });
});
