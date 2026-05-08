"use client";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";

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
    queryFn: async () =>
      (await sisoFetch("/api/admin/galpoes")).json() as Promise<{ galpoes?: GalpaoRow[] }>,
  });

  const galpoes = galpoesResp?.galpoes ?? [];
  const empresasAtivas: EmpresaRow[] = galpoes.flatMap(
    (g) => (g.empresas ?? []).map((e) => ({ ...e, galpao_id: g.id })),
  );
  const empresaSel = empresasAtivas.find((e) => e.id === value.empresa_id);
  const galpaoId = empresaSel?.galpao_id;

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", galpaoId],
    queryFn: async () =>
      galpaoId
        ? ((await sisoFetch(`/api/wms/localizacoes?galpao_id=${galpaoId}`)).json() as Promise<{
            rows: LocRow[];
          }>)
        : { rows: [] as LocRow[] },
    enabled: !!galpaoId && showLocalizacao,
  });

  const locsFiltradas = filtroTipoLocalizacao
    ? (locs?.rows ?? []).filter((l) => l.tipo === filtroTipoLocalizacao)
    : (locs?.rows ?? []);

  return (
    <div className="flex flex-col sm:flex-row gap-2">
      <select
        value={value.empresa_id ?? ""}
        onChange={(e) =>
          onChange({
            empresa_id: e.target.value || undefined,
            galpao_id: undefined,
            localizacao_id: undefined,
          })
        }
        className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
      >
        <option value="">— empresa —</option>
        {empresasAtivas.map((e) => (
          <option key={e.id} value={e.id}>
            {e.nome}
          </option>
        ))}
      </select>

      {showLocalizacao && galpaoId && (
        <select
          value={value.localizacao_id ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              galpao_id: galpaoId,
              localizacao_id: e.target.value || undefined,
            })
          }
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
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
