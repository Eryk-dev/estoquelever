"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

type StatusFilter = "erro" | "enviado" | "sucesso" | "cancelado";

interface ImpressaoLog {
  id: string;
  printnode_job_id: number | null;
  printer_id: number | null;
  printer_nome: string | null;
  contexto: string;
  contexto_ref_id: string | null;
  total_etiquetas: number | null;
  status: StatusFilter;
  erro_msg: string | null;
  enviado_em: string;
  atualizado_em: string;
  usuario?: { nome?: string } | null;
  galpao?: { nome?: string } | null;
}

interface ListaResponse {
  itens: ImpressaoLog[];
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EtiquetasPage() {
  const { can } = usePermissoes();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("erro");

  const podeVer = can("operacoes.imprimir");

  const { data, isLoading } = useQuery<ListaResponse>({
    queryKey: ["impressoes", statusFilter],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/impressoes?status=${statusFilter}&limit=100`);
      if (!r.ok) throw new Error(`erro ${r.status}`);
      return (await r.json()) as ListaResponse;
    },
    enabled: podeVer,
    refetchInterval: statusFilter === "erro" ? 30_000 : false,
  });

  const retry = useMutation({
    mutationFn: async (id: string) => {
      const r = await sisoFetch(`/api/wms/impressoes/${id}/retry`, {
        method: "POST",
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        job_id?: number;
        error?: string;
      };
      if (!r.ok) throw new Error(body.error ?? `erro ${r.status}`);
      return body;
    },
    onSuccess: () => {
      toast.success("Reenviado pra impressora");
      qc.invalidateQueries({ queryKey: ["impressoes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!podeVer) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "var(--wms-c-mute)" }}>
          Sem permissão pra ver fila de impressões.
        </p>
      </div>
    );
  }

  const itens = data?.itens ?? [];

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 16 }}>
        Etiquetas — fila de impressões
      </h1>

      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["erro", "enviado", "sucesso", "cancelado"] as StatusFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={statusFilter === s ? "wms-btn wms-btn-primary" : "wms-btn"}
            style={{ fontSize: 13 }}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p style={{ color: "var(--wms-c-mute)" }}>Carregando…</p>
      ) : itens.length === 0 ? (
        <p style={{ color: "var(--wms-c-mute)" }}>Sem registros pra este status.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {itens.map((it) => (
            <div
              key={it.id}
              style={{
                border: "1px solid var(--wms-c-border)",
                borderRadius: 6,
                padding: 12,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <div style={{ flex: 1, fontSize: 13 }}>
                <div style={{ fontWeight: 500 }}>
                  <span style={{ textTransform: "uppercase", fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "var(--wms-c-soft)", marginRight: 6 }}>
                    {it.contexto}
                  </span>
                  {it.printer_nome ?? `printer ${it.printer_id ?? "—"}`}
                  {it.total_etiquetas ? (
                    <span style={{ color: "var(--wms-c-mute)", marginLeft: 8 }}>
                      · {it.total_etiquetas} etiquetas
                    </span>
                  ) : null}
                </div>
                <div style={{ color: "var(--wms-c-mute)", fontSize: 11, marginTop: 4 }}>
                  {fmtDate(it.enviado_em)}
                  {it.usuario?.nome ? ` · ${it.usuario.nome}` : ""}
                  {it.galpao?.nome ? ` · ${it.galpao.nome}` : ""}
                  {it.contexto_ref_id ? ` · ref ${it.contexto_ref_id.slice(0, 8)}` : ""}
                </div>
                {it.erro_msg ? (
                  <div style={{ color: "var(--wms-c-danger, #b91c1c)", fontSize: 12, marginTop: 6 }}>
                    {it.erro_msg}
                  </div>
                ) : null}
              </div>
              {(it.status === "erro" || it.status === "enviado") && (
                <button
                  type="button"
                  onClick={() => retry.mutate(it.id)}
                  disabled={retry.isPending}
                  className="wms-btn wms-btn-primary"
                  style={{ fontSize: 12 }}
                >
                  {retry.isPending ? "..." : "Retry"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
