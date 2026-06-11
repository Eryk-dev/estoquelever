"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { X, Loader2, AlertTriangle } from "lucide-react";

import { sisoFetch } from "@/lib/auth-context";
import { PageHeader, fmtRelative } from "@/components/wms/ui/wms-ui";
import { HandheldScan } from "@/components/wms/vendas/handheld-scan";

// ─── Types ──────────────────────────────────────────────────────────────────

type Modo = "conferir" | "embalar";

interface ItemConferencia {
  id: string;
  sku: string | null;
  gtin: string | null;
  descricao: string | null;
  quantidade_pedida: number;
  imagem_url: string | null;
}

interface PedidoBipado {
  id: string;
  numero: string | null;
  nome_ecommerce: string | null;
  id_pedido_ecommerce: string | null;
  status_separacao: string;
  embalado_real_por: string | null;
  embalado_real_por_nome: string | null;
  embalado_real_em: string | null;
  conferido_por: string | null;
  conferido_por_nome: string | null;
  conferido_em: string | null;
  divergencia_tipo: string | null;
}

interface BipResposta {
  pedido: PedidoBipado;
  itens: ItemConferencia[];
  via: string;
  aviso: "ja_embalado" | "ja_conferido" | null;
}

interface HistoricoBipe {
  hora: string;
  codigo: string;
  resultado: string;
  tone: "ok" | "warn" | "error";
  pedidoNumero?: string | null;
}

const TIPOS_DIVERGENCIA = [
  { id: "produto_errado", label: "Produto errado" },
  { id: "faltou_item", label: "Faltou item" },
  { id: "sobrou_item", label: "Sobrou item" },
  { id: "quantidade_errada", label: "Quantidade errada" },
] as const;

const MODO_STORAGE_KEY = "siso_conferencia_modo";

// ─── Page ───────────────────────────────────────────────────────────────────

function getModoInicial(): Modo {
  if (typeof window === "undefined") return "conferir";
  try {
    const saved = localStorage.getItem(MODO_STORAGE_KEY);
    return saved === "embalar" ? "embalar" : "conferir";
  } catch {
    return "conferir";
  }
}

