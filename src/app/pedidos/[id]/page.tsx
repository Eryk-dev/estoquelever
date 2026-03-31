"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRightLeft,
  Copy,
  Loader2,
  Package,
  Tag,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { sisoFetch } from "@/lib/auth-context";
import {
  getEcommerceAbbr,
  getEcommerceColors,
  getFilialColors,
  getDecisaoStripColor,
  formatRelativeTime,
} from "@/lib/domain-helpers";
import { cn } from "@/lib/utils";
import type { Decisao } from "@/types";

// ─── Types ──────────────────────────────────────────────────────────────────

interface DetalheItem {
  id: string;
  produto_id: number;
  sku: string;
  descricao: string;
  quantidade: number;
  imagem_url: string | null;
  fornecedor_oc: string | null;
  compra_status: string | null;
  compra_quantidade_solicitada: number | null;
  compra_quantidade_comprada: number | null;
  compra_quantidade_recebida: number | null;
  separacao_marcado: boolean;
  bipado_completo: boolean;
  localizacao: string | null;
  estoques: Record<
    string,
    {
      deposito: { id: number; nome: string; saldo: number; reservado: number; disponivel: number };
      atende: boolean;
      localizacao?: string;
    }
  >;
}

interface HistoricoEvento {
  id: string;
  evento: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  detalhes: Record<string, unknown> | null;
  criado_em: string;
}

interface Observacao {
  id: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  texto: string;
  criado_em: string;
}

interface PedidoDetalhe {
  id: string;
  numero: string;
  id_pedido_ecommerce: string;
  nome_ecommerce: string;
  cliente_nome: string;
  cliente_cpf_cnpj: string;
  data: string;
  status: string;
  status_separacao: string | null;
  sugestao: string;
  decisao_final: string | null;
  tipo_resolucao: string | null;
  operador: string | null;
  empresa_origem_id: string | null;
  empresa_origem_nome: string | null;
  filial_origem: string | null;
  forma_envio: string | null;
  forma_frete_id: number | null;
  transportador_id: number | null;
  encaminhado_de: string | null;
  processado_em: string | null;
  separacao_operador_id: string | null;
  separacao_iniciada_em: string | null;
  separacao_concluida_em: string | null;
  embalagem_concluida_em: string | null;
  etiqueta_status: string | null;
  etiqueta_url: string | null;
  agrupamento_expedicao_id: string | null;
  compra_estoque_lancado_alerta: boolean | null;
  marcadores: string[];
  separacao_tags: string[];
  erro: string | null;
  criado_em: string;
  itens: DetalheItem[];
  historico: HistoricoEvento[];
  observacoes: Observacao[];
}

// ─── Status badge helpers ───────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pendente: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/60 dark:text-yellow-300",
  executando: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  concluido: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  cancelado: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  erro: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
};

const STATUS_SEPARACAO_COLORS: Record<string, string> = {
  aguardando_compra: "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  aguardando_nf: "bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300",
  aguardando_separacao: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  em_separacao: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/60 dark:text-cyan-300",
  separado: "bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  embalado: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
};

const STATUS_SEPARACAO_LABELS: Record<string, string> = {
  aguardando_compra: "Ag. Compra",
  aguardando_nf: "Ag. NF",
  aguardando_separacao: "Ag. Separacao",
  em_separacao: "Em Separacao",
  separado: "Separado",
  embalado: "Embalado",
};

const DECISAO_BADGE_COLORS: Record<string, string> = {
  propria: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  transferencia: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  oc: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
};

