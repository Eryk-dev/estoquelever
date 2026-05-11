"use client";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { LocalizacaoCombo } from "@/components/wms/ui/modals";
import type { TipoLocalizacao } from "@/lib/wms/types";

interface QuadruplaValue {
  empresa_id?: string;
  galpao_id?: string;
  localizacao_id?: string;
}

interface Props {
  value: QuadruplaValue;
  onChange: (v: QuadruplaValue) => void;
  showLocalizacao?: boolean;
  filtroTipoLocalizacao?: TipoLocalizacao;
}

interface EmpresaRow {
  id: string;
  nome: string;
  galpao_id: string;
}

interface GalpaoRow {
  id: string;
  nome: string;
  empresas?: EmpresaRow[];
}

export function QuadruplaPicker({
  value,
  onChange,
  showLocalizacao = true,
  filtroTipoLocalizacao,
}: Props) {
  const { data: galpoesResp } = useQuery({
    queryKey: ["galpoes"],
    queryFn: async () => {
      const raw = await wmsApi<
        Array<{
          id: string;
          nome: string;
          siso_empresas?: Array<{ id: string; nome: string; ativo?: boolean }>;
        }>
      >("/api/admin/galpoes");
      return raw.map<GalpaoRow>((g) => ({
        id: g.id,
        nome: g.nome,
        empresas: (g.siso_empresas ?? [])
          .filter((e) => e.ativo !== false)
          .map((e) => ({ id: e.id, nome: e.nome, galpao_id: g.id })),
      }));
    },
  });

  const galpoes = galpoesResp ?? [];
  const empresasAtivas: EmpresaRow[] = galpoes.flatMap((g) =>
    (g.empresas ?? []).map((e) => ({ ...e, galpao_id: g.id })),
  );
  const empresaSel = empresasAtivas.find((e) => e.id === value.empresa_id);
  const galpaoId = empresaSel?.galpao_id ?? null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: showLocalizacao ? "1fr 1fr" : "1fr",
        gap: 8,
      }}
    >
      <select
        className="wms-select"
        value={value.empresa_id ?? ""}
        onChange={(e) =>
          onChange({
            empresa_id: e.target.value || undefined,
            galpao_id: undefined,
            localizacao_id: undefined,
          })
        }
      >
        <option value="">— empresa —</option>
        {empresasAtivas.map((e) => (
          <option key={e.id} value={e.id}>
            {e.nome}
          </option>
        ))}
      </select>

      {showLocalizacao && (
        <LocalizacaoCombo
          galpaoId={galpaoId}
          value={value.localizacao_id ?? ""}
          allowedTipos={
            filtroTipoLocalizacao ? [filtroTipoLocalizacao] : undefined
          }
          onChange={(id) =>
            onChange({
              ...value,
              galpao_id: galpaoId ?? undefined,
              localizacao_id: id || undefined,
            })
          }
        />
      )}
    </div>
  );
}
