"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader } from "@/components/wms/ui/wms-ui";
import { LocalizacaoCombo } from "@/components/wms/ui/modals";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";

interface TransferenciaItem {
  id: string;
  sku: string | null;
  qty: number;
  produto_id: string;
  mov_entrada_id: string | null;
}

interface TransferenciaInfo {
  id: string;
  galpao_destino_id: string;
  galpao_destino_nome: string | null;
  galpao_origem_nome: string | null;
  status: string;
}

export default function ReceberTransferenciaDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [info, setInfo] = useState<TransferenciaInfo | null>(null);
  const [itens, setItens] = useState<TransferenciaItem[]>([]);
  const [locDestino, setLocDestino] = useState<Record<string, string>>({});
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!id) return;
    void sisoFetch(`/api/wms/receber/transferencia/${id}`)
      .then((r) => r.json())
      .then((tj) => {
        const det = tj?.transferencia ?? null;
        if (det) {
          setInfo({
            id: det.id,
            galpao_destino_id: det.galpao_destino_id,
            galpao_destino_nome: det.destino_nome,
            galpao_origem_nome: det.origem_nome,
            status: det.status,
          });
          setItens(det.itens ?? []);
        }
      })
      .catch(() => toast.error("Erro ao carregar transferência"));
  }, [id]);

  async function handleConfirmar() {
    if (enviando) return;
    setEnviando(true);
    try {
      const payload = {
        itens: itens.map((it) => ({
          transferencia_item_id: it.id,
          localizacao_destino_id: locDestino[it.id],
        })).filter((it) => !!it.localizacao_destino_id),
      };
      if (payload.itens.length !== itens.length) {
        toast.error("Defina a loc destino em todos os itens");
        setEnviando(false);
        return;
      }
      const r = await sisoFetch(`/api/wms/transferencias/${id}/receber`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        toast.success("Transferência recebida");
        router.push("/wms/receber/transferencia");
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
        title={`Transferência ${info?.id.slice(0, 8) ?? "—"}`}
        subtitle={
          info
            ? `${info.galpao_origem_nome ?? "—"} → ${info.galpao_destino_nome ?? "—"} · ${info.status}`
            : "Carregando…"
        }
      />
      <div className="px-4 pb-12 max-w-4xl mx-auto pt-4">
        <Link
          href="/wms/receber/transferencia"
          className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          <ChevronLeft size={14} /> Voltar pra lista
        </Link>

        {itens.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            Nenhum item pendente nesta transferência.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3">SKU</th>
                  <th className="px-4 py-3">Qty</th>
                  <th className="px-4 py-3">Loc destino</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((it) => (
                  <tr
                    key={it.id}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                      {it.sku ?? `produto ${String(it.produto_id).slice(0, 8)}`}
                    </td>
                    <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                      {it.qty}
                    </td>
                    <td className="px-4 py-3">
                      {info && (
                        <LocalizacaoCombo
                          galpaoId={info.galpao_destino_id}
                          value={locDestino[it.id] ?? ""}
                          onChange={(v) =>
                            setLocDestino({ ...locDestino, [it.id]: v })
                          }
                          allowCreate={false}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {itens.length > 0 && (
          <button
            onClick={handleConfirmar}
            disabled={enviando}
            className="mt-6 w-full rounded-xl bg-sky-600 px-4 py-3 font-medium text-white hover:bg-sky-700 disabled:opacity-60"
          >
            {enviando ? "Recebendo…" : "Confirmar recebimento"}
          </button>
        )}
      </div>
    </>
  );
}
