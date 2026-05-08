"use client";
import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";
import { wmsApi } from "@/lib/wms/api-client";
import { ScanContagem } from "@/components/wms/scan-contagem";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

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

  if (isLoading) return <LoadingSpinner />;

  return (
    <div className="mx-auto max-w-md space-y-3">
      {blind && (
        <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          <EyeOff className="h-4 w-4 shrink-0" />
          <span>Modo blind: você não vê o saldo esperado.</span>
        </div>
      )}

      {!locId ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-muted">
            Escolha uma localização pendente:
          </p>
          {localizacoes.length === 0 ? (
            <p className="text-sm text-ink-faint">
              Nenhuma localização disponível pra contagem.
            </p>
          ) : (
            localizacoes.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => pegarLoc.mutate(l.localizacao_id)}
                disabled={pegarLoc.isPending}
                className="block w-full rounded-xl border border-line bg-paper p-3 text-left transition-colors hover:bg-surface disabled:opacity-50"
              >
                <div className="font-mono text-ink">{l.localizacao?.codigo}</div>
                <div className="text-xs text-ink-faint">
                  {l.localizacao?.tipo}
                </div>
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 font-mono text-sm text-ink">
            <Eye className="h-4 w-4 text-ink-faint" />
            localização: {locId.slice(0, 8)}
          </div>
          <ScanContagem onScan={handleScan} />
          <div className="space-y-1">
            {contagensLocal.map((c) => (
              <div
                key={c.produto_id}
                className="flex items-center justify-between rounded-xl border border-line bg-paper p-2.5"
              >
                <span className="font-mono text-ink">{c.sku}</span>
                <span className="text-lg tabular-nums text-ink">{c.qty}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => finalizar.mutate()}
            disabled={contagensLocal.length === 0 || finalizar.isPending}
            className="btn-primary w-full justify-center py-3"
          >
            {finalizar.isPending ? "Finalizando..." : "Finalizar localização"}
          </button>
        </>
      )}
    </div>
  );
}
