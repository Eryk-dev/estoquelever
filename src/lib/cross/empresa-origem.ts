import { createServiceClient } from "@/lib/supabase-server";
import type { SessionUser } from "@/lib/session";

/**
 * Resolve a empresa de origem (conta Tiny) que deve ser usada para chamadas
 * Tiny no contexto Cross.
 *
 * Estratégia:
 *  1. Se a sessão já tem galpaoId resolvido (preferido), pega a primeira
 *     empresa ativa daquele galpão.
 *  2. Caso contrário, retorna null (chamadores devem responder 500 com
 *     mensagem clara — não fazemos fallback silencioso para "primeira ativa"
 *     porque isso esconde má configuração).
 */
export async function getEmpresaOrigemId(
  session: SessionUser,
): Promise<string | null> {
  if (!session.galpaoId) return null;

  const supabase = createServiceClient();
  const { data: empresa } = await supabase
    .from("siso_empresas")
    .select("id")
    .eq("galpao_id", session.galpaoId)
    .eq("ativo", true)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  return empresa?.id ?? null;
}
