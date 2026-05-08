"use client";
import { use, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
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
    queryFn: async () =>
      (await sisoFetch("/api/wms/devolucoes")).json() as Promise<{
        rows: DevRow[];
      }>,
  });
  const dev = devs?.rows?.find((x) => x.id === id);

  async function buscar(s: string) {
    const r = (await (
      await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`)
    ).json()) as { rows?: ProdutoMin[] };
    if (r.rows?.[0]) {
      setProduto(r.rows[0].id);
      setSku(r.rows[0].sku);
    } else {
      toast.error("SKU não encontrado");
    }
  }

  const submit = useMutation({
    mutationFn: async () =>
      sisoFetch(`/api/wms/devolucoes/${id}/classificar`, {
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
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: () => {
      toast.success("classificada");
      router.push("/wms/devolucoes");
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-3 max-w-xl">
      <h1 className="text-lg font-medium">Classificar devolução</h1>
      {dev && (
        <div className="text-sm text-zinc-500">
          NF {dev.nota_fiscal_id ?? "—"} · {dev.empresa?.nome}
        </div>
      )}

      <select
        value={classificacao}
        onChange={(e) => setClassificacao(e.target.value as Classificacao)}
        className="px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent w-full"
      >
        <option value="integro">A — Íntegro (volta ao estoque)</option>
        <option value="avariado">B — Avariado (vai pra quarentena)</option>
        <option value="garantia">C — Garantia (RMA fornecedor)</option>
        <option value="troca_sku">D — Troca SKU pelo cliente</option>
      </select>

      <QuadruplaPicker value={q} onChange={setQ} />

      <div className="flex gap-2">
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          onBlur={(e) => e.target.value && buscar(e.target.value)}
          placeholder="SKU"
          className="flex-1 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono"
        />
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          className="w-24 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        />
      </div>

      <textarea
        value={observacoes}
        onChange={(e) => setObservacoes(e.target.value)}
        placeholder="observações"
        className="w-full px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        rows={3}
      />

      <button
        onClick={() => submit.mutate()}
        disabled={!produto_id || !q.localizacao_id || submit.isPending}
        className="px-4 py-2 rounded bg-zinc-900 text-white"
      >
        classificar
      </button>
    </div>
  );
}
