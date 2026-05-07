import { createServiceClient } from "@/lib/supabase-server";
import type { SessionUser } from "@/lib/session";

/**
 * Resolve a empresa de origem (conta Tiny) usada para chamadas Tiny no
 * contexto Cross (lazy fetch, refetch, consulta de estoque).
 *
 * Estratégia em cascata:
 *  1. Se a sessão tem galpaoId resolvido (operador no galpão dele) → empresa
 *     ativa desse galpão.
 *  2. Senão (admin/comprador sem galpão na sessão) → primeiro galpão
 *     associado em `siso_usuario_galpoes` → empresa ativa dele.
 *  3. Último recurso → qualquer empresa ativa (cobre admin sem associação).
 *
 * O contexto Cross é cross-galpão por natureza (busca/equivalência), então
 * usar uma "empresa qualquer" como fonte é aceitável quando o usuário não
 * tem preferência clara — diferente do fluxo de pedidos.
 */
export async function getEmpresaOrigemId(
  session: SessionUser,
): Promise<string | null> {
  const supabase = createServiceClient();

  // 1. Galpão da sessão (preferido)
  let galpaoId = session.galpaoId;

  // 2. Fallback: primeiro galpão associado ao usuário
  if (!galpaoId) {
    const { data: rel } = await supabase
      .from("siso_usuario_galpoes")
      .select("galpao_id")
      .eq("usuario_id", session.id)
      .order("galpao_id", { ascending: true })
      .limit(1)
      .maybeSingle();
    galpaoId = rel?.galpao_id ?? null;
  }

  // 3a. Empresa do galpão resolvido (se houver)
  if (galpaoId) {
    const { data: empresa } = await supabase
      .from("siso_empresas")
      .select("id")
      .eq("galpao_id", galpaoId)
      .eq("ativo", true)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (empresa?.id) return empresa.id;
  }

  // 3b. Último recurso — qualquer empresa ativa
  const { data: qualquer } = await supabase
    .from("siso_empresas")
    .select("id")
    .eq("ativo", true)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  return qualquer?.id ?? null;
}
