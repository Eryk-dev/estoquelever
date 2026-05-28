"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader } from "@/components/wms/ui/wms-ui";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";

interface ItemOC {
  id: string;
  sku: string;
  descricao: string;
  imagem_url: string | null;
  esperado: number;
  ja_recebido: number;
  pendente: number;
  produto_id: number;
}

interface OCInfo {
  id: string;
  fornecedor: string | null;
  galpao_nome: string | null;
  status: string;
}

const MOTIVOS_DIVERGENCIA = [
  { value: "avaria_transporte", label: "Avaria em trânsito" },
  { value: "faltou", label: "Faltou na entrega" },
  { value: "veio_mais", label: "Veio mais que pedido" },
  { value: "sku_errado", label: "SKU errado" },
];

export default function ReceberOCDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [itens, setItens] = useState<ItemOC[]>([]);
  const [qtyReal, setQtyReal] = useState<Record<string, string>>({});
  const [custos, setCustos] = useState<Record<string, string>>({});
  const [motivos, setMotivos] = useState<Record<string, string>>({});
  const [ocInfo, setOcInfo] = useState<OCInfo | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!id) return;
    void sisoFetch(`/api/wms/receber/oc/${id}`)
      .then((r) => r.json())
      .then((data) => {
        setItens(data.itens ?? []);
        setOcInfo(data.oc ?? null);
        const initQty: Record<string, string> = {};
        for (const it of data.itens ?? []) initQty[it.id] = String(it.pendente);
        setQtyReal(initQty);
      })
      .catch(() => toast.error("Erro ao carregar OC"));
  }, [id]);

  async function handleConfirmar() {
    if (enviando) return;
    setEnviando(true);
    try {
      const payload = {
        itens: itens.map((it) => {
          const qty = Number(qtyReal[it.id] ?? "0");
          const custo = Number(custos[it.id] ?? "0");
          const divergiu = qty !== it.pendente;
          return {
            item_id: it.id,
            qty_real: qty,
            custo_unitario: custo > 0 ? custo : undefined,
            motivo_divergencia:
              divergiu && motivos[it.id] ? motivos[it.id] : undefined,
          };
        }),
      };
      const r = await sisoFetch(`/api/wms/receber/oc/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const result = await r.json();
        toast.success(
          `${result.itens_recebidos} item(s) recebido(s)${result.oc_fechada ? " · OC fechada" : ""}`,
        );
        router.push("/wms/receber/oc");
      } else {
        const body = await r.json().catch(() => ({}));
        toast.error(body.error ?? "Falha ao receber");
      }
    } catch {
      toast.error("Erro de conexão");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <PageHeader
        title={`OC ${ocInfo?.id.slice(0, 8) ?? "—"}`}
        subtitle={
          ocInfo
            ? `${ocInfo.fornecedor ?? "—"} · ${ocInfo.galpao_nome ?? "—"} · ${ocInfo.status}`
            : "Carregando…"
        }
      />
      <div className="px-4 pb-12 max-w-4xl mx-auto pt-4">
        <Link
          href="/wms/receber/oc"
          className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          <ChevronLeft size={14} /> Voltar pra lista
        </Link>

        <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-3">SKU</th>
                <th className="px-4 py-3">Esperado</th>
                <th className="px-4 py-3">Qty real</th>
                <th className="px-4 py-3">Custo unit.</th>
                <th className="px-4 py-3">Divergência</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((it) => {
                const qty = Number(qtyReal[it.id] ?? "0");
                const divergiu = qty !== it.pendente;
                return (
                  <tr
                    key={it.id}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">
                        {it.sku}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        {it.descricao}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                      {it.pendente}
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        min={0}
                        value={qtyReal[it.id] ?? ""}
                        onChange={(e) =>
                          setQtyReal({ ...qtyReal, [it.id]: e.target.value })
                        }
                        className="w-20 rounded-lg border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        placeholder="R$"
                        value={custos[it.id] ?? ""}
                        onChange={(e) =>
                          setCustos({ ...custos, [it.id]: e.target.value })
                        }
                        className="w-24 rounded-lg border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </td>
                    <td className="px-4 py-3">
                      {divergiu ? (
                        <select
                          value={motivos[it.id] ?? ""}
                          onChange={(e) =>
                            setMotivos({ ...motivos, [it.id]: e.target.value })
                          }
                          className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-sm dark:border-amber-900/50 dark:bg-amber-950/30"
                        >
                          <option value="">Motivo…</option>
                          {MOTIVOS_DIVERGENCIA.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <button
          onClick={handleConfirmar}
          disabled={enviando || itens.length === 0}
          className="mt-6 w-full rounded-xl bg-emerald-600 px-4 py-3 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {enviando ? "Recebendo…" : "Confirmar recebimento"}
        </button>
      </div>
    </>
  );
}
