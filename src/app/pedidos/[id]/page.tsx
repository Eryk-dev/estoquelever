"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  Copy,
  FileCheck,
  Inbox,
  Loader2,
  MapPin,
  Package,
  PackageCheck,
  PackageSearch,
  Printer,
  ShoppingCart,
  Tag,
  UserCheck,
  XCircle,
  AlertCircle,
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

const COMPRA_STATUS_COLORS: Record<string, string> = {
  aguardando_compra: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  comprado: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  recebido: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  indisponivel: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300",
  equivalente_pendente: "bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300",
  cancelamento_pendente: "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  cancelado: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const COMPRA_STATUS_LABELS: Record<string, string> = {
  aguardando_compra: "Ag. Compra",
  comprado: "Comprado",
  recebido: "Recebido",
  indisponivel: "Indisponivel",
  equivalente_pendente: "Equiv. Pendente",
  cancelamento_pendente: "Cancel. Pendente",
  cancelado: "Cancelado",
};

// ─── Timeline config ───────────────────────────────────────────────────────

type EventoColorGroup = "green" | "blue" | "purple" | "red" | "zinc";

const EVENTO_COLOR_MAP: Record<string, EventoColorGroup> = {
  recebido: "green",
  auto_aprovado: "green",
  aprovado: "green",
  nf_autorizada: "green",
  separacao_concluida: "green",
  embalagem_concluida: "green",
  etiqueta_impressa: "green",
  separacao_iniciada: "blue",
  item_separado: "blue",
  embalagem_iniciada: "blue",
  item_embalado: "blue",
  aguardando_nf: "purple",
  aguardando_separacao: "purple",
  aguardando_compra: "purple",
  cancelado: "red",
  erro: "red",
  etiqueta_falhou: "red",
};

const EVENTO_DOT_COLORS: Record<EventoColorGroup, string> = {
  green: "bg-emerald-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  red: "bg-red-500",
  zinc: "bg-zinc-400",
};

const EVENTO_ICON_COLORS: Record<EventoColorGroup, string> = {
  green: "text-emerald-500",
  blue: "text-blue-500",
  purple: "text-purple-500",
  red: "text-red-500",
  zinc: "text-zinc-400",
};

const EVENTO_ICONS: Record<string, typeof Inbox> = {
  recebido: Inbox,
  auto_aprovado: CheckCircle2,
  aprovado: UserCheck,
  nf_autorizada: FileCheck,
  aguardando_nf: FileCheck,
  aguardando_separacao: PackageSearch,
  aguardando_compra: ShoppingCart,
  separacao_iniciada: PackageSearch,
  separacao_concluida: PackageCheck,
  item_separado: PackageCheck,
  embalagem_iniciada: Package,
  embalagem_concluida: PackageCheck,
  item_embalado: PackageCheck,
  etiqueta_impressa: Printer,
  etiqueta_falhou: AlertCircle,
  cancelado: XCircle,
  erro: AlertCircle,
};

const EVENTO_LABELS: Record<string, string> = {
  recebido: "Pedido recebido via webhook",
  auto_aprovado: "Auto-aprovado",
  aprovado: "Aprovado manualmente",
  aguardando_nf: "Aguardando NF",
  nf_autorizada: "NF autorizada",
  aguardando_separacao: "Aguardando separacao",
  aguardando_compra: "Aguardando compra",
  separacao_iniciada: "Separacao iniciada",
  item_separado: "Item separado",
  separacao_concluida: "Separacao concluida",
  embalagem_iniciada: "Embalagem iniciada",
  item_embalado: "Item embalado",
  embalagem_concluida: "Embalagem concluida",
  etiqueta_impressa: "Etiqueta impressa",
  etiqueta_falhou: "Falha na etiqueta",
  cancelado: "Cancelado",
  erro: "Erro no processamento",
};

