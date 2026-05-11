"use client";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";

interface QuadruplaValue {
  empresa_id?: string;
  galpao_id?: string;
  localizacao_id?: string;
}

interface Props {
  value: QuadruplaValue;
  onChange: (v: QuadruplaValue) => void;
  showLocalizacao?: boolean;
  filtroTipoLocalizacao?: string;
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

interface LocRow {
  id: string;
  codigo: string;
  tipo: string;
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
  const galpaoId = empresaSel?.galpao_id;

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", galpaoId],
    queryFn: () =>
      wmsApi<{ rows: LocRow[] }>(`/api/wms/localizacoes?galpao_id=${galpaoId}`),
    enabled: !!galpaoId && showLocalizacao,
  });

  const locsFiltradas = filtroTipoLocalizacao
    ? (locs?.rows ?? []).filter((l) => l.tipo === filtroTipoLocalizacao)
    : (locs?.rows ?? []);

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
        <select
          className="wms-select"
          value={value.localizacao_id ?? ""}
          disabled={!galpaoId}
          onChange={(e) =>
            onChange({
              ...value,
              galpao_id: galpaoId,
              localizacao_id: e.target.value || undefined,
            })
          }
        >
          <option value="">— localização —</option>
          {locsFiltradas.map((l) => (
            <option key={l.id} value={l.id}>
              {l.codigo} ({l.tipo})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
