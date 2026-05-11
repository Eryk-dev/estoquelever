"use client";
import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { ScanContagem } from "@/components/wms/scan-contagem";
import { Icon, PageHeader, fmtNum } from "@/components/wms/ui/wms-ui";

interface LocSessao {
  id: string;
  localizacao_id: string;
  status: string;
  localizacao?: { codigo?: string; tipo?: string };
}

interface SessaoDetail {
  sessao?: {
    tipo: string;
    modo_contagem: string;
    empresa_dona_id?: string;
  };
  localizacoes?: LocSessao[];
}

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function ContarPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const [locId, setLocId] = useState<string>("");
  const [contagensLocal, setContagensLocal] = useState<
    { sku: string; produto_id: string; qty: number }[]
  >([]);

  const { data, isLoading } = useQuery({
    queryKey: ["wms-inv", id],
    queryFn: () => wmsApi<SessaoDetail>(`/api/wms/inventario/${id}`),
  });
  const sessao = data?.sessao;
  const localizacoes = (data?.localizacoes ?? []).filter(
    (l) => l.status === "pendente" || l.status === "recontagem",
  );
  const blind =
    sessao?.modo_contagem === "blind" ||
    sessao?.modo_contagem === "duplo_blind";
  const locAtual = (data?.localizacoes ?? []).find(
    (l) => l.localizacao_id === locId,
  );

  const pegarLoc = useMutation({
    mutationFn: (newLocId: string) =>
      wmsApi<{ ok: true }>(
        `/api/wms/inventario/${id}/localizacoes/${newLocId}/bloquear`,
        { method: "POST" },
      ),
    onSuccess: (_, newLocId) => {
      setLocId(newLocId);
      setContagensLocal([]);
      toast.success("Localização bloqueada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleScan(value: string) {
    if (!sessao?.empresa_dona_id) {
      toast.error(
        "Sessão sem empresa_dona_id — configure antes de contar (multi-empresa)",
      );
      return;
    }
    try {
      const r = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(value)}&limit=1`,
      );
      const p = r.rows?.[0];
      if (!p) {
        toast.error("SKU não encontrado");
        return;
      }
      await wmsApi(`/api/wms/inventario/${id}/contagens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localizacao_id: locId,
          produto_id: p.id,
          empresa_dona_id: sessao.empresa_dona_id,
          qty_contada: 1,
          modo: "incremental",
        }),
      });
      setContagensLocal((prev) => {
        const existing = prev.find((c) => c.produto_id === p.id);
        if (existing) {
          return prev.map((c) =>
            c.produto_id === p.id ? { ...c, qty: c.qty + 1 } : c,
          );
        }
        return [...prev, { sku: p.sku, produto_id: p.id, qty: 1 }];
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const finalizar = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(
        `/api/wms/inventario/${id}/localizacoes/${locId}/bloquear`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      setLocId("");
      setContagensLocal([]);
      toast.success("Localização concluída");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading)
    return <div className="wms-loading-pane">Carregando sessão…</div>;

  return (
    <>
      <PageHeader
        title="Contagem"
        subtitle={`Sessão ${id.slice(0, 8)} · modo ${sessao?.modo_contagem ?? "—"}`}
      />

      {blind && (
        <div className="wms-hint-card" style={{ marginBottom: 14 }}>
          <Icon name="alert" />
          <span>
            <strong>Modo blind.</strong> Você não vê o saldo esperado durante a
            contagem.
          </span>
        </div>
      )}

      {!locId ? (
        <>
          <h3 className="wms-sec-h">Localizações pendentes</h3>
          {localizacoes.length === 0 ? (
            <div className="wms-empty-block">
              <h3>Nenhuma localização disponível</h3>
              <p>
                Todas as localizações da sessão já foram contadas ou estão
                bloqueadas por outro operador.
              </p>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 8,
              }}
            >
              {localizacoes.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className="wms-card"
                  style={{ textAlign: "left", cursor: "pointer" }}
                  disabled={pegarLoc.isPending}
                  onClick={() => pegarLoc.mutate(l.localizacao_id)}
                >
                  <div className="wms-card-body">
                    <div className="wms-mono" style={{ fontSize: 14, fontWeight: 600 }}>
                      {l.localizacao?.codigo}
                    </div>
                    <div className="wms-td-mute" style={{ fontSize: 12 }}>
                      {l.localizacao?.tipo}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              background: "var(--wms-c-faint)",
              border: "1px solid var(--wms-c-border)",
              borderRadius: "var(--wms-r-3)",
              marginBottom: 12,
            }}
          >
            <div>
              <div className="wms-td-mute" style={{ fontSize: 11 }}>
                Contando
              </div>
              <div className="wms-mono" style={{ fontSize: 16, fontWeight: 600 }}>
                {locAtual?.localizacao?.codigo ?? locId.slice(0, 8)}
              </div>
            </div>
            <button
              type="button"
              className="wms-btn wms-btn-ghost wms-btn-sm"
              onClick={() => {
                setLocId("");
                setContagensLocal([]);
              }}
            >
              Trocar localização
            </button>
          </div>

          <ScanContagem onScan={handleScan} />

          <h3 className="wms-sec-h" style={{ marginTop: 16 }}>
            Contagens nesta localização
          </h3>
          {contagensLocal.length === 0 ? (
            <div className="wms-exp-empty">Nenhum bipe ainda.</div>
          ) : (
            <div className="wms-tbl">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th className="wms-tar">Quantidade</th>
                  </tr>
                </thead>
                <tbody>
                  {contagensLocal.map((c) => (
                    <tr key={c.produto_id}>
                      <td className="wms-mono">{c.sku}</td>
                      <td className="wms-tar wms-mono">{fmtNum(c.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: 16,
              paddingTop: 16,
              borderTop: "1px solid var(--wms-c-border)",
            }}
          >
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={contagensLocal.length === 0 || finalizar.isPending}
              onClick={() => finalizar.mutate()}
            >
              <Icon name="check" size={11} />
              {finalizar.isPending ? "Finalizando…" : "Finalizar localização"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
