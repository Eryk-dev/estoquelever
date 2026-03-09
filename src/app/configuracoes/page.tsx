"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Package,
  PlugZap,
  RefreshCw,
  Shield,
  Unplug,
  Users,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TinyConnection {
  id: string;
  filial: "CWB" | "SP";
  nome_empresa: string;
  cnpj: string;
  ativo: boolean;
  ultimo_teste_em: string | null;
  ultimo_teste_ok: boolean | null;
  criado_em: string;
  atualizado_em: string;
  // OAuth2
  has_client_id: boolean;
  client_id_preview: string | null;
  has_client_secret: boolean;
  is_authorized: boolean;
  token_expires_at: string | null;
  // Deposit selection
  deposito_id: number | null;
  deposito_nome: string | null;
}

interface DepositoOption {
  id: number;
  nome: string;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ConfiguracoesPage() {
  return (
    <Suspense>
      <ConfiguracoesContent />
    </Suspense>
  );
}

function ConfiguracoesContent() {
  const searchParams = useSearchParams();
  const [connections, setConnections] = useState<TinyConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/tiny/connections");
      const data = await res.json();
      setConnections(Array.isArray(data) ? data : []);
    } catch {
      toast.error("Erro ao carregar conexões");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  // Handle OAuth callback messages
  useEffect(() => {
    const success = searchParams.get("oauth_success");
    const error = searchParams.get("oauth_error");
    if (success) {
      toast.success(`Filial ${success} autorizada com sucesso!`);
      // Clean URL
      window.history.replaceState({}, "", "/configuracoes");
      fetchConnections();
    }
    if (error) {
      toast.error(`Erro na autorização: ${error}`);
      window.history.replaceState({}, "", "/configuracoes");
    }
  }, [searchParams, fetchConnections]);

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhook/tiny`
      : "";

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Link>
          <div>
            <h1 className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              Configurações
            </h1>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              Conexões Tiny ERP e Webhook
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {/* ── Gerenciar Usuários ─────────────────────────────────────── */}
        <Link
          href="/admin/usuarios"
          className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-4 transition-colors hover:bg-zinc-50 dark:border-zinc-700/60 dark:bg-zinc-900 dark:hover:bg-zinc-800/60"
        >
          <Users className="h-5 w-5 text-purple-500" />
          <div>
            <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
              Gerenciar Usuários
            </p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Criar, editar cargos e controlar acessos
            </p>
          </div>
        </Link>

        {/* ── Monitoramento ─────────────────────────────────────────── */}
        <Link
          href="/monitoramento"
          className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-4 transition-colors hover:bg-zinc-50 dark:border-zinc-700/60 dark:bg-zinc-900 dark:hover:bg-zinc-800/60"
        >
          <Activity className="h-5 w-5 text-emerald-500" />
          <div>
            <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
              Monitoramento
            </p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Logs, webhooks, erros e saude do sistema
            </p>
          </div>
        </Link>

        {/* ── Webhook URL ──────────────────────────────────────────────── */}
        <WebhookUrlCard url={webhookUrl} />

        {/* ── Tiny Connections ─────────────────────────────────────────── */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <PlugZap className="h-4 w-4 text-zinc-400" />
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
              Conexões Tiny ERP (OAuth2)
            </h2>
          </div>

          <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 dark:bg-amber-950/30">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Para conectar, acesse o Tiny ERP &rarr; Configurações &rarr; Aplicativos &rarr;
              Criar novo aplicativo. Copie o <strong>Client ID</strong> e{" "}
              <strong>Client Secret</strong> e cole abaixo. Depois clique em
              &quot;Autorizar&quot;.
            </p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {connections.map((conn) => (
                <ConnectionCard
                  key={conn.id}
                  connection={conn}
                  onUpdated={fetchConnections}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ─── Webhook URL Card ───────────────────────────────────────────────────────

function WebhookUrlCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("URL copiada!");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700/60 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <Webhook className="h-4 w-4 text-blue-500" />
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          URL do Webhook
        </h2>
      </div>
      <div className="space-y-3 px-4 py-4">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Configure esta URL no Tiny ERP como webhook de{" "}
          <strong>atualização de pedido</strong> para cada conta (NetAir e
          NetParts).
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {url || "..."}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-all",
              copied
                ? "border-emerald-300 bg-emerald-50 text-emerald-600 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                : "border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700",
            )}
            title="Copiar URL"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
        <div className="flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2 dark:bg-blue-950/30">
          <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
          <p className="text-xs text-blue-700 dark:text-blue-300">
            A mesma URL funciona para ambas as filiais. O sistema identifica a
            filial automaticamente pelo CNPJ do webhook.
          </p>
        </div>
      </div>
    </section>
  );
}

// ─── Deposit Selector ───────────────────────────────────────────────────────

function DepositoSelector({
  connection,
  onSaved,
}: {
  connection: TinyConnection;
  onSaved: () => void;
}) {
  const [depositos, setDepositos] = useState<DepositoOption[]>([]);
  const [loadingDepositos, setLoadingDepositos] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(
    connection.deposito_id,
  );
  const [saving, setSaving] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  async function handleLoadDepositos() {
    setLoadingDepositos(true);
    setFetchError(null);
    try {
      const res = await fetch(
        `/api/tiny/deposits?connectionId=${connection.id}`,
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const data: DepositoOption[] = await res.json();
      setDepositos(data);
      setHasFetched(true);
      if (data.length === 0) {
        toast.error("Nenhum depósito encontrado nesta conta Tiny");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao carregar depósitos";
      setFetchError(msg);
      toast.error(msg);
    } finally {
      setLoadingDepositos(false);
    }
  }

  async function handleSaveDeposito() {
    if (selectedId === null) {
      toast.error("Selecione um depósito");
      return;
    }
    const chosen = depositos.find((d) => d.id === selectedId);
    if (!chosen) return;

    setSaving(true);
    try {
      const res = await fetch("/api/tiny/connections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: connection.id,
          deposito_id: chosen.id,
          deposito_nome: chosen.nome,
        }),
      });
      if (!res.ok) throw new Error("Falha ao salvar");
      toast.success(`Depósito "${chosen.nome}" salvo para ${connection.filial}`);
      onSaved();
    } catch {
      toast.error("Erro ao salvar depósito");
    } finally {
      setSaving(false);
    }
  }

  const currentNome =
    connection.deposito_nome ??
    (selectedId !== null
      ? depositos.find((d) => d.id === selectedId)?.nome
      : null);

  return (
    <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
      <div className="flex items-center gap-2 mb-2">
        <Package className="h-3.5 w-3.5 text-zinc-400" />
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          Depósito de estoque
        </span>
        {!connection.deposito_id && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            <AlertTriangle className="h-2.5 w-2.5" />
            Não configurado
          </span>
        )}
        {connection.deposito_id && currentNome && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
            <Check className="h-2.5 w-2.5" />
            {currentNome}
          </span>
        )}
      </div>

      {!hasFetched ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleLoadDepositos}
            disabled={loadingDepositos}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {loadingDepositos ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Carregar depósitos
          </button>
          {fetchError && (
            <span className="text-[11px] text-red-500">{fetchError}</span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {depositos.length > 0 ? (
            <>
              <div className="relative flex-1">
                <select
                  value={selectedId ?? ""}
                  onChange={(e) =>
                    setSelectedId(e.target.value ? Number(e.target.value) : null)
                  }
                  className="w-full appearance-none rounded-lg border border-zinc-200 bg-zinc-50 py-1.5 pl-3 pr-8 text-xs text-zinc-700 outline-none transition-colors focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  <option value="">Selecionar depósito…</option>
                  {depositos.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.nome}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              </div>
              <button
                type="button"
                onClick={handleSaveDeposito}
                disabled={saving || selectedId === null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                Salvar
              </button>
              <button
                type="button"
                onClick={handleLoadDepositos}
                disabled={loadingDepositos}
                className="inline-flex items-center justify-center rounded-lg border border-zinc-200 p-1.5 text-zinc-400 transition-colors hover:bg-zinc-50 hover:text-zinc-600 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
                title="Recarregar lista"
              >
                {loadingDepositos ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400 italic">
                Nenhum depósito disponível
              </span>
              <button
                type="button"
                onClick={handleLoadDepositos}
                disabled={loadingDepositos}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {loadingDepositos ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Tentar novamente
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Connection Card ────────────────────────────────────────────────────────

function ConnectionCard({
  connection,
  onUpdated,
}: {
  connection: TinyConnection;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const isCWB = connection.filial === "CWB";
  const hasCredentials = connection.has_client_id && connection.has_client_secret;

  async function handleSaveCredentials() {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error("Client ID e Client Secret são obrigatórios");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/tiny/connections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: connection.id,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Credenciais ${connection.filial} salvas`);
      setEditing(false);
      setClientId("");
      setClientSecret("");
      onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar credenciais");
    } finally {
      setSaving(false);
    }
  }

  function handleAuthorize() {
    // Redirect to OAuth2 authorization flow
    window.location.href = `/api/tiny/oauth?connectionId=${connection.id}`;
  }

  async function handleTest() {
    if (!connection.is_authorized) {
      toast.error("Autorize a conexão primeiro");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch("/api/tiny/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: connection.id }),
      });
      const result = await res.json();
      if (result.ok) {
        toast.success(`Conexão ${connection.filial} OK: ${result.nome}`);
      } else {
        toast.error(`Falha: ${result.erro}`);
      }
      onUpdated();
    } catch {
      toast.error("Erro ao testar conexão");
    } finally {
      setTesting(false);
    }
  }

  // Status badge
  function StatusBadge() {
    if (connection.is_authorized && connection.ultimo_teste_ok === true) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Conectado
        </span>
      );
    }
    if (connection.is_authorized) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 dark:bg-blue-950/40 dark:text-blue-400">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
          Autorizado
        </span>
      );
    }
    if (hasCredentials) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
          <KeyRound className="h-3 w-3" />
          Aguardando autorização
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        <Unplug className="h-3 w-3" />
        Não configurado
      </span>
    );
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-white",
        "border-zinc-200 dark:border-zinc-700/60 dark:bg-zinc-900",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-lg font-mono text-xs font-bold",
            isCWB
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
              : "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
          )}
        >
          {connection.filial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            {connection.nome_empresa}
          </p>
          <p className="font-mono text-[11px] text-zinc-400">
            CNPJ: {connection.cnpj}
          </p>
        </div>
        <StatusBadge />
      </div>

      {/* Deposit selector — only after authorization */}
      {connection.is_authorized && (
        <DepositoSelector connection={connection} onSaved={onUpdated} />
      )}

      {/* OAuth2 credentials area */}
      <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
        {editing ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Client ID
              </label>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Cole o Client ID do aplicativo Tiny..."
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-700 outline-none transition-colors focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Client Secret
              </label>
              <div className="relative">
                <input
                  type={showSecret ? "text" : "password"}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Cole o Client Secret..."
                  className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 pr-10 font-mono text-sm text-zinc-700 outline-none transition-colors focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600"
                  tabIndex={-1}
                >
                  {showSecret ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSaveCredentials}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Salvar credenciais
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setClientId("");
                  setClientSecret("");
                }}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-500 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Credentials status */}
            <div className="flex items-center gap-2">
              {hasCredentials ? (
                <code className="flex-1 rounded bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  Client ID: {connection.client_id_preview ?? "***"}
                </code>
              ) : (
                <span className="flex-1 text-xs text-zinc-400 italic">
                  Nenhuma credencial OAuth2 configurada
                </span>
              )}
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <KeyRound className="h-3 w-3" />
                {hasCredentials ? "Alterar credenciais" : "Configurar OAuth2"}
              </button>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              {hasCredentials && !connection.is_authorized && (
                <button
                  type="button"
                  onClick={handleAuthorize}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white transition-all hover:bg-blue-500"
                >
                  <ExternalLink className="h-3 w-3" />
                  Autorizar no Tiny
                </button>
              )}
              {connection.is_authorized && (
                <>
                  <button
                    type="button"
                    onClick={handleAuthorize}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Re-autorizar
                  </button>
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {testing ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    Testar conexão
                  </button>
                </>
              )}
              {connection.is_authorized && connection.token_expires_at && (
                <span className="ml-auto text-[10px] text-zinc-400">
                  Token expira:{" "}
                  {new Date(connection.token_expires_at).toLocaleString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    day: "2-digit",
                    month: "2-digit",
                  })}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
