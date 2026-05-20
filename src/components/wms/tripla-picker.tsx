"use client";
// Tripla 3D: produto + galpão + localização. Empresa-dona não existe mais
// no modelo de saldo. Empresa entra apenas como metadado contábil
// (origem/destino) em movimentações comerciais — não como dimensão de saldo.
//
// Este picker cobre 2 selects (galpão + localização). Produto é normalmente
// escolhido em outro lugar do form (input com busca, etc.) e passado ao
// caller à parte.
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { LocalizacaoCombo } from "@/components/wms/ui/modals";
import type { TipoLocalizacao } from "@/lib/wms/types";

interface TriplaValue {
  galpao_id?: string;
  localizacao_id?: string;
}

interface TriplaPickerProps {
  value: TriplaValue;
  onChange: (v: TriplaValue) => void;
  showLocalizacao?: boolean;
  filtroTipoLocalizacao?: TipoLocalizacao;
}

interface GalpaoRow {
  id: string;
  nome: string;
}

export function TriplaPicker({
  value,
  onChange,
  showLocalizacao = true,
  filtroTipoLocalizacao,
}: TriplaPickerProps) {
  const { data: galpoesResp } = useQuery({
    queryKey: ["galpoes-tripla"],
    queryFn: async () => {
      const raw = await wmsApi<Array<{ id: string; nome: string }>>(
        "/api/wms/admin/galpoes",
      );
      return raw.map<GalpaoRow>((g) => ({ id: g.id, nome: g.nome }));
    },
  });

  const galpoes = galpoesResp ?? [];
  const galpaoId = value.galpao_id ?? null;

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
        value={value.galpao_id ?? ""}
        onChange={(e) =>
          onChange({
            galpao_id: e.target.value || undefined,
            localizacao_id: undefined,
          })
        }
      >
        <option value="">— galpão —</option>
        {galpoes.map((g) => (
          <option key={g.id} value={g.id}>
            {g.nome}
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
              localizacao_id: id || undefined,
            })
          }
        />
      )}
    </div>
  );
}
