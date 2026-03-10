"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Package,
  Plus,
  PlugZap,
  RefreshCw,
  Shield,
  Unplug,
  Users,
  Warehouse,
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
  has_client_id: boolean;
  client_id_preview: string | null;
  has_client_secret: boolean;
  is_authorized: boolean;
  token_expires_at: string | null;
  deposito_id: number | null;
  deposito_nome: string | null;
}

interface DepositoOption {
  id: number;
  nome: string;
}

interface EmpresaHierarquia {
  id: string;
  nome: string;
  cnpj: string;
  ativo: boolean;
  grupo: { id: string; nome: string } | null;
  tier: number | null;
  grupoEmpresaId: string | null;
  conexao: {
    id: string;
    ativo: boolean;
    conectado: boolean;
    ultimoTesteOk: boolean | null;
    depositoId: number | null;
    depositoNome: string | null;
  } | null;
}

interface GalpaoHierarquia {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  siso_empresas: EmpresaHierarquia[];
}

interface GrupoInfo {
  id: string;
  nome: string;
  descricao: string | null;
  siso_grupo_empresas: Array<{
    id: string;
    tier: number;
    siso_empresas: { id: string; nome: string; cnpj: string };
  }>;
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
  const [galpoes, setGalpoes] = useState<GalpaoHierarquia[]>([]);
  const [grupos, setGrupos] = useState<GrupoInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [connRes, galpRes, grupoRes] = await Promise.all([
        fetch("/api/tiny/connections"),
        fetch("/api/admin/galpoes"),
        fetch("/api/admin/grupos"),
      ]);
      const [connData, galpData, grupoData] = await Promise.all([
        connRes.json(),
        galpRes.json(),
        grupoRes.json(),
      ]);
      setConnections(Array.isArray(connData) ? connData : []);
      setGalpoes(Array.isArray(galpData) ? galpData : []);
      setGrupos(Array.isArray(grupoData) ? grupoData : []);
    } catch {
      toast.error("Erro ao carregar dados");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const success = searchParams.get("oauth_success");
    const error = searchParams.get("oauth_error");
    if (success) {
      toast.success(`Empresa ${success} autorizada com sucesso!`);
      window.history.replaceState({}, "", "/configuracoes");
      fetchAll();
    }
    if (error) {
      toast.error(`Erro na autorização: ${error}`);
      window.history.replaceState({}, "", "/configuracoes");
    }
  }, [searchParams, fetchAll]);

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhook/tiny`
      : "";

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
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
              Galpões, Empresas, Grupos e Conexões Tiny
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {/* ── Links rápidos ───────────────────────────────────────── */}
        <div className="flex gap-3">
          <Link
            href="/admin/usuarios"
            className="flex flex-1 items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-4 transition-colors hover:bg-zinc-50 dark:border-zinc-700/60 dark:bg-zinc-900 dark:hover:bg-zinc-800/60"
          >
            <Users className="h-5 w-5 text-purple-500" />
            <div>
              <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
                Usuários
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">
                Cargos e acessos
              </p>
            </div>
          </Link>
          <Link
            href="/monitoramento"
            className="flex flex-1 items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-4 transition-colors hover:bg-zinc-50 dark:border-zinc-700/60 dark:bg-zinc-900 dark:hover:bg-zinc-800/60"
          >
            <Activity className="h-5 w-5 text-emerald-500" />
            <div>
              <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
                Monitoramento
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">
                Logs e saúde
              </p>
            </div>
          </Link>
        </div>

        {/* ── Webhook URL ──────────────────────────────────────────── */}
        <WebhookUrlCard url={webhookUrl} />

        {/* ── Galpões e Empresas ────────────────────────────────────── */}
        <GalpoesEmpresasSection
          galpoes={galpoes}
          grupos={grupos}
          connections={connections}
          loading={loading}
          onRefresh={fetchAll}
        />

        {/* ── Grupos ────────────────────────────────────────────────── */}
        <GruposSection
          grupos={grupos}
          loading={loading}
          onRefresh={fetchAll}
        />
      </main>
    </div>
  );
}

// ─── Galpões e Empresas Section ─────────────────────────────────────────────

function GalpoesEmpresasSection({
  galpoes,
  grupos: _grupos,
  connections,
  loading,
  onRefresh,
}: {
  galpoes: GalpaoHierarquia[];
  grupos: GrupoInfo[];
  connections: TinyConnection[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [addingGalpao, setAddingGalpao] = useState(false);
  const [newGalpaoNome, setNewGalpaoNome] = useState("");
  const [savingGalpao, setSavingGalpao] = useState(false);

  async function handleAddGalpao() {
    if (!newGalpaoNome.trim()) return;
    setSavingGalpao(true);
    try {
      const res = await fetch("/api/admin/galpoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: newGalpaoNome.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Galpão "${newGalpaoNome}" criado`);
      setNewGalpaoNome("");
      setAddingGalpao(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar galpão");
    } finally {
      setSavingGalpao(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Warehouse className="h-4 w-4 text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          Galpões e Empresas
        </h2>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        </div>
      ) : (
        <div className="space-y-3">
          {galpoes.map((galpao) => (
            <GalpaoCard
              key={galpao.id}
              galpao={galpao}
              connections={connections}
              onRefresh={onRefresh}
            />
          ))}

          {/* Add galpao button */}
          {addingGalpao ? (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900">
              <input
                type="text"
                value={newGalpaoNome}
                onChange={(e) => setNewGalpaoNome(e.target.value)}
                placeholder="Nome do galpão (ex: BH)"
                className="flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleAddGalpao()}
              />
              <button
                onClick={handleAddGalpao}
                disabled={savingGalpao}
                className="inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {savingGalpao ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Criar
              </button>
              <button
                onClick={() => { setAddingGalpao(false); setNewGalpaoNome(""); }}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAddingGalpao(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-3 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-600 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:text-zinc-300"
            >
              <Plus className="h-3.5 w-3.5" />
              Adicionar galpão
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Galpao Card ────────────────────────────────────────────────────────────

function GalpaoCard({
  galpao,
  connections,
  onRefresh,
}: {
  galpao: GalpaoHierarquia;
  connections: TinyConnection[];
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700/60 dark:bg-zinc-900">
      {/* Galpao header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
      >
        <Warehouse className="h-4 w-4 text-indigo-500" />
        <span className="text-sm font-bold text-zinc-800 dark:text-zinc-100">
          {galpao.nome}
        </span>
        {galpao.descricao && (
          <span className="text-xs text-zinc-400">{galpao.descricao}</span>
        )}
        <span className="ml-auto text-[11px] text-zinc-400">
          {galpao.siso_empresas.length} empresa{galpao.siso_empresas.length !== 1 ? "s" : ""}
        </span>
        <ChevronRight
          className={cn(
            "h-4 w-4 text-zinc-400 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-zinc-100 dark:border-zinc-800">
          {galpao.siso_empresas.map((empresa) => {
            const conn = connections.find(
              (c) => c.cnpj === empresa.cnpj,
            );
            return (
              <EmpresaRow
                key={empresa.id}
                empresa={empresa}
                connection={conn ?? null}
                onRefresh={onRefresh}
              />
            );
          })}
          {galpao.siso_empresas.length === 0 && (
            <p className="px-4 py-3 text-xs text-zinc-400 italic">
              Nenhuma empresa neste galpão
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Empresa Row (inside galpao) ────────────────────────────────────────────

function EmpresaRow({
  empresa,
  connection,
  onRefresh,
}: {
  empresa: EmpresaHierarquia;
  connection: TinyConnection | null;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-zinc-50 last:border-b-0 dark:border-zinc-800/50">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50/50 dark:hover:bg-zinc-800/20"
      >
        <Building2 className="h-3.5 w-3.5 text-zinc-400" />
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          {empresa.nome}
        </span>
        <span className="font-mono text-[10px] text-zinc-400">
          {empresa.cnpj}
        </span>

        {/* Grupo + tier badge */}
        {empresa.grupo && (
          <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-semibold text-purple-600 dark:bg-purple-950/40 dark:text-purple-400">
            {empresa.grupo.nome}
            {empresa.tier && <span className="opacity-60">T{empresa.tier}</span>}
          </span>
        )}

        {/* Connection status */}
        {empresa.conexao?.conectado ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Conectado
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-zinc-400">
            <Unplug className="h-2.5 w-2.5" />
            {empresa.conexao ? "Não autorizado" : "Sem conexão"}
          </span>
        )}

        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-zinc-400 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {/* Expanded: show connection card */}
      {expanded && connection && (
        <div className="mx-4 mb-3">
          <ConnectionCard connection={connection} onUpdated={onRefresh} />
        </div>
      )}
      {expanded && !connection && (
        <p className="px-4 pb-3 text-xs text-zinc-400 italic">
          Conexão Tiny não configurada para esta empresa.
        </p>
      )}
    </div>
  );
}

// ─── Grupos Section ─────────────────────────────────────────────────────────

function GruposSection({
  grupos,
  loading,
  onRefresh,
}: {
  grupos: GrupoInfo[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [addingGrupo, setAddingGrupo] = useState(false);
  const [newGrupoNome, setNewGrupoNome] = useState("");
  const [savingGrupo, setSavingGrupo] = useState(false);

  async function handleAddGrupo() {
    if (!newGrupoNome.trim()) return;
    setSavingGrupo(true);
    try {
      const res = await fetch("/api/admin/grupos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: newGrupoNome.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Grupo "${newGrupoNome}" criado`);
      setNewGrupoNome("");
      setAddingGrupo(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar grupo");
    } finally {
      setSavingGrupo(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <PlugZap className="h-4 w-4 text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          Grupos de Empresas
        </h2>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2 dark:bg-blue-950/30">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
        <p className="text-xs text-blue-700 dark:text-blue-300">
          Empresas no mesmo grupo consultam estoque entre si. Empresas sem grupo
          não participam de consultas de suporte.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        </div>
      ) : (
        <div className="space-y-3">
          {grupos.map((grupo) => (
            <div
              key={grupo.id}
              className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700/60 dark:bg-zinc-900"
            >
              <div className="flex items-center gap-2 px-4 py-3">
                <span className="text-sm font-bold text-zinc-800 dark:text-zinc-100">
                  {grupo.nome}
                </span>
                {grupo.descricao && (
                  <span className="text-xs text-zinc-400">{grupo.descricao}</span>
                )}
                <span className="ml-auto text-[11px] text-zinc-400">
                  {grupo.siso_grupo_empresas.length} empresa{grupo.siso_grupo_empresas.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="border-t border-zinc-100 dark:border-zinc-800">
                {grupo.siso_grupo_empresas
                  .sort((a, b) => a.tier - b.tier)
                  .map((ge) => (
                    <div
                      key={ge.id}
                      className="flex items-center gap-2 px-4 py-2 text-sm"
                    >
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-zinc-100 font-mono text-[10px] font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        {ge.tier}
                      </span>
                      <span className="text-zinc-700 dark:text-zinc-200">
                        {ge.siso_empresas.nome}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-400">
                        {ge.siso_empresas.cnpj}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ))}

          {addingGrupo ? (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900">
              <input
                type="text"
                value={newGrupoNome}
                onChange={(e) => setNewGrupoNome(e.target.value)}
                placeholder="Nome do grupo"
                className="flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleAddGrupo()}
              />
              <button
                onClick={handleAddGrupo}
                disabled={savingGrupo}
                className="inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {savingGrupo ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Criar
              </button>
              <button
                onClick={() => { setAddingGrupo(false); setNewGrupoNome(""); }}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAddingGrupo(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-3 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-600 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:text-zinc-300"
            >
              <Plus className="h-3.5 w-3.5" />
              Adicionar grupo
            </button>
          )}
        </div>
      )}
    </section>
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
          <strong>atualização de pedido</strong> para cada empresa.
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
            A mesma URL funciona para todas as empresas. O sistema identifica a
            empresa automaticamente pelo CNPJ do webhook.
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
      toast.success(`Depósito "${chosen.nome}" salvo`);
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
                  <option value="">Selecionar depósito...</option>
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
      toast.success("Credenciais salvas");
      setEditing(false);
      setClientId("");
      setClientSecret("");
      onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  function handleAuthorize() {
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
        toast.success(`Conexão OK: ${result.nome}`);
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
          Aguardando
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
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50">
      <div className="flex items-center gap-3 px-3 py-2">
        <PlugZap className="h-3.5 w-3.5 text-zinc-400" />
        <span className="flex-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
          Conexão Tiny
        </span>
        <StatusBadge />
      </div>

      {connection.is_authorized && (
        <DepositoSelector connection={connection} onSaved={onUpdated} />
      )}

      <div className="border-t border-zinc-200/60 px-3 py-2 dark:border-zinc-700/60">
        {editing ? (
          <div className="space-y-2">
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Client ID"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              autoFocus
            />
            <div className="relative">
              <input
                type={showSecret ? "text" : "password"}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Client Secret"
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 pr-8 font-mono text-xs outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-zinc-400"
                tabIndex={-1}
              >
                {showSecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveCredentials}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Salvar
              </button>
              <button
                onClick={() => { setEditing(false); setClientId(""); setClientSecret(""); }}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {hasCredentials ? (
                <code className="flex-1 rounded bg-white px-2 py-1 font-mono text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {connection.client_id_preview ?? "***"}
                </code>
              ) : (
                <span className="flex-1 text-[11px] text-zinc-400 italic">
                  Sem credenciais OAuth2
                </span>
              )}
              <button
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-white dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <KeyRound className="h-2.5 w-2.5" />
                {hasCredentials ? "Alterar" : "Configurar"}
              </button>
            </div>
            <div className="flex items-center gap-2">
              {hasCredentials && !connection.is_authorized && (
                <button
                  onClick={handleAuthorize}
                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-blue-500"
                >
                  <ExternalLink className="h-2.5 w-2.5" />
                  Autorizar
                </button>
              )}
              {connection.is_authorized && (
                <>
                  <button
                    onClick={handleAuthorize}
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-white dark:border-zinc-600 dark:text-zinc-300"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    Re-autorizar
                  </button>
                  <button
                    onClick={handleTest}
                    disabled={testing}
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-white disabled:opacity-30 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    {testing ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RefreshCw className="h-2.5 w-2.5" />}
                    Testar
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
