import type { SupabaseClient } from "@supabase/supabase-js";
import type { StagingFixtures } from "./types";

const STAGING_PROJECT_REF = "ehbxpbeijofxtsbezwxd";

export function validarStaging() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url.includes(STAGING_PROJECT_REF)) {
    throw new Error(`ABORT: NEXT_PUBLIC_SUPABASE_URL não é staging (${STAGING_PROJECT_REF}). Atual: ${url}`);
  }
}

export async function truncateOperacional(sb: SupabaseClient): Promise<void> {
  const { error } = await sb.rpc("wms_truncate_operacional");
  if (error) throw new Error(`wms_truncate_operacional: ${error.message}`);
}

async function upsertGalpao(sb: SupabaseClient, nome: "CWB" | "SP") {
  const { data: existente } = await sb.from("siso_galpoes").select("id").eq("nome", nome).maybeSingle();
  if (existente) return existente.id;
  const { data, error } = await sb
    .from("siso_galpoes")
    .insert({ nome, ativo: true })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertLocalizacao(sb: SupabaseClient, galpao_id: string, codigo: string, tipo: string) {
  const { data: existente } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpao_id)
    .eq("codigo", codigo)
    .maybeSingle();
  if (existente) return existente.id;
  const { data, error } = await sb
    .from("siso_localizacoes")
    .insert({ galpao_id, codigo, tipo, ativo: true })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertUsuario(sb: SupabaseClient, nome: string, pin: string, cargo: string) {
  const { data: existente } = await sb.from("siso_usuarios").select("id").eq("nome", nome).maybeSingle();
  if (existente) {
    await sb.from("siso_usuarios").update({ pin, cargo, ativo: true }).eq("id", existente.id);
    return existente.id;
  }
  const { data, error } = await sb
    .from("siso_usuarios")
    .insert({ nome, pin, cargo, ativo: true })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertFornecedor(sb: SupabaseClient, nome: string, prefixo_sku: string) {
  const { data: existente } = await sb.from("siso_fornecedores").select("id").eq("nome", nome).maybeSingle();
  if (existente) return existente.id;
  const { data, error } = await sb
    .from("siso_fornecedores")
    .insert({ nome, prefixo_sku, ativo: true })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function seedInicial(sb: SupabaseClient): Promise<StagingFixtures> {
  validarStaging();

  // Galpões + loc RECEBIMENTO
  const cwbId = await upsertGalpao(sb, "CWB");
  const spId = await upsertGalpao(sb, "SP");
  const cwbRec = await upsertLocalizacao(sb, cwbId, "RECEBIMENTO", "recebimento");
  const spRec = await upsertLocalizacao(sb, spId, "RECEBIMENTO", "recebimento");

  // Locs picking + overstock CWB
  for (let i = 1; i <= 10; i++) {
    await upsertLocalizacao(sb, cwbId, `A-01-${String(i).padStart(2, "0")}`, "picking");
  }
  for (let i = 1; i <= 5; i++) {
    await upsertLocalizacao(sb, cwbId, `B-02-${String(i).padStart(2, "0")}`, "overstock");
  }
  await upsertLocalizacao(sb, cwbId, "QUARENTENA", "quarentena");

  // Locs picking SP
  for (let i = 1; i <= 10; i++) {
    await upsertLocalizacao(sb, spId, `C-01-${String(i).padStart(2, "0")}`, "picking");
  }

  // Empresas (verifica que existem)
  const { data: netair } = await sb.from("siso_empresas").select("id, cnpj, nome").eq("cnpj", "34857388000163").single();
  const { data: netparts } = await sb.from("siso_empresas").select("id, cnpj, nome").eq("cnpj", "34857388000244").single();
  if (!netair || !netparts) throw new Error("Empresas NetAir/NetParts não encontradas em staging — seed manual necessário antes da suite");

  // Galpões preferenciais (geo=0)
  await sb.from("siso_empresa_galpoes_preferenciais").upsert(
    [
      { empresa_id: netair.id, galpao_id: cwbId, geo_priority: 0 },
      { empresa_id: netparts.id, galpao_id: spId, geo_priority: 0 },
    ],
    { onConflict: "empresa_id,galpao_id", ignoreDuplicates: false },
  );

  // Usuário test-runner
  await upsertUsuario(sb, "test-runner", "9999", "admin");

  // Fornecedor genérico pra prefixo TEST
  await upsertFornecedor(sb, "TestSupplier-Default", "TEST");

  return {
    empresas: {
      netair: { id: netair.id, nome: netair.nome, cnpj: netair.cnpj, galpao_id: cwbId },
      netparts: { id: netparts.id, nome: netparts.nome, cnpj: netparts.cnpj, galpao_id: spId },
    },
    galpoes: {
      cwb: { id: cwbId, nome: "CWB", recebimento_loc_id: cwbRec },
      sp: { id: spId, nome: "SP", recebimento_loc_id: spRec },
    },
  };
}