export default function WmsConferenciaPage() {
  // Modo persiste entre sessões da bancada
  const [modo, setModo] = useState<Modo>(getModoInicial);
  const [ultimo, setUltimo] = useState<BipResposta | null>(null);
  const [historico, setHistorico] = useState<HistoricoBipe[]>([]);
  const [divergenciaAberta, setDivergenciaAberta] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<{
    text: string;
    tone: "ok" | "warn" | "error" | "neutral";
  } | null>(null);

  function trocarModo(m: Modo) {
    setModo(m);
    localStorage.setItem(MODO_STORAGE_KEY, m);
    setScanFeedback(null);
  }

  function pushHistorico(entry: Omit<HistoricoBipe, "hora">) {
    setHistorico((h) => [
      { ...entry, hora: new Date().toISOString() },
      ...h.slice(0, 19),
    ]);
  }

  const biparMut = useMutation({
    mutationFn: async (codigo: string) => {
      const r = await sisoFetch("/api/wms/separacao/conferencia/bipar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo, modo }),
      });
      const json = await r.json();
      if (!r.ok) throw Object.assign(new Error(json.mensagem ?? json.error ?? "Erro"), { codigo });
      return { json: json as BipResposta, codigo };
    },
    onSuccess: ({ json, codigo }) => {
      setUltimo(json);
      const num = json.pedido.numero ?? json.pedido.id;
      if (json.aviso === "ja_conferido") {
        const quem = json.pedido.conferido_por_nome ?? "outro operador";
        setScanFeedback({ text: `#${num} já conferido por ${quem}`, tone: "warn" });
        pushHistorico({ codigo, resultado: `já conferido por ${quem}`, tone: "warn", pedidoNumero: num });
      } else if (json.aviso === "ja_embalado") {
        const quem = json.pedido.embalado_real_por_nome ?? "outro operador";
        setScanFeedback({ text: `#${num} já embalado por ${quem}`, tone: "warn" });
        pushHistorico({ codigo, resultado: `já embalado por ${quem}`, tone: "warn", pedidoNumero: num });
      } else if (modo === "embalar") {
        setScanFeedback({ text: `#${num} — embalagem registrada`, tone: "ok" });
        pushHistorico({ codigo, resultado: "embalado", tone: "ok", pedidoNumero: num });
      } else {
        setScanFeedback({ text: `#${num} conferido — confira os itens abaixo`, tone: "ok" });
        pushHistorico({ codigo, resultado: "conferido", tone: "ok", pedidoNumero: num });
      }
    },
    onError: (err: Error & { codigo?: string }) => {
      setScanFeedback({ text: err.message, tone: "error" });
      pushHistorico({ codigo: err.codigo ?? "?", resultado: err.message, tone: "error" });
    },
  });

  const divergenciaMut = useMutation({
    mutationFn: async (params: { pedido_id: string; tipo: string; observacao: string }) => {
      const r = await sisoFetch("/api/wms/separacao/conferencia/divergencia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_id: params.pedido_id,
          tipo: params.tipo,
          observacao: params.observacao || undefined,
        }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.mensagem ?? json.error ?? "Erro");
      return json as { tipo: string };
    },
    onSuccess: (json) => {
      setDivergenciaAberta(false);
      setUltimo((u) =>
        u ? { ...u, pedido: { ...u.pedido, divergencia_tipo: json.tipo } } : u,
      );
      toast.success("Divergência registrada — arrume o pacote e siga");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const pedido = ultimo?.pedido ?? null;
  const totalUnidades = (ultimo?.itens ?? []).reduce((s, i) => s + i.quantidade_pedida, 0);

  return (
    <>
      <PageHeader
        title="Conferência de embalagem"
        subtitle="Bipe a etiqueta de envio (ML/Shopee) — bipar a próxima confirma a anterior"
        backHref="/wms/separacao"
        backLabel="Separação"
      >
        <div style={{ display: "flex", gap: 4 }}>
          {(["conferir", "embalar"] as Modo[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`wms-btn wms-btn-sm ${modo === m ? "wms-btn-primary" : "wms-btn-ghost"}`}
              onClick={() => trocarModo(m)}
            >
              {m === "conferir" ? "Conferir" : "Embalar"}
            </button>
          ))}
        </div>
      </PageHeader>

      <HandheldScan
        label={
          modo === "conferir"
            ? "Bipe a etiqueta de envio pra CONFERIR"
            : "Bipe a etiqueta de envio pra registrar que VOCÊ embalou"
        }
        placeholder="Bipe ou digite e Enter…"
        onSubmit={(code) => biparMut.mutate(code)}
        feedback={scanFeedback}
        pending={biparMut.isPending}
      />

      {/* Card do último pedido bipado */}
      {pedido && (
        <div className="wms-card" style={{ marginTop: 12, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="wms-mono" style={{ fontSize: 16, fontWeight: 700 }}>
              #{pedido.numero ?? pedido.id}
            </span>
            {pedido.nome_ecommerce && (
              <span className="wms-badge wms-badge-info">{pedido.nome_ecommerce}</span>
            )}
            {pedido.embalado_real_por_nome && (
              <span className="wms-badge wms-badge-mute">
                embalado por {pedido.embalado_real_por_nome}
              </span>
            )}
            {pedido.conferido_por_nome && (
              <span className="wms-badge wms-badge-ok">
                conferido por {pedido.conferido_por_nome}
              </span>
            )}
            {pedido.divergencia_tipo && (
              <span className="wms-badge wms-badge-danger">
                divergência: {TIPOS_DIVERGENCIA.find((t) => t.id === pedido.divergencia_tipo)?.label ?? pedido.divergencia_tipo}
              </span>
            )}
            {modo === "conferir" && pedido.status_separacao === "conferido" && !pedido.divergencia_tipo && (
              <button
                type="button"
                className="wms-btn wms-btn-sm wms-btn-ghost"
                style={{ marginLeft: "auto", color: "#b91c1c", borderColor: "#fca5a5" }}
                onClick={() => setDivergenciaAberta(true)}
              >
                <AlertTriangle size={13} style={{ marginRight: 4 }} />
                Divergência
              </button>
            )}
          </div>

          <div className="wms-td-mute" style={{ fontSize: 12, marginTop: 6 }}>
            {ultimo!.itens.length} item(s) · {totalUnidades} unidade(s) esperadas no pacote
          </div>

          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {ultimo!.itens.map((item) => (
              <div
                key={item.id}
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                {item.imagem_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.imagem_url} alt="" loading="lazy" className="wms-thumb wms-thumb-md" />
                ) : (
                  <div
                    className="wms-thumb wms-thumb-md"
                    style={{ background: "var(--wms-c-faint)", border: "1px solid var(--wms-c-border)" }}
                  />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="wms-mono" style={{ fontWeight: 600, fontSize: 13 }}>
                    {item.sku}
                  </div>
                  <div
                    className="wms-td-mute"
                    style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={item.descricao ?? undefined}
                  >
                    {item.descricao}
                  </div>
                </div>
                <div className="wms-mono" style={{ fontSize: 18, fontWeight: 700 }}>
                  ×{item.quantidade_pedida}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Histórico da sessão */}
      {historico.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3 className="wms-sec-h">Bipes desta sessão</h3>
          <div style={{ display: "grid", gap: 2 }}>
            {historico.map((h, idx) => (
              <div
                key={`${h.hora}-${idx}`}
                style={{ display: "flex", gap: 10, fontSize: 12, alignItems: "baseline" }}
              >
                <span className="wms-td-mute" style={{ minWidth: 52 }}>
                  {fmtRelative(h.hora)}
                </span>
                <span className="wms-mono" style={{ minWidth: 90 }}>
                  {h.pedidoNumero ? `#${h.pedidoNumero}` : h.codigo.slice(0, 18)}
                </span>
                <span
                  style={{
                    color:
                      h.tone === "ok"
                        ? "var(--wms-c-ok)"
                        : h.tone === "warn"
                          ? "#b45309"
                          : "#b91c1c",
                  }}
                >
                  {h.resultado}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!pedido && historico.length === 0 && (
        <div className="wms-empty-block" style={{ marginTop: 16 }}>
          <h3>{modo === "conferir" ? "Pronto pra conferir" : "Pronto pra embalar"}</h3>
          <p>
            {modo === "conferir"
              ? "Bipe a etiqueta de envio do pacote: o sistema mostra o que deveria estar dentro. Tudo certo? Bipe a próxima. Errado? Clique em Divergência."
              : "Antes de embalar, bipe a etiqueta de envio — fica registrado que foi você que embalou esse pacote."}
          </p>
        </div>
      )}

      <DivergenciaModal
        key={divergenciaAberta ? "aberto" : "fechado"}
        open={divergenciaAberta}
        loading={divergenciaMut.isPending}
        onConfirm={(tipo, observacao) =>
          pedido && divergenciaMut.mutate({ pedido_id: pedido.id, tipo, observacao })
        }
        onCancel={() => setDivergenciaAberta(false)}
        pedidoNumero={pedido?.numero ?? pedido?.id ?? ""}
      />
    </>
  );
}

// ─── DivergenciaModal ───────────────────────────────────────────────────────

function DivergenciaModal({
  open,
  loading,
  onConfirm,
  onCancel,
  pedidoNumero,
}: {
  open: boolean;
  loading: boolean;
  onConfirm: (tipo: string, observacao: string) => void;
  onCancel: () => void;
  pedidoNumero: string;
}) {
  // Estado zera a cada abertura via prop `key` no caller (remonta o componente)
  const [tipo, setTipo] = useState<string | null>(null);
  const [obs, setObs] = useState("");

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Divergência no #{pedidoNumero}
          </h2>
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          O que está errado no pacote? O erro fica registrado contra quem
          embalou; arrume o conteúdo e siga conferindo.
        </p>

        <div className="mb-4 grid grid-cols-2 gap-2">
          {TIPOS_DIVERGENCIA.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={loading}
              onClick={() => setTipo(t.id)}
              className={`rounded-xl border p-3 text-sm font-medium ${
                tipo === t.id
                  ? "border-red-500 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                  : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <textarea
          value={obs}
          onChange={(e) => setObs(e.target.value)}
          disabled={loading}
          placeholder="Observação (opcional) — ex: veio 1x filtro de óleo no lugar"
          rows={2}
          className="mb-4 w-full rounded-xl border border-zinc-200 bg-white p-3 text-sm text-zinc-900 focus:border-red-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onCancel}
            disabled={loading}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            style={{ background: "#b91c1c", borderColor: "#b91c1c" }}
            disabled={loading || !tipo}
            onClick={() => tipo && onConfirm(tipo, obs.trim())}
          >
            {loading && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Registrar divergência
          </button>
        </div>
      </div>
    </div>
  );
}
