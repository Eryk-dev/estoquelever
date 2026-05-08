"use client";
import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { ScanContagem } from "@/components/wms/scan-contagem";
import { toast } from "sonner";

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

  const { data } = useQuery({
    queryKey: ["wms-inv", id],
    queryFn: async () =>
      (await sisoFetch(`/api/wms/inventario/${id}`)).json() as Promise<SessaoDetail>,
  });
  const sessao = data?.sessao;
  const localizacoes = (data?.localizacoes ?? []).filter(
    (l) => l.status === "pendente" || l.status === "recontagem",
  );
  const blind =
    sessao?.modo_contagem === "blind" ||
    sessao?.modo_contagem === "duplo_blind";

  const pegarLoc = useMutation({
    mutationFn: async (newLocId: string) =>
      sisoFetch(
        `/api/wms/inventario/${id}/localizacoes/${newLocId}/bloquear`,
        { method: "POST" },
      ).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: (_, newLocId) => {
      setLocId(newLocId);
      setContagensLocal([]);
      toast.success("localização bloqueada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e) => toast.error(String(e)),
  });

  async function handleScan(value: string) {
    const r = (await (
      await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(value)}&limit=1`)
    ).json()) as { rows?: ProdutoMin[] };
    const p = r.rows?.[0];
    if (!p) return toast.error("SKU não encontrado");
    if (!sessao?.empresa_dona_id) {
      toast.error(
        "sessão sem empresa_dona_id; configure antes de contar (apoio multi-empresa)",
      );
      return;
    }
    const resp = await sisoFetch(`/api/wms/inventario/${id}/contagens`, {
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
    if (!resp.ok) {
      toast.error("falha ao registrar bipe");
      return;
    }
    setContagensLocal((prev) => {
      const existing = prev.find((c) => c.produto_id === p.id);
      if (existing)
        return prev.map((c) =>
          c.produto_id === p.id ? { ...c, qty: c.qty + 1 } : c,
        );
      return [...prev, { sku: p.sku, produto_id: p.id, qty: 1 }];
    });
  }

  const finalizar = useMutation({
    mutationFn: async () => {
      await sisoFetch(
        `/api/wms/inventario/${id}/localizacoes/${locId}/bloquear`,
        { method: "DELETE" },
      );
    },
    onSuccess: () => {
      setLocId("");
      setContagensLocal([]);
      toast.success("localização concluída");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
  });

  return (
    <div className="space-y-3 max-w-md mx-auto">
      <h1 className="text-lg font-medium">Contar — {sessao?.tipo}</h1>
      {blind && (
        <div className="text-xs px-2 py-1 rounded bg-yellow-100 text-yellow-900">
          modo blind: você não vê o saldo esperado
        </div>
      )}

      {!locId ? (
        <div className="space-y-2">
          <div className="text-sm text-zinc-500">
            Escolha uma localização pendente:
          </div>
          {localizacoes.map((l) => (
            <button
              key={l.id}
              onClick={() => pegarLoc.mutate(l.localizacao_id)}
              className="block w-full p-3 rounded border border-zinc-300 text-left"
            >
              <div className="font-mono">{l.localizacao?.codigo}</div>
              <div className="text-xs text-zinc-500">{l.localizacao?.tipo}</div>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="p-2 rounded bg-zinc-100 dark:bg-zinc-900 font-mono">
            localização: {locId.slice(0, 8)}
          </div>
          <ScanContagem onScan={handleScan} />
          <div className="space-y-1">
            {contagensLocal.map((c) => (
              <div
                key={c.produto_id}
                className="flex justify-between p-2 rounded border border-zinc-200 dark:border-zinc-800"
              >
                <span className="font-mono">{c.sku}</span>
                <span className="text-lg tabular-nums">{c.qty}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => finalizar.mutate()}
            disabled={contagensLocal.length === 0 || finalizar.isPending}
            className="w-full py-3 rounded bg-zinc-900 text-white"
          >
            finalizar localização
          </button>
        </>
      )}
    </div>
  );
}
