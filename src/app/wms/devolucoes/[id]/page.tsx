"use client";
import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { wmsApi } from "@/lib/wms/api-client";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";

type Classificacao = "integro" | "avariado" | "garantia" | "troca_sku";

interface DevRow {
  id: string;
  nota_fiscal_id: number | null;
  empresa?: { nome?: string } | null;
}

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function ClassificarPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [classificacao, setClassificacao] =
    useState<Classificacao>("integro");
  const [produto_id, setProduto] = useState<string>();
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [q, setQ] = useState<{
    empresa_id?: string;
    galpao_id?: string;
    localizacao_id?: string;
  }>({});
  const [observacoes, setObservacoes] = useState("");

  const { data: devs } = useQuery({
    queryKey: ["wms-devolucoes"],
    queryFn: () => wmsApi<{ rows: DevRow[] }>("/api/wms/devolucoes"),
  });
  const dev = devs?.rows?.find((x) => x.id === id);

  async function buscar(s: string) {
    try {
      const r = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`,
      );
      if (r.rows?.[0]) {
        setProduto(r.rows[0].id);
        setSku(r.rows[0].sku);
      } else {
        toast.error("SKU não encontrado");
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/devolucoes/${id}/classificar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classificacao,
          produto_id,
          qty,
          galpao_id: q.galpao_id,
          localizacao_id: q.localizacao_id,
          empresa_dona_destino_id: q.empresa_id,
          observacoes,
        }),
      }),
    onSuccess: () => {
      toast.success("Devolução classificada");
      queryClient.invalidateQueries({ queryKey: ["wms-devolucoes"] });
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      router.push("/wms/devolucoes");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      {dev && (
        <div className="rounded-xl border border-line bg-paper p-3 text-sm text-ink-muted">
          NF{" "}
          <span className="font-mono text-ink">{dev.nota_fiscal_id ?? "—"}</span>{" "}
          · {dev.empresa?.nome}
        </div>
      )}

      <div className="space-y-1">
        <label className="text-xs text-ink-faint">Classificação</label>
        <select
          value={classificacao}
          onChange={(e) => setClassificacao(e.target.value as Classificacao)}
          className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
        >
          <option value="integro">A — Íntegro (volta ao estoque)</option>
          <option value="avariado">B — Avariado (vai pra quarentena)</option>
          <option value="garantia">C — Garantia (RMA fornecedor)</option>
          <option value="troca_sku">D — Troca SKU pelo cliente</option>
        </select>
      </div>

      <QuadruplaPicker value={q} onChange={setQ} />

      <div className="flex flex-wrap gap-2">
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v) buscar(v);
            }
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v) buscar(v);
          }}
          placeholder="SKU"
          className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        />
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          className="w-24 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm tabular-nums text-ink focus:border-ink focus:outline-none"
        />
      </div>

      <textarea
        value={observacoes}
        onChange={(e) => setObservacoes(e.target.value)}
        placeholder="observações"
        className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        rows={3}
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => router.push("/wms/devolucoes")}
          className="btn-ghost"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => submit.mutate()}
          disabled={!produto_id || !q.localizacao_id || submit.isPending}
          className="btn-primary"
        >
          {submit.isPending ? "Salvando..." : "Classificar"}
        </button>
      </div>
    </div>
  );
}