const FINAL_EVENTS = new Set([
  "etiqueta_impressa",
  "cancelado",
  "erro",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeBetweenEvents(a: string, b: string): string {
  const diff = new Date(b).getTime() - new Date(a).getTime();
  if (diff < 0) return "";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}min`;
  const h = Math.floor(diff / 3600_000);
  const m = Math.round((diff % 3600_000) / 60_000);
  return `${h}h${m > 0 ? `${m}min` : ""}`;
}

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

// ─── Item card ──────────────────────────────────────────────────────────────

function ItemCard({ item }: { item: DetalheItem }) {
  const galpoes = Object.keys(item.estoques).sort();
  const isOC = !!item.fornecedor_oc;

  return (
    <div className="flex items-start gap-3 py-3">
      {/* Thumbnail + quantity badge */}
      <div className="relative shrink-0">
        <div className="h-12 w-12 overflow-hidden rounded-lg border border-line bg-surface">
          {item.imagem_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.imagem_url}
              alt={item.sku}
              className="h-full w-full object-contain"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-zinc-50 dark:bg-zinc-800/50">
              <Package className="h-5 w-5 text-ink-faint" aria-hidden="true" />
            </div>
          )}
        </div>
        <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-900 px-1 font-mono text-[10px] font-bold text-white ring-2 ring-paper dark:bg-zinc-100 dark:text-zinc-900">
          {item.quantidade}
        </span>
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* SKU + description */}
        <div className="flex items-center gap-2">
          <span className="inline-flex shrink-0 items-center rounded-md bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-wide text-white dark:bg-zinc-100 dark:text-zinc-900">
            {item.sku}
          </span>
        </div>
        <span className="min-w-0 truncate text-sm font-medium text-ink" title={item.descricao}>
          {item.descricao}
        </span>

        {/* Stock grid per galpao */}
        {galpoes.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {galpoes.map((galpao) => {
              const est = item.estoques[galpao];
              if (!est) return null;
              return (
                <div
                  key={galpao}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-xs",
                    est.atende
                      ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20"
                      : "border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20",
                  )}
                >
                  <div className="mb-1 flex items-center gap-1">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                      {galpao}
                    </span>
                    {est.atende ? (
                      <span className="rounded bg-emerald-500 px-1 py-px text-[9px] font-bold text-white">OK</span>
                    ) : (
                      <span className="rounded bg-red-500 px-1 py-px text-[9px] font-bold text-white">FALTA</span>
                    )}
                  </div>
                  <div className="flex gap-2 font-mono tabular-nums">
                    <span className="text-ink-faint">
                      S:<span className="font-semibold text-ink">{est.deposito.saldo}</span>
                    </span>
                    <span className="text-ink-faint">
                      R:<span className="font-semibold text-ink">{est.deposito.reservado}</span>
                    </span>
                    <span className="text-ink-faint">
                      D:<span className={cn(
                        "font-semibold",
                        est.atende ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400",
                      )}>{est.deposito.disponivel}</span>
                    </span>
                  </div>
                  {est.localizacao && (
                    <div className="mt-1 flex items-center gap-0.5 text-[10px] text-ink-faint">
                      <MapPin className="h-2.5 w-2.5" />
                      {est.localizacao}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* OC / purchase info */}
        {isOC && (
          <div className="mt-0.5 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200/50 bg-amber-50/30 px-2.5 py-1.5 dark:border-amber-900/30 dark:bg-amber-950/10">
            <ShoppingCart className="h-3 w-3 text-amber-600 dark:text-amber-400" />
            <span className="text-xs font-medium text-ink">
              {item.fornecedor_oc}
            </span>
            {item.compra_status && (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  COMPRA_STATUS_COLORS[item.compra_status] ?? "bg-zinc-100 text-zinc-600",
                )}
              >
                {COMPRA_STATUS_LABELS[item.compra_status] ?? item.compra_status}
              </span>
            )}
            <span className="h-3 w-px bg-amber-300/50 dark:bg-amber-700/50" aria-hidden="true" />
            <span className="font-mono text-[11px] text-ink-faint tabular-nums">
              Solicitado: {item.compra_quantidade_solicitada ?? 0}
              {" | "}Comprado: {item.compra_quantidade_comprada ?? 0}
              {" | "}Recebido: {item.compra_quantidade_recebida ?? 0}
            </span>
          </div>
        )}
      </div>
    </div>
  );
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

        {/* ── Items section ──────────────────────────────────────── */}
        <Section title={`Itens (${pedido.itens.length})`}>
          <div className="divide-y divide-line">
            {pedido.itens.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </Section>

        {/* ── Timeline section ──────────────────────────────────────── */}
        <Section title="Timeline">
          {pedido.historico.length === 0 ? (
            <p className="text-xs text-ink-faint">Nenhum evento registrado.</p>
          ) : (
            <ol className="relative border-l-2 border-zinc-200 dark:border-zinc-700">
              {pedido.historico.map((evt, i) => {
                const colorGroup = EVENTO_COLOR_MAP[evt.evento] ?? "zinc";
                const dotColor = EVENTO_DOT_COLORS[colorGroup];
                const iconColor = EVENTO_ICON_COLORS[colorGroup];
                const Icon = EVENTO_ICONS[evt.evento] ?? Inbox;
                const label = EVENTO_LABELS[evt.evento] ?? evt.evento;
                const elapsed =
                  i > 0
                    ? timeBetweenEvents(pedido.historico[i - 1].criado_em, evt.criado_em)
                    : null;

                return (
                  <li key={evt.id} className="mb-4 ml-5 last:mb-0">
                    {/* Dot on the line */}
                    <div
                      className={cn(
                        "absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-paper",
                        dotColor,
                      )}
                    />

                    <div className="flex items-start gap-2">
                      <Icon
                        className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", iconColor)}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        {/* Label + elapsed */}
                        <div className="flex items-baseline gap-2">
                          <span className="text-xs font-medium text-ink">
                            {label}
                          </span>
                          {elapsed && (
                            <span className="text-[10px] text-ink-faint">
                              +{elapsed}
                            </span>
                          )}
                        </div>

                        {/* Timestamp + user */}
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                          <span
                            title={formatDateTime(evt.criado_em)}
                          >
                            {formatRelativeTime(evt.criado_em)}
                          </span>
                          {evt.usuario_nome && (
                            <>
                              <span className="h-2.5 w-px bg-line" aria-hidden="true" />
                              <span>{evt.usuario_nome}</span>
                            </>
                          )}
                        </div>

                        {/* Details */}
                        {evt.detalhes && Object.keys(evt.detalhes).length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {Object.entries(evt.detalhes).map(([k, v]) => (
                              <span
                                key={k}
                                className="rounded bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-500"
                              >
                                {k}: {String(v)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}

              {/* Waiting indicator if last event is not final */}
              {pedido.historico.length > 0 &&
                !FINAL_EVENTS.has(pedido.historico[pedido.historico.length - 1].evento) && (
                  <li className="ml-5">
                    <div className="absolute -left-[5px] h-2.5 w-2.5 rounded-full bg-zinc-300 ring-2 ring-paper dark:bg-zinc-600" />
                    <div className="flex items-center gap-2 text-xs text-ink-faint">
                      <Clock className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
                      <span>Aguardando proximo passo...</span>
                    </div>
                  </li>
                )}
            </ol>
          )}
        </Section>

        {/* Placeholder for future sections (observacoes, acoes) */}
      </div>
    </AppShell>
  );
}
