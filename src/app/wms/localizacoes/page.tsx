"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  LocTipoBadge,
  Field,
} from "@/components/wms/ui/wms-ui";
import type { Localizacao, TipoLocalizacao } from "@/lib/wms/types";

const TIPOS: TipoLocalizacao[] = [
  "picking",
  "overstock",
  "recebimento",
  "expedicao",
  "quarentena",
];

interface GalpaoRow {
  id: string;
  nome: string;
}

export default function LocalizacoesPage() {
  const queryClient = useQueryClient();
  const [galpaoId, setGalpaoId] = useState<string>("");
  const [showForm, setShowForm] = useState(false);
  const [novo, setNovo] = useState({
    codigo: "",
    descricao: "",
    tipo: "picking" as TipoLocalizacao,
  });

  const { data: galpoes } = useQuery({
    queryKey: ["galpoes"],
    queryFn: () => wmsApi<{ galpoes?: GalpaoRow[] }>("/api/admin/galpoes"),
  });

  const locsQuery = useQuery({
    queryKey: ["wms-locs", galpaoId],
    queryFn: () =>
      wmsApi<{ rows: Localizacao[] }>(
        `/api/wms/localizacoes?galpao_id=${galpaoId}`,
      ),
    enabled: !!galpaoId,
  });

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<Localizacao>("/api/wms/localizacoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ galpao_id: galpaoId, ...novo }),
      }),
    onSuccess: () => {
      toast.success("Localização criada");
      setNovo({ codigo: "", descricao: "", tipo: "picking" });
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = locsQuery.data?.rows ?? [];
  const galpoesList = galpoes?.galpoes ?? [];

  return (
    <>
      <PageHeader
        title="Localizações"
        subtitle="Endereçamento físico por galpão"
      >
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          disabled={!galpaoId}
          onClick={() => setShowForm((s) => !s)}
        >
          <Icon name="plus" size={12} />
          Nova localização
        </button>
      </PageHeader>

      {galpoesList.length > 0 && (
        <div className="wms-seg" style={{ marginBottom: 16 }}>
          {galpoesList.map((g) => (
            <button
              key={g.id}
              className={`wms-seg-btn ${galpaoId === g.id ? "is-active" : ""}`}
              onClick={() => setGalpaoId(g.id)}
            >
              {g.nome}
            </button>
          ))}
        </div>
      )}

      {!galpaoId && (
        <div className="wms-empty-block">
          <h3>Escolha um galpão</h3>
          <p>Selecione um galpão acima para ver e gerenciar suas localizações.</p>
        </div>
      )}

      {galpaoId && showForm && (
        <div
          style={{
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 16,
            marginBottom: 16,
          }}
        >
          <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
            Nova localização
          </h3>
          <div className="wms-row-3">
            <Field label="Código" required>
              <input
                className="wms-input wms-mono"
                value={novo.codigo}
                onChange={(e) => setNovo({ ...novo, codigo: e.target.value })}
                placeholder="A-12-03"
              />
            </Field>
            <Field label="Descrição" hint="opcional">
              <input
                className="wms-input"
                value={novo.descricao}
                onChange={(e) =>
                  setNovo({ ...novo, descricao: e.target.value })
                }
                placeholder="Rua A, Coluna 12, Nível 03"
              />
            </Field>
            <Field label="Tipo" required>
              <select
                className="wms-select"
                value={novo.tipo}
                onChange={(e) =>
                  setNovo({ ...novo, tipo: e.target.value as TipoLocalizacao })
                }
              >
                {TIPOS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              paddingTop: 12,
              borderTop: "1px solid var(--wms-c-border)",
            }}
          >
            <button
              type="button"
              className="wms-btn wms-btn-ghost"
              onClick={() => setShowForm(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={!novo.codigo || criar.isPending}
              onClick={() => criar.mutate()}
            >
              <Icon name="check" size={11} />
              {criar.isPending ? "Criando…" : "Criar"}
            </button>
          </div>
        </div>
      )}

      {galpaoId && (
        <>
          {locsQuery.isLoading && (
            <div className="wms-loading-pane">Carregando localizações…</div>
          )}
          {locsQuery.isError && (
            <div className="wms-empty-block">
              <h3>Erro</h3>
              <p>{(locsQuery.error as Error).message}</p>
            </div>
          )}
          {!locsQuery.isLoading && rows.length === 0 && (
            <div className="wms-empty-block">
              <h3>Nenhuma localização nesse galpão</h3>
              <p>Crie a primeira para começar a endereçar estoque.</p>
            </div>
          )}
          {rows.length > 0 && (
            <div className="wms-tbl">
              <table>
                <thead>
                  <tr>
                    <th>Código</th>
                    <th>Descrição</th>
                    <th>Tipo</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.id}>
                      <td className="wms-mono">{l.codigo}</td>
                      <td className="wms-td-mute">{l.descricao ?? "—"}</td>
                      <td>
                        <LocTipoBadge tipo={l.tipo} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
