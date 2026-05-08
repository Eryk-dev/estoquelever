import { createServiceClient } from "@/lib/supabase-server";

export type StatusCobertura =
  | "critico"
  | "atencao"
  | "ok"
  | "sem_giro"
  | "lead_time_risco";

export interface LinhaCobertura {
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  disponivel_total: number;
  giro_diario: number;
  dias_cobertura: number | null;
  lead_time_medio: number | null;
  status_cobertura: StatusCobertura;
  produto?: { sku: string; descricao: string };
  galpao?: { nome: string };
  empresa?: { nome: string };
}

export async function listarCobertura(
  filtros: { status?: string; galpao_id?: string } = {},
): Promise<LinhaCobertura[]> {
  const sb = createServiceClient();
  let q = sb
    .from("siso_cobertura_estoque")
    .select(
      `
        *,
        produto:siso_produtos(sku, descricao),
        galpao:siso_galpoes(nome),
        empresa:siso_empresas(nome)
      `,
    )
    .order("dias_cobertura", { ascending: true, nullsFirst: false })
    .limit(500);
  if (filtros.status) q = q.eq("status_cobertura", filtros.status);
  if (filtros.galpao_id) q = q.eq("galpao_id", filtros.galpao_id);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as LinhaCobertura[];
}

export async function refreshCobertura(): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb.rpc("wms_refresh_cobertura");
  if (error) throw error;
}
