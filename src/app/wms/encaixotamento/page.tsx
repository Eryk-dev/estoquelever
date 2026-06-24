"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Undo2, PackageCheck } from "lucide-react";

import { sisoFetch } from "@/lib/auth-context";
import { PageHeader } from "@/components/wms/ui/wms-ui";
import { HandheldScan } from "@/components/wms/vendas/handheld-scan";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Alocacao {
  pedido_id: string;
  pedido_item_id: string;
  numero: string | null;
  prazo_envio: string | null;
  dia: string | null;
  qty: number;
}
interface BipResposta {
  codigo: string;
  sku: string | null;
  descricao: string | null;
  imagem_url: string | null;
  qty_pedida: number;
  qty_alocada: number;
  sobra: number;
  alocacoes: Alocacao[];
}
interface CaixaDia {
  dia: string;
  pedidos: number;
  total_un: number;
  encaixotado_un: number;
  falta_un: number;
  completo: boolean;
}
interface Overview {
  caixas: CaixaDia[];
  total_un: number;
  falta_un: number;
}
interface HistoricoBipe {
  hora: string;
  codigo: string;
  resultado: string;
  tone: "ok" | "warn" | "error";
}

const SEM_PRAZO = "sem-prazo";

// dia = "YYYY-MM-DD" → "dd/mm"
function fmtDia(dia: string | null): string {
  if (!dia || dia === SEM_PRAZO) return "Sem prazo";
  const [, m, d] = dia.split("-");
  if (!m || !d) return dia;
  return `${d}/${m}`;
}

