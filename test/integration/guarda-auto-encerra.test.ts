import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { confirmarGuarda } from "../../src/lib/wms/guarda";

// FASE 6 — F2-guarda: auto-encerrar quando o saldo físico sumiu.
// Se um pick consome TODO o saldo da loc de recebimento antes do put-away,
// confirmarGuarda não tem o que mover: deve auto-encerrar a pendência com
// status='encerrada_sem_saldo' (terminal), SEM emitir par S+E e SEM tocar saldo.
//
// CORREÇÃO DO PLANO: o trigger é saldo=0 (físico sumiu), NÃO disponivel=0.

const sb = createServiceClient();
let galpaoId: string, produtoId: string, locId: string, locDestId: string, movId: string, op1: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("tipo", "recebimento")
    .eq("ativo", true)
    .limit(1)
    .single();
  locId = l!.id;
  // loc destino qualquer (não-recebimento) pra confirmar.
  const { data: ld } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("codigo", "A-01-01")
    .single();
  locDestId = ld!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({
      sku: `TEST-GD-AE-${Math.random().toString(36).slice(2, 8)}`,
      descricao: "auto-encerra test",
      ativo: true,
    })
    .select("id")
    .single();
  produtoId = p!.id;
  const { data: mov, error: movErr } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: "E",
    p_quantidade: 10,
    p_origem_tipo: "inventario_inicial",
    p_origem_id: null,
    p_custo_unitario: 1,
    p_motivo: "auto-encerra seed",
  });
  if (movErr) throw movErr;
  movId = mov as unknown as string;
  const { data: us } = await sb.from("siso_usuarios").select("id").limit(1);
  op1 = us![0].id;
});

describe("confirmarGuarda auto-encerrar (saldo=0)", () => {
  it("pick consumiu todo o saldo → confirmar auto-encerra (encerrada_sem_saldo), saldo intacto, sem par S+E", async () => {
    const { data: pend, error } = await sb
      .from("siso_wms_pendencias_guarda")
      .insert({
        produto_id: produtoId,
        galpao_id: galpaoId,
        localizacao_origem_id: locId,
        mov_entrada_id: movId,
        origem_tipo: "nf_compra",
        qty_inicial: 10,
        qty_guardada: 0,
        status: "pendente",
      })
      .select("id")
      .single();
    if (error) throw error;
    const pid = pend!.id;

    // Simula o pick que consumiu TODO o saldo da loc de recebimento.
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_tipo: "S",
      p_quantidade: 10,
      p_origem_tipo: "venda_manual",
      p_origem_id: null,
      p_motivo: "pick consumiu antes do put-away",
    });

    const { data: estAntes } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(estAntes!.saldo)).toBe(0);

    // confirmar não tem o que mover → auto-encerra.
    const r = await confirmarGuarda({
      pendencia_id: pid,
      qty: 10,
      localizacao_destino_id: locDestId,
      usuario_id: op1,
    });

    // status terminal encerrada_sem_saldo; qty_pendente preservado (>0).
    const { data: pendDepois } = await sb
      .from("siso_wms_pendencias_guarda")
      .select("status, qty_pendente, qty_guardada, guardada_em")
      .eq("id", pid)
      .single();
    expect(pendDepois!.status).toBe("encerrada_sem_saldo");
    expect(Number(pendDepois!.qty_pendente)).toBeGreaterThan(0);
    expect(Number(pendDepois!.qty_guardada)).toBe(0);
    expect(pendDepois!.guardada_em).not.toBeNull();
    expect(r.pendencia.status).toBe("encerrada_sem_saldo");

    // saldo intacto: NENHUM par S+E foi emitido (loc origem e destino).
    const { data: estDepois } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(estDepois!.saldo)).toBe(0);
    const { data: estDest } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locDestId)
      .maybeSingle();
    expect(Number(estDest?.saldo ?? 0)).toBe(0);

    // nenhum mov transferencia_localizacao gerado por esta pendência.
    const { data: movsTransf } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("produto_id", produtoId)
      .eq("origem_tipo", "transferencia_localizacao");
    expect(movsTransf?.length ?? 0).toBe(0);

    // I5 (pendências guarda coerentes): a regra de coerência continua válida
    // mesmo com a pendência terminal 'encerrada_sem_saldo' aberta —
    // qty_pendente == qty_inicial - qty_guardada, E 'encerrada_sem_saldo' NÃO
    // exige qty_pendente=0 (o estoque sumiu legitimamente via pick). Checamos
    // a regra direto na pendência (o motor I5 completo varre a staging inteira
    // e é caro demais pra um teste de integração).
    const i5ok =
      Number(pendDepois!.qty_pendente) ===
        10 /* qty_inicial */ - Number(pendDepois!.qty_guardada) &&
      pendDepois!.status === "encerrada_sem_saldo";
    expect(i5ok).toBe(true);
  });
});
