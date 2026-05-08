"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, Plus, Trash2 } from "lucide-react";
import { wmsApi } from "@/lib/wms/api-client";

interface Item {
  produto_id?: string;
  sku?: string;
  qty: number;
}

interface ProdutoMin {
  id: string;
  sku: string;
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

export default function ReplenishmentPage() {
  const queryClient = useQueryClient();
  const [empresa_id, setEmpresa] = useState<string | undefined>();
  const [galpao_id, setGalpao] = useState<string | undefined>();
  const [origem_loc, setOrigem] = useState<string | undefined>();
  const [destino_loc, setDestino] = useState<string | undefined>();
  const [itens, setItens] = useState<Item[]>([]);

  const { data: galpoesResp } = useQuery({
    queryKey: ["galpoes"],
    queryFn: () => wmsApi<{ galpoes?: GalpaoRow[] }>("/api/admin/galpoes"),
  });

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", galpao_id],
    queryFn: () =>
      wmsApi<{ rows: LocRow[] }>(`/api/wms/localizacoes?galpao_id=${galpao_id}`),
    enabled: !!galpao_id,
  });

  const empresas: EmpresaRow[] = (galpoesResp?.galpoes ?? []).flatMap((g) =>
    (g.empresas ?? []).map((e) => ({ ...e, galpao_id: g.id })),
  );

  async function resolverSku(s: string, idx: number) {
    try {
      const json = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`,
      );
      if (!json.rows?.[0]) {
        toast.error("SKU não encontrado");
        return;
      }
      const p = json.rows[0];
      setItens((prev) =>
        prev.map((x, i) =>
          i === idx ? { ...x, produto_id: p.id, sku: p.sku } : x,
        ),
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>("/api/wms/replenishment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_id,
          galpao_id,
          localizacao_origem_id: origem_loc,
          localizacao_destino_id: destino_loc,
          itens: itens.map((i) => ({ produto_id: i.produto_id, qty: i.qty })),
        }),
      }),
    onSuccess: () => {
      toast.success("Replenishment registrado");
      setItens([]);
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-3">
        <select
          value={empresa_id ?? ""}
          onChange={(e) => {
            const sel = empresas.find((x) => x.id === e.target.value);
            setEmpresa(sel?.id);
            setGalpao(sel?.galpao_id);
            setOrigem(undefined);
            setDestino(undefined);
          }}
          className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
        >
          <option value="">— empresa —</option>
          {empresas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nome}
            </option>
          ))}
        </select>
        <select
          value={origem_loc ?? ""}
          onChange={(e) => setOrigem(e.target.value || undefined)}
          className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
        >
          <option value="">— origem —</option>
          {locs?.rows
            ?.filter((l) => l.id !== destino_loc)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.codigo} ({l.tipo})
              </option>
            ))}
        </select>
        <ArrowDown className="h-4 w-4 self-center text-ink-faint" />
        <select
          value={destino_loc ?? ""}
          onChange={(e) => setDestino(e.target.value || undefined)}
          className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
        >
          <option value="">— destino —</option>
          {locs?.rows
            ?.filter((l) => l.id !== origem_loc)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.codigo} ({l.tipo})
              </option>
            ))}
        </select>
      </div>

      <div className="space-y-1">
        {itens.map((it, idx) => (
          <div
            key={idx}
            className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-2.5"
          >
            <input
              placeholder="SKU"
              defaultValue={it.sku ?? ""}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v && !it.produto_id) resolverSku(v, idx);
                }
              }}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && !it.produto_id) resolverSku(v, idx);
              }}
              className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
            />
            <input
              type="number"
              min={1}
              value={it.qty}
              onChange={(e) =>
                setItens((p) =>
                  p.map((x, i) =>
                    i === idx ? { ...x, qty: Number(e.target.value) } : x,
                  ),
                )
              }
              className="w-20 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm tabular-nums text-ink focus:border-ink focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setItens((p) => p.filter((_, i) => i !== idx))}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-danger"
              title="Remover"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setItens((p) => [...p, { qty: 1 }])}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-ink-muted transition-colors hover:border-ink hover:text-ink"
        >
          <Plus className="h-4 w-4" /> adicionar
        </button>
      </div>

      <button
        type="button"
        onClick={() => submit.mutate()}
        disabled={
          !empresa_id ||
          !origem_loc ||
          !destino_loc ||
          itens.length === 0 ||
          submit.isPending
        }
        className="btn-primary"
      >
        {submit.isPending ? "Salvando..." : "Registrar replenishment"}
      </button>
    </div>
  );
}