/** Agrupa as alocações do bip por dia (vários pedidos podem cair no mesmo dia). */
function agruparPorDia(alocacoes: Alocacao[]): Array<{ dia: string | null; qty: number; pedidos: number }> {
  const map = new Map<string, { dia: string | null; qty: number; pedidos: Set<string> }>();
  for (const a of alocacoes) {
    const key = a.dia ?? SEM_PRAZO;
    const cur = map.get(key) ?? { dia: a.dia, qty: 0, pedidos: new Set<string>() };
    cur.qty += a.qty;
    cur.pedidos.add(a.pedido_id);
    map.set(key, cur);
  }
  return [...map.values()]
    .map((v) => ({ dia: v.dia, qty: v.qty, pedidos: v.pedidos.size }))
    .sort((a, b) => ((a.dia ?? "") < (b.dia ?? "") ? -1 : 1));
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function WmsEncaixotamentoPage() {
  const queryClient = useQueryClient();
  const [qty, setQty] = useState(1);
  const [ultimo, setUltimo] = useState<BipResposta | null>(null);
  const [historico, setHistorico] = useState<HistoricoBipe[]>([]);
  const [scanFeedback, setScanFeedback] = useState<{
    text: string;
    tone: "ok" | "warn" | "error" | "neutral";
  } | null>(null);

  const overviewQuery = useQuery<Overview>({
    queryKey: ["encaixotamento-overview"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/encaixotamento");
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? "Erro");
      return json as Overview;
    },
  });

  function pushHistorico(entry: Omit<HistoricoBipe, "hora">) {
    setHistorico((h) => [{ ...entry, hora: new Date().toISOString() }, ...h.slice(0, 19)]);
  }

  const biparMut = useMutation({
    mutationFn: async ({ codigo, qty }: { codigo: string; qty: number }) => {
      const r = await sisoFetch("/api/wms/encaixotamento/bipar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo, qty }),
      });
      const json = await r.json();
      if (!r.ok) throw Object.assign(new Error(json.mensagem ?? json.error ?? "Erro"), { codigo });
      return json as BipResposta;
    },
    onSuccess: (json) => {
      setUltimo(json);
      const nome = json.descricao ?? json.sku ?? json.codigo;
      const grupos = agruparPorDia(json.alocacoes);
      const resumo = grupos.map((g) => `${fmtDia(g.dia)}: ${g.qty}`).join(" · ");
      if (json.sobra > 0) {
        setScanFeedback({
          text: `${nome} — alocado ${json.qty_alocada}, sobra ${json.sobra} (sem pedido). ${resumo}`,
          tone: "warn",
        });
        pushHistorico({ codigo: json.codigo, resultado: `sobra ${json.sobra} · ${resumo}`, tone: "warn" });
      } else {
        setScanFeedback({ text: `${nome} — ${resumo}`, tone: "ok" });
        pushHistorico({ codigo: json.codigo, resultado: resumo, tone: "ok" });
      }
      setQty(1);
      queryClient.invalidateQueries({ queryKey: ["encaixotamento-overview"] });
    },
    onError: (err: Error & { codigo?: string }) => {
      setScanFeedback({ text: err.message, tone: "error" });
      pushHistorico({ codigo: err.codigo ?? "?", resultado: err.message, tone: "error" });
    },
  });

  // Fila local processada serial — operador bipa em ritmo sem perder leituras.
  // A qty é capturada no momento do bip.
  const filaRef = useRef<Array<{ codigo: string; qty: number }>>([]);
  const drainingRef = useRef(false);
  async function drainFila() {
    if (drainingRef.current) return;
    drainingRef.current = true;
    while (filaRef.current.length > 0) {
      const item = filaRef.current.shift()!;
      try {
        await biparMut.mutateAsync(item);
      } catch {
        /* onError já tratou */
      }
    }
    drainingRef.current = false;
  }

  function handleScan(codigo: string) {
    filaRef.current.push({ codigo, qty });
    void drainFila();
  }

  const desfazerMut = useMutation({
    mutationFn: async (alocacoes: Alocacao[]) => {
      const r = await sisoFetch("/api/wms/encaixotamento/desfazer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alocacoes }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? "Erro ao desfazer");
      return json;
    },
    onSuccess: () => {
      toast.success("Último bip desfeito");
      setUltimo(null);
      setScanFeedback({ text: "Desfeito", tone: "neutral" });
      queryClient.invalidateQueries({ queryKey: ["encaixotamento-overview"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const overview = overviewQuery.data;
  const gruposUltimo = ultimo ? agruparPorDia(ultimo.alocacoes) : [];

  return (
    <div className="wms-encaix-page">
      <PageHeader
        title="Encaixotamento"
        subtitle="Distribua o carrinho da separação futura nas caixas por dia de despacho — bipe o item, informe a quantidade, deposite na caixa indicada."
        backHref="/wms/separacao-futura"
        backLabel="Sep. futura"
      />

      <div className="wms-encaix-grid">
        {/* Coluna de bipagem */}
        <div className="wms-encaix-scan">
          <label className="wms-encaix-qty-lbl">
            Quantidade em mãos
            <input
              type="number"
              min={1}
              className="wms-encaix-qty-input"
              value={qty}
              onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </label>

          <HandheldScan
            label="Bipe SKU ou EAN"
            placeholder="Bipe ou digite o código e Enter…"
            onSubmit={handleScan}
            feedback={scanFeedback}
            pending={biparMut.isPending}
          />

          {/* Resultado do último bip: caixas + qty */}
          {ultimo && ultimo.alocacoes.length > 0 ? (
            <div className="wms-encaix-result">
              <div className="wms-encaix-result-hd">
                {ultimo.imagem_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ultimo.imagem_url} alt="" className="wms-encaix-foto" />
                ) : null}
                <div>
                  <div className="wms-encaix-result-nome">{ultimo.descricao ?? "—"}</div>
                  <div className="wms-encaix-result-sku">{ultimo.sku ?? ultimo.codigo}</div>
                </div>
                <button
                  type="button"
                  className="wms-encaix-undo"
                  onClick={() => desfazerMut.mutate(ultimo.alocacoes)}
                  disabled={desfazerMut.isPending}
                >
                  <Undo2 size={14} /> Desfazer
                </button>
              </div>

              <div className="wms-encaix-boxes">
                {gruposUltimo.map((g) => (
                  <div key={g.dia ?? SEM_PRAZO} className="wms-encaix-box">
                    <div className="wms-encaix-box-dia">Caixa {fmtDia(g.dia)}</div>
                    <div className="wms-encaix-box-qty">{g.qty}</div>
                    <div className="wms-encaix-box-ped">{g.pedidos} pedido{g.pedidos > 1 ? "s" : ""}</div>
                  </div>
                ))}
              </div>

              {ultimo.sobra > 0 ? (
                <div className="wms-encaix-sobra">
                  Sobra {ultimo.sobra} un — nenhum pedido futura precisa dessas. Não deposite em caixa.
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Histórico recente */}
          {historico.length > 0 ? (
            <div className="wms-encaix-hist">
              {historico.map((h, i) => (
                <div key={i} className={`wms-encaix-hist-row is-${h.tone}`}>
                  <span className="wms-encaix-hist-cod">{h.codigo}</span>
                  <span className="wms-encaix-hist-res">{h.resultado}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* Coluna painel de caixas */}
        <div className="wms-encaix-painel">
          <div className="wms-encaix-painel-hd">
            <PackageCheck size={15} /> Caixas do dia
            {overview ? (
              <span className="wms-encaix-painel-tot">
                {overview.falta_un} de {overview.total_un} un a encaixotar
              </span>
            ) : null}
          </div>
          {overviewQuery.isLoading ? (
            <div className="wms-encaix-empty">Carregando…</div>
          ) : !overview || overview.caixas.length === 0 ? (
            <div className="wms-encaix-empty">Nenhum pedido futura separado no momento.</div>
          ) : (
            <div className="wms-encaix-painel-list">
              {overview.caixas.map((c) => (
                <div key={c.dia} className={`wms-encaix-caixa${c.completo ? " is-completo" : ""}`}>
                  <div className="wms-encaix-caixa-dia">{fmtDia(c.dia)}</div>
                  <div className="wms-encaix-caixa-prog">
                    <div className="wms-encaix-caixa-bar">
                      <div
                        className="wms-encaix-caixa-fill"
                        style={{ width: `${c.total_un > 0 ? (c.encaixotado_un / c.total_un) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="wms-encaix-caixa-num">
                      {c.encaixotado_un}/{c.total_un}
                    </span>
                  </div>
                  <div className="wms-encaix-caixa-meta">
                    {c.pedidos} pedido{c.pedidos > 1 ? "s" : ""} · {c.completo ? "completa" : `faltam ${c.falta_un}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
