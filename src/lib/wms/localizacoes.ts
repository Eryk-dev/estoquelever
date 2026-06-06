import { createServiceClient } from "@/lib/supabase-server";
import type { Localizacao, TipoLocalizacao } from "./types";
import { cleanupReservasExpiradasDaLoc } from "@/lib/wms/reservas";

export const LOTE_MAX_TOTAL = 5000;
const PREFIXO_REGEX = /^[A-Z0-9]{1,8}$/;

export type LoteCodigosInput = {
  prefixo: string;
  h_inicio: number;
  h_fim: number;
  v_inicio: number;
  v_fim: number;
  separador?: string;
};

export type LoteCodigosResult = {
  codigos: string[];
  total: number;
};

function isInteiroPositivo(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

export function gerarCodigosLote(input: LoteCodigosInput): LoteCodigosResult {
  const { prefixo, h_inicio, h_fim, v_inicio, v_fim } = input;
  const separador = input.separador ?? "-";

  if (!prefixo || prefixo.trim() === "") {
    throw new Error("prefixo é obrigatório");
  }
  if (!PREFIXO_REGEX.test(prefixo)) {
    throw new Error(
      "prefixo deve ter entre 1 e 8 caracteres alfanuméricos maiúsculos",
    );
  }
  if (
    !isInteiroPositivo(h_inicio) ||
    !isInteiroPositivo(h_fim) ||
    !isInteiroPositivo(v_inicio) ||
    !isInteiroPositivo(v_fim)
  ) {
    throw new Error("valores devem ser inteiros positivos");
  }
  if (h_inicio > h_fim || v_inicio > v_fim) {
    throw new Error("início não pode ser maior que fim");
  }

  const total = (h_fim - h_inicio + 1) * (v_fim - v_inicio + 1);
  if (total > LOTE_MAX_TOTAL) {
    throw new Error(`lote excede ${LOTE_MAX_TOTAL} localizações (atual: ${total})`);
  }

  const hPad = Math.max(2, String(h_fim).length);

  const codigos: string[] = [];
  for (let h = h_inicio; h <= h_fim; h++) {
    const hStr = String(h).padStart(hPad, "0");
    for (let v = v_inicio; v <= v_fim; v++) {
      codigos.push(`${prefixo}${separador}${hStr}${separador}${v}`);
    }
  }

  return { codigos, total };
}

export async function listarLocalizacoes(galpaoId?: string): Promise<Localizacao[]> {
  const sb = createServiceClient();
  const PAGE = 1000;
  const all: Localizacao[] = [];
  let offset = 0;
  while (true) {
    let q = sb
      .from("siso_localizacoes")
      .select("*")
      .eq("ativo", true)
      .order("codigo")
      .range(offset, offset + PAGE - 1);
    if (galpaoId) q = q.eq("galpao_id", galpaoId);
    const { data, error } = await q;
    if (error) throw error;
    const batch = (data ?? []) as Localizacao[];
    all.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

export async function criarLocalizacao(input: {
  galpao_id: string;
  codigo: string;
  descricao?: string;
  tipo?: TipoLocalizacao;
}): Promise<Localizacao> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_localizacoes")
    .insert({ ...input, tipo: input.tipo ?? "picking" })
    .select()
    .single();
  if (error) throw error;
  return data as Localizacao;
}

export async function atualizarLocalizacao(
  id: string,
  patch: Partial<Localizacao>,
): Promise<Localizacao> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_localizacoes")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as Localizacao;
}

export async function desativarLocalizacao(id: string): Promise<void> {
  const sb = createServiceClient();

  // [P115] auto-limpa reservas VENCIDAS dessa loc ANTES de checar (libera estoque órfão).
  await cleanupReservasExpiradasDaLoc(id);

  // saldo livre ainda presente (reserva válida ou saldo real) → bloqueia.
  const { data: estoque } = await sb
    .from("siso_estoque")
    .select("saldo")
    .eq("localizacao_id", id)
    .gt("saldo", 0)
    .limit(1);
  if (estoque && estoque.length > 0) {
    throw new Error("não é possível desativar: localização tem saldo — mova via substituir-e-excluir");
  }

  // [P063] referências em-voo: destino/origem de transferência em_transito.
  const { data: transfItens } = await sb
    .from("siso_transferencia_galpao_itens")
    .select("id, transferencia_id, siso_transferencias_galpao!inner(status)")
    .or(`localizacao_destino_id.eq.${id},localizacao_origem_id.eq.${id}`)
    .eq("siso_transferencias_galpao.status", "em_transito")
    .limit(1);
  if (transfItens && transfItens.length > 0) {
    throw new Error("não é possível desativar: localização é perna de transferência em trânsito — conclua/cancele antes ou use substituir-e-excluir");
  }

  // [P063] pendência de guarda aberta apontando a loc.
  const { data: pendGuarda } = await sb
    .from("siso_wms_pendencias_guarda")
    .select("id")
    .or(`localizacao_destino_id.eq.${id},localizacao_origem_id.eq.${id}`)
    .in("status", ["pendente", "em_guarda"])
    .limit(1);
  if (pendGuarda && pendGuarda.length > 0) {
    throw new Error("não é possível desativar: localização tem pendência de guarda aberta — conclua antes ou use substituir-e-excluir");
  }

  await sb.from("siso_localizacoes").update({ ativo: false }).eq("id", id);
}