const DECISAO_LABELS: Record<string, string> = {
  propria: "Propria",
  transferencia: "Transferencia",
  oc: "OC",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatDateTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─── Section wrapper ────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-paper p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ─── Page content ───────────────────────────────────────────────────────────

export default function PedidoDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const { data: pedido, isLoading, error } = useQuery<PedidoDetalhe>({
    queryKey: ["pedido-detalhe", id],
    queryFn: async () => {
      const res = await sisoFetch(`/api/pedidos/${id}/detalhe`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Erro ao carregar pedido");
      }
      return res.json();
    },
    enabled: !!id,
  });

  function handleCopyLink() {
    navigator.clipboard.writeText(window.location.href);
    toast.success("Link copiado");
  }

  if (isLoading) {
    return (
      <AppShell title="Pedido">
        <LoadingSpinner message="Carregando pedido..." />
      </AppShell>
    );
  }

  if (error || !pedido) {
    return (
      <AppShell title="Pedido">
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => router.push("/pedidos")}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-faint hover:text-ink transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </button>
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950/30">
            <p className="text-sm text-red-600 dark:text-red-400">
              {error instanceof Error ? error.message : "Pedido nao encontrado"}
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const decisao = pedido.decisao_final ?? pedido.sugestao;
  const stripColor = getDecisaoStripColor(decisao as Decisao);
  const ecommerceAbbr = getEcommerceAbbr(pedido.nome_ecommerce);
  const ecommerceColors = getEcommerceColors(pedido.nome_ecommerce);

  return (
    <AppShell title={`Pedido #${pedido.numero}`}>
      <div className="space-y-4">
        {/* Back + copy */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => router.push("/pedidos")}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-faint hover:text-ink transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </button>

          <button
            type="button"
            onClick={handleCopyLink}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-faint hover:text-ink hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            <Copy className="h-3.5 w-3.5" />
            Copiar link
          </button>
        </div>

        {/* ── Header card ─────────────────────────────────────────────── */}
        <div className="flex overflow-hidden rounded-2xl border border-line bg-paper shadow-sm">
          <div className={cn("w-1.5 shrink-0", stripColor)} aria-hidden="true" />

          <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            {/* Row 1: numero + EC + marketplace */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-lg font-bold text-ink">
                #{pedido.numero}
              </span>
              {pedido.id_pedido_ecommerce && (
                <span className="font-mono text-sm text-ink-faint">
                  EC {pedido.id_pedido_ecommerce}
                </span>
              )}
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide",
                  ecommerceColors,
                )}
                title={pedido.nome_ecommerce}
              >
                {ecommerceAbbr}
              </span>
            </div>

            {/* Row 2: cliente + date */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-ink">
                {pedido.cliente_nome}
              </span>
              {pedido.cliente_cpf_cnpj && (
                <span className="font-mono text-xs text-ink-faint">
                  {pedido.cliente_cpf_cnpj}
                </span>
              )}
              <span className="text-xs text-ink-faint">
                {formatDate(pedido.data)}
              </span>
            </div>

            {/* Row 3: forma envio */}
            {pedido.forma_envio && (
              <span className="text-xs text-ink-faint">
                Envio: {pedido.forma_envio}
              </span>
            )}
          </div>
        </div>

        {/* ── Status section ─────────────────────────────────────────── */}
        <Section title="Status">
          <div className="flex flex-wrap items-center gap-2">
            {/* Status */}
            <span
              className={cn(
                "rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
                STATUS_COLORS[pedido.status] ?? STATUS_COLORS.pendente,
              )}
            >
              {pedido.status}
            </span>

            {/* Status separacao */}
            {pedido.status_separacao && (
              <span
                className={cn(
                  "rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
                  STATUS_SEPARACAO_COLORS[pedido.status_separacao] ??
                    "bg-zinc-100 text-zinc-600",
                )}
              >
                {STATUS_SEPARACAO_LABELS[pedido.status_separacao] ??
                  pedido.status_separacao}
              </span>
            )}

            {/* Decisao */}
            {decisao && (
              <>
                <span className="h-4 w-px bg-line" aria-hidden="true" />
                <span className="text-xs text-ink-faint">Decisao:</span>
                <span
                  className={cn(
                    "rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
                    DECISAO_BADGE_COLORS[decisao] ?? "bg-zinc-100 text-zinc-600",
                  )}
                >
                  {DECISAO_LABELS[decisao] ?? decisao}
                </span>
                {pedido.sugestao && pedido.decisao_final && pedido.sugestao !== pedido.decisao_final && (
                  <span className="text-[11px] text-ink-faint">
                    (sugestao: {DECISAO_LABELS[pedido.sugestao] ?? pedido.sugestao})
                  </span>
                )}
              </>
            )}

            {/* Tipo resolucao */}
            {pedido.tipo_resolucao && (
              <>
                <span className="h-4 w-px bg-line" aria-hidden="true" />
                <span
                  className={cn(
                    "rounded px-2 py-0.5 text-[11px] font-medium",
                    pedido.tipo_resolucao === "auto"
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
                  )}
                >
                  {pedido.tipo_resolucao === "auto" ? "Auto" : "Manual"}
                </span>
              </>
            )}

            {/* Operador */}
            {pedido.operador && (
              <>
                <span className="h-4 w-px bg-line" aria-hidden="true" />
                <span className="text-xs text-ink-faint">
                  por {pedido.operador}
                </span>
              </>
            )}
          </div>

          {/* Error message */}
          {pedido.erro && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
              {pedido.erro}
            </div>
          )}
        </Section>

        {/* ── Empresa section ────────────────────────────────────────── */}
        <Section title="Empresa">
          <div className="flex flex-wrap items-center gap-2">
            {pedido.empresa_origem_nome && (
              <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {pedido.empresa_origem_nome}
              </span>
            )}

            {pedido.filial_origem && (
              <span
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-xs font-semibold",
                  getFilialColors(pedido.filial_origem),
                )}
              >
                {pedido.filial_origem}
              </span>
            )}

            {pedido.encaminhado_de && (
              <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[11px] font-semibold text-purple-700 dark:bg-purple-950/30 dark:text-purple-300">
                <ArrowRightLeft className="h-3 w-3" />
                Encaminhado de {pedido.encaminhado_de}
              </span>
            )}
          </div>

          {/* Timestamps */}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span>Criado: {formatDateTime(pedido.criado_em)}</span>
            {pedido.processado_em && (
              <span>Processado: {formatDateTime(pedido.processado_em)}</span>
            )}
            {pedido.separacao_iniciada_em && (
              <span>
                Separacao: {formatRelativeTime(pedido.separacao_iniciada_em)}
              </span>
            )}
            {pedido.separacao_concluida_em && (
              <span>
                Separado: {formatRelativeTime(pedido.separacao_concluida_em)}
              </span>
            )}
            {pedido.embalagem_concluida_em && (
              <span>
                Embalado: {formatRelativeTime(pedido.embalagem_concluida_em)}
              </span>
            )}
          </div>
        </Section>

        {/* ── Marcadores + Tags ──────────────────────────────────────── */}
        {(pedido.marcadores.length > 0 || pedido.separacao_tags.length > 0) && (
          <Section title="Marcadores">
            <div className="flex flex-wrap gap-1.5">
              {pedido.marcadores.map((m) => (
                <span
                  key={`m-${m}`}
                  className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                >
                  <Tag className="h-2.5 w-2.5" />
                  {m}
                </span>
              ))}
              {pedido.separacao_tags.map((t) => (
                <span
                  key={`t-${t}`}
                  className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:bg-blue-950/40 dark:text-blue-300"
                >
                  <Package className="h-2.5 w-2.5" />
                  {t}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Placeholder for future sections (itens, timeline, observacoes, acoes) */}
      </div>
    </AppShell>
  );
}
