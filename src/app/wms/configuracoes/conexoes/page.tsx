"use client";

/**
 * /wms/configuracoes/conexoes
 *
 * Page WMS-styled de conexões & impressoras. Substitui o link antigo que
 * apontava pra /configuracoes (SISO legacy). Acessível só via
 * /wms/configuracoes (admin) — não tem entrada direta no shell.
 *
 * Funcionalidade idêntica à legacy:
 *   - URL do webhook Tiny (display + copiar)
 *   - Conexões OAuth2 Tiny por empresa (client_id / secret / authorize / testar / depósito)
 *   - PrintNode (API key, listar impressoras, atribuir por galpão/usuário)
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { Icon, PageHeader, Card } from "@/components/wms/ui/wms-ui";
import type {
  TinyConnection,
  DepositoOption,
  UsuarioPrintNode,
} from "@/components/configuracoes/types";

interface GalpaoConexao {
  id: string;
  nome: string;
  ativo: boolean;
  printnode_printer_id: number | null;
  printnode_printer_nome: string | null;
  printnode_printer_id_produto: number | null;
  printnode_printer_nome_produto: string | null;
  siso_empresas: Array<{ id: string; nome: string; cnpj: string; ativo: boolean }>;
}

export default function Page() {
  return (
    <Suspense>
      <ConexoesContent />
    </Suspense>
  );
}

function ConexoesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const isAdmin = (user?.cargos ?? [user?.cargo]).includes("admin");

  const [connections, setConnections] = useState<TinyConnection[]>([]);
  const [galpoes, setGalpoes] = useState<GalpaoConexao[]>([]);
  const [usuarios, setUsuarios] = useState<UsuarioPrintNode[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [connRes, galpRes, userRes] = await Promise.all([
        sisoFetch("/api/tiny/connections"),
        sisoFetch("/api/admin/galpoes"),
        sisoFetch("/api/admin/usuarios"),
      ]);
      const [connData, galpData, userData] = await Promise.all([
        connRes.json(),
        galpRes.json(),
        userRes.json(),
      ]);
      setConnections(Array.isArray(connData) ? connData : []);
      setGalpoes(Array.isArray(galpData) ? galpData : []);
      setUsuarios(Array.isArray(userData) ? userData : []);
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
      router.replace("/wms/configuracoes/conexoes");
      fetchAll();
    }
    if (error) {
      toast.error(`Erro na autorização: ${error}`);
      router.replace("/wms/configuracoes/conexoes");
    }
  }, [searchParams, fetchAll, router]);

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhook/tiny`
      : "";

  if (!isAdmin) {
    return (
      <>
        <PageHeader
          title="Conexões & Impressoras"
          backHref="/wms/configuracoes"
          backLabel="Configurações"
        />
        <div className="wms-empty-block">
          <h3>Acesso restrito</h3>
          <p>Apenas administradores podem editar conexões.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Conexões & Impressoras"
        subtitle="Webhook Tiny, OAuth2 por empresa e impressoras PrintNode"
        backHref="/wms/configuracoes"
        backLabel="Configurações"
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <WebhookCard url={webhookUrl} />

        <TinyConnectionsCard
          connections={connections}
          loading={loading}
          onRefresh={fetchAll}
        />

        <PrintNodeCard
          galpoes={galpoes}
          usuarios={usuarios}
          onRefresh={fetchAll}
        />
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Webhook URL
// ─────────────────────────────────────────────────────────────────────────

function WebhookCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("URL copiada");
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card title="URL do Webhook Tiny">
      <p className="wms-td-mute" style={{ fontSize: 12, marginBottom: 8 }}>
        Cadastre esta URL no Tiny como <strong>webhook de atualização de pedido</strong>{" "}
        em cada empresa. A mesma URL serve pra todas — o sistema identifica a
        empresa pelo CNPJ no payload.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <code
          className="wms-input wms-mono"
          style={{
            flex: 1,
            overflowX: "auto",
            whiteSpace: "nowrap",
            cursor: "default",
            background: "var(--wms-c-panel-2)",
          }}
        >
          {url || "…"}
        </code>
        <button
          type="button"
          onClick={copy}
          className="wms-btn wms-btn-ghost"
          title="Copiar URL"
        >
          <Icon name={copied ? "check" : "clipboard"} size={12} />
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Conexões Tiny por empresa
// ─────────────────────────────────────────────────────────────────────────

function TinyConnectionsCard({
  connections,
  loading,
  onRefresh,
}: {
  connections: TinyConnection[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <Card title={`Conexões Tiny (${connections.length})`}>
      {loading ? (
        <div className="wms-loading-pane">Carregando conexões…</div>
      ) : connections.length === 0 ? (
        <p className="wms-td-mute" style={{ fontSize: 12 }}>
          Nenhuma conexão. Cadastre uma empresa primeiro em{" "}
          <a href="/wms/configuracoes" className="wms-btn-link">
            Configurações → Empresas
          </a>
          .
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {connections.map((c) => (
            <ConnectionRow key={c.id} connection={c} onUpdated={onRefresh} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ConnectionRow({
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
  const redirectUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/tiny/oauth/callback`
      : "";

  async function copyRedirect() {
    await navigator.clipboard.writeText(redirectUrl);
    toast.success("URL de redirecionamento copiada");
  }

  async function saveCredentials() {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error("Client ID e Client Secret são obrigatórios");
      return;
    }
    setSaving(true);
    try {
      const r = await sisoFetch("/api/tiny/connections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: connection.id,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      toast.success("Credenciais salvas");
      setEditing(false);
      setClientId("");
      setClientSecret("");
      onUpdated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  function authorize() {
    window.location.href = `/api/tiny/oauth?connectionId=${connection.id}`;
  }

  async function testConn() {
    if (!connection.is_authorized) {
      toast.error("Autorize antes de testar");
      return;
    }
    setTesting(true);
    try {
      const r = await sisoFetch("/api/tiny/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: connection.id }),
      });
      const j = await r.json();
      if (j.ok) toast.success(`Conexão OK: ${j.nome}`);
      else toast.error(`Falha: ${j.erro}`);
      onUpdated();
    } catch {
      toast.error("Erro ao testar");
    } finally {
      setTesting(false);
    }
  }

  const statusLabel = (() => {
    if (connection.is_authorized && connection.ultimo_teste_ok === true)
      return { label: "Conectado", cls: "wms-badge-ok" };
    if (connection.is_authorized)
      return { label: "Autorizado", cls: "wms-badge-info" };
    if (hasCredentials)
      return { label: "Aguardando", cls: "wms-badge-warn" };
    return { label: "Sem credenciais", cls: "wms-badge-mute" };
  })();

  return (
    <div
      style={{
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        background: "var(--wms-c-panel-2)",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 14 }}>{connection.nome_empresa}</strong>
        <span className="wms-mono wms-td-mute" style={{ fontSize: 11 }}>
          {connection.cnpj}
        </span>
        <span className={`wms-badge ${statusLabel.cls}`}>{statusLabel.label}</span>
      </div>

      {connection.is_authorized && (
        <DepositoSelector connection={connection} onSaved={onUpdated} />
      )}

      <div
        style={{
          borderTop: "1px solid var(--wms-c-border)",
          paddingTop: 10,
          marginTop: 10,
        }}
      >
        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              className="wms-input wms-mono"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Client ID"
              autoFocus
            />
            <div style={{ position: "relative" }}>
              <input
                className="wms-input wms-mono"
                type={showSecret ? "text" : "password"}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Client Secret"
                style={{ paddingRight: 30 }}
              />
              <button
                type="button"
                className="wms-btn-icon"
                onClick={() => setShowSecret((v) => !v)}
                style={{
                  position: "absolute",
                  right: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                  border: "none",
                  background: "transparent",
                }}
                title={showSecret ? "Esconder" : "Mostrar"}
              >
                <Icon name={showSecret ? "x" : "search"} size={11} />
              </button>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="wms-btn wms-btn-primary wms-btn-sm"
                onClick={saveCredentials}
                disabled={saving}
              >
                <Icon name="check" size={11} />
                {saving ? "Salvando…" : "Salvar"}
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={() => {
                  setEditing(false);
                  setClientId("");
                  setClientSecret("");
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {hasCredentials ? (
                <code
                  className="wms-mono wms-td-mute"
                  style={{ fontSize: 11 }}
                >
                  {connection.client_id_preview ?? "***"}
                </code>
              ) : (
                <span
                  className="wms-td-mute"
                  style={{ fontSize: 11, fontStyle: "italic" }}
                >
                  Sem credenciais OAuth2
                </span>
              )}
              <button
                type="button"
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={() => setEditing(true)}
                style={{ marginLeft: "auto" }}
              >
                <Icon name="edit" size={11} />
                {hasCredentials ? "Alterar" : "Configurar"}
              </button>
            </div>

            {!connection.is_authorized && hasCredentials && (
              <div
                className="wms-hint-card wms-hint-info"
                style={{ fontSize: 11 }}
              >
                <div style={{ flex: 1 }}>
                  <strong style={{ display: "block", marginBottom: 4 }}>
                    URL de redirecionamento (cadastrar no Tiny)
                  </strong>
                  <code className="wms-mono" style={{ wordBreak: "break-all" }}>
                    {redirectUrl}
                  </code>
                </div>
                <button
                  type="button"
                  className="wms-btn-icon"
                  onClick={copyRedirect}
                  title="Copiar"
                >
                  <Icon name="clipboard" size={11} />
                </button>
              </div>
            )}

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {hasCredentials && !connection.is_authorized && (
                <button
                  type="button"
                  className="wms-btn wms-btn-primary wms-btn-sm"
                  onClick={authorize}
                >
                  <Icon name="arrow-right" size={11} />
                  Autorizar
                </button>
              )}
              {connection.is_authorized && (
                <>
                  <button
                    type="button"
                    className="wms-btn wms-btn-ghost wms-btn-sm"
                    onClick={authorize}
                  >
                    <Icon name="arrow-right" size={11} />
                    Re-autorizar
                  </button>
                  <button
                    type="button"
                    className="wms-btn wms-btn-ghost wms-btn-sm"
                    onClick={testConn}
                    disabled={testing}
                  >
                    <Icon name="rotate" size={11} />
                    {testing ? "Testando…" : "Testar"}
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

function DepositoSelector({
  connection,
  onSaved,
}: {
  connection: TinyConnection;
  onSaved: () => void;
}) {
  const [depositos, setDepositos] = useState<DepositoOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(
    connection.deposito_id,
  );
  const [saving, setSaving] = useState(false);
  const [fetched, setFetched] = useState(false);

  async function loadDepositos() {
    setLoading(true);
    setError(null);
    try {
      const r = await sisoFetch(
        `/api/tiny/deposits?connectionId=${connection.id}`,
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const data: DepositoOption[] = await r.json();
      setDepositos(data);
      setFetched(true);
      if (data.length === 0) {
        toast.error("Nenhum depósito encontrado");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  async function saveDeposito() {
    if (selectedId === null) {
      toast.error("Selecione um depósito");
      return;
    }
    const chosen = depositos.find((d) => d.id === selectedId);
    if (!chosen) return;
    setSaving(true);
    try {
      const r = await sisoFetch("/api/tiny/connections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: connection.id,
          deposito_id: chosen.id,
          deposito_nome: chosen.nome,
        }),
      });
      if (!r.ok) throw new Error("Falha ao salvar");
      toast.success(`Depósito "${chosen.nome}" salvo`);
      onSaved();
    } catch {
      toast.error("Erro ao salvar depósito");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--wms-c-border)",
        paddingTop: 10,
        marginTop: 10,
        marginBottom: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        <span style={{ color: "var(--wms-c-fg-2)" }}>Depósito Tiny</span>
        {connection.deposito_id && connection.deposito_nome ? (
          <span className="wms-badge wms-badge-ok">
            {connection.deposito_nome}
          </span>
        ) : (
          <span className="wms-badge wms-badge-warn">Não configurado</span>
        )}
      </div>

      {!fetched ? (
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={loadDepositos}
          disabled={loading}
        >
          <Icon name="rotate" size={11} />
          {loading ? "Carregando…" : "Carregar depósitos"}
        </button>
      ) : depositos.length > 0 ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            className="wms-select"
            value={selectedId ?? ""}
            onChange={(e) =>
              setSelectedId(e.target.value ? Number(e.target.value) : null)
            }
            style={{ flex: 1 }}
          >
            <option value="">Selecionar…</option>
            {depositos.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nome}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="wms-btn wms-btn-primary wms-btn-sm"
            onClick={saveDeposito}
            disabled={saving || selectedId === null}
          >
            <Icon name="check" size={11} />
            Salvar
          </button>
          <button
            type="button"
            className="wms-btn-icon"
            onClick={loadDepositos}
            disabled={loading}
            title="Recarregar"
          >
            <Icon name="rotate" size={11} />
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span
            className="wms-td-mute"
            style={{ fontSize: 11, fontStyle: "italic" }}
          >
            Nenhum depósito disponível.
          </span>
          <button
            type="button"
            className="wms-btn wms-btn-ghost wms-btn-sm"
            onClick={loadDepositos}
            disabled={loading}
          >
            <Icon name="rotate" size={11} />
            Tentar novamente
          </button>
        </div>
      )}
      {error && (
        <p style={{ color: "var(--wms-c-danger)", fontSize: 11, marginTop: 4 }}>
          {error}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// PrintNode
// ─────────────────────────────────────────────────────────────────────────

interface PrintNodePrinter {
  id: number;
  name: string;
  computer: string;
  state: string;
}

function PrintNodeCard({
  galpoes,
  usuarios,
  onRefresh,
}: {
  galpoes: GalpaoConexao[];
  usuarios: UsuarioPrintNode[];
  onRefresh: () => void;
}) {
  const { user } = useAuth();

  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [loadingKey, setLoadingKey] = useState(true);

  const [testing, setTesting] = useState(false);
  const [connStatus, setConnStatus] = useState<{
    ok: boolean;
    email?: string;
    error?: string;
  } | null>(null);

  const [printers, setPrinters] = useState<PrintNodePrinter[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchKeyStatus = useCallback(async () => {
    if (!user) return;
    try {
      const r = await sisoFetch("/api/admin/printnode/api-key", {
        headers: { "x-siso-user-id": user.id },
      });
      if (r.ok) {
        const data = await r.json();
        setApiKeyConfigured(data.configured);
        setApiKeyMasked(data.masked);
      }
    } catch {
      // silent
    } finally {
      setLoadingKey(false);
    }
  }, [user]);

  useEffect(() => {
    fetchKeyStatus();
  }, [fetchKeyStatus]);

  async function saveApiKey() {
    if (!apiKeyInput.trim() || !user) return;
    setSavingKey(true);
    try {
      const r = await sisoFetch("/api/admin/printnode/api-key", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-siso-user-id": user.id,
        },
        body: JSON.stringify({ api_key: apiKeyInput.trim() }),
      });
      if (!r.ok) throw new Error("Erro ao salvar");
      const key = apiKeyInput.trim();
      const masked =
        key.length > 4
          ? "•".repeat(key.length - 4) + key.slice(-4)
          : "•".repeat(key.length);
      setApiKeyConfigured(true);
      setApiKeyMasked(masked);
      setApiKeyInput("");
      setShowApiKey(false);
      setConnStatus(null);
      setPrinters([]);
      toast.success("API Key salva");
    } catch {
      toast.error("Erro ao salvar API Key");
    } finally {
      setSavingKey(false);
    }
  }

  async function deleteApiKey() {
    if (!user) return;
    if (!confirm("Remover a API Key do PrintNode?")) return;
    try {
      await sisoFetch("/api/admin/printnode/api-key", {
        method: "DELETE",
        headers: { "x-siso-user-id": user.id },
      });
      setApiKeyConfigured(false);
      setApiKeyMasked(null);
      setConnStatus(null);
      setPrinters([]);
      toast.success("API Key removida");
    } catch {
      toast.error("Erro ao remover");
    }
  }

  async function testConnection() {
    if (!user) return;
    setTesting(true);
    setConnStatus(null);
    try {
      const r = await sisoFetch("/api/admin/printnode/test", {
        method: "POST",
        headers: { "x-siso-user-id": user.id },
      });
      const data = await r.json();
      if (!r.ok) {
        setConnStatus({ ok: false, error: data.error ?? `HTTP ${r.status}` });
        return;
      }
      setConnStatus(data);
      if (data.ok) await fetchPrinters();
    } catch (e) {
      setConnStatus({
        ok: false,
        error: e instanceof Error ? e.message : "Erro de rede",
      });
    } finally {
      setTesting(false);
    }
  }

  async function fetchPrinters() {
    if (!user) return;
    setLoadingPrinters(true);
    try {
      const r = await sisoFetch("/api/admin/printnode/printers", {
        headers: { "x-siso-user-id": user.id },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setPrinters(Array.isArray(data) ? data : []);
    } catch {
      toast.error("Erro ao listar impressoras");
    } finally {
      setLoadingPrinters(false);
    }
  }

  async function patchGalpao(
    galpaoId: string,
    key: string,
    body: Record<string, unknown>,
  ) {
    setSavingId(key);
    try {
      const r = await sisoFetch(`/api/admin/galpoes/${galpaoId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success("Impressora atualizada");
      onRefresh();
    } catch {
      toast.error("Erro ao salvar");
    } finally {
      setSavingId(null);
    }
  }

  async function patchUsuario(key: string, body: Record<string, unknown>) {
    setSavingId(key);
    try {
      const r = await sisoFetch("/api/admin/usuarios", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success("Impressora atualizada");
      onRefresh();
    } catch {
      toast.error("Erro ao salvar");
    } finally {
      setSavingId(null);
    }
  }

  const hasPrinters = printers.length > 0;
  const galpoesSemImpressora = galpoes.filter(
    (g) => g.ativo && !g.printnode_printer_id,
  );

  return (
    <Card title="PrintNode (impressão térmica)">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* API Key */}
        <div>
          <h4 className="wms-sec-h" style={{ marginTop: 0, fontSize: 12 }}>
            API Key
          </h4>
          {loadingKey ? (
            <span className="wms-td-mute" style={{ fontSize: 12 }}>
              Carregando…
            </span>
          ) : apiKeyConfigured ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <code
                className="wms-input wms-mono"
                style={{ flex: "0 0 auto", maxWidth: 280 }}
              >
                {apiKeyMasked} <Icon name="check" size={10} />
              </code>
              <button
                type="button"
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={() => setApiKeyConfigured(false)}
              >
                Alterar
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={deleteApiKey}
                title="Remover"
              >
                <Icon name="trash" size={11} />
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <div style={{ position: "relative", flex: "0 0 auto", maxWidth: 320 }}>
                <input
                  className="wms-input wms-mono"
                  type={showApiKey ? "text" : "password"}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="Cole a API Key do PrintNode"
                  onKeyDown={(e) => e.key === "Enter" && saveApiKey()}
                  style={{ paddingRight: 30, width: 320 }}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  className="wms-btn-icon"
                  style={{
                    position: "absolute",
                    right: 4,
                    top: "50%",
                    transform: "translateY(-50%)",
                    border: "none",
                    background: "transparent",
                  }}
                >
                  <Icon name={showApiKey ? "x" : "search"} size={11} />
                </button>
              </div>
              <button
                type="button"
                className="wms-btn wms-btn-primary wms-btn-sm"
                onClick={saveApiKey}
                disabled={savingKey || !apiKeyInput.trim()}
              >
                {savingKey ? "Salvando…" : "Salvar"}
              </button>
            </div>
          )}
        </div>

        {/* Test connection */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="wms-btn wms-btn-primary wms-btn-sm"
            onClick={testConnection}
            disabled={testing || (!apiKeyConfigured && !apiKeyInput.trim())}
          >
            <Icon name="rotate" size={11} />
            {testing ? "Testando…" : "Testar conexão"}
          </button>
          {connStatus && (
            <span style={{ fontSize: 12 }}>
              {connStatus.ok ? (
                <span style={{ color: "var(--wms-c-success, #047857)" }}>
                  <Icon name="check" size={11} /> Conectado ({connStatus.email})
                </span>
              ) : (
                <span style={{ color: "var(--wms-c-danger)" }}>
                  <Icon name="alert" size={11} /> {connStatus.error}
                </span>
              )}
            </span>
          )}
        </div>

        {loadingPrinters && (
          <span className="wms-td-mute" style={{ fontSize: 12 }}>
            Carregando impressoras…
          </span>
        )}

        {/* Impressoras por galpão */}
        {hasPrinters && (
          <div>
            <h4 className="wms-sec-h" style={{ marginTop: 0, fontSize: 12 }}>
              Impressora padrão por galpão
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {galpoes
                .filter((g) => g.ativo)
                .map((g) => (
                  <div
                    key={g.id}
                    style={{
                      border: "1px solid var(--wms-c-border)",
                      borderRadius: "var(--wms-r-3)",
                      padding: 10,
                      background: "var(--wms-c-panel-2)",
                    }}
                  >
                    <strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
                      {g.nome}
                    </strong>
                    <PrinterRow
                      label="Envio"
                      printers={printers}
                      value={g.printnode_printer_id}
                      saving={savingId === `g-envio-${g.id}`}
                      onChange={(printerId) => {
                        const p = printers.find((x) => x.id === printerId);
                        patchGalpao(g.id, `g-envio-${g.id}`, {
                          printnode_printer_id: printerId,
                          printnode_printer_nome: p?.name ?? null,
                        });
                      }}
                    />
                    <PrinterRow
                      label="Produto"
                      hint="Cai pra impressora de envio se vazio"
                      printers={printers}
                      value={g.printnode_printer_id_produto}
                      saving={savingId === `g-prod-${g.id}`}
                      onChange={(printerId) => {
                        const p = printers.find((x) => x.id === printerId);
                        patchGalpao(g.id, `g-prod-${g.id}`, {
                          printnode_printer_id_produto: printerId,
                          printnode_printer_nome_produto: p?.name ?? null,
                        });
                      }}
                      emptyLabel="Mesma de envio (fallback)"
                    />
                  </div>
                ))}
            </div>
            {galpoesSemImpressora.length > 0 && (
              <div className="wms-hint-card wms-hint-warn" style={{ marginTop: 8 }}>
                <Icon name="alert" />
                <span>
                  {galpoesSemImpressora.length === 1
                    ? `Galpão ${galpoesSemImpressora[0].nome} sem impressora de envio configurada.`
                    : `${galpoesSemImpressora.length} galpões sem impressora de envio configurada.`}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Override por usuário */}
        {hasPrinters && usuarios.length > 0 && (
          <div>
            <h4 className="wms-sec-h" style={{ marginTop: 0, fontSize: 12 }}>
              Override por usuário (opcional)
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {usuarios.map((u) => (
                <div
                  key={u.id}
                  style={{
                    border: "1px solid var(--wms-c-border)",
                    borderRadius: "var(--wms-r-3)",
                    padding: 10,
                    background: "var(--wms-c-panel-2)",
                  }}
                >
                  <strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
                    {u.nome}
                  </strong>
                  <PrinterRow
                    label="Envio"
                    printers={printers}
                    value={u.printnode_printer_id}
                    saving={savingId === `u-envio-${u.id}`}
                    onChange={(printerId) => {
                      const p = printers.find((x) => x.id === printerId);
                      patchUsuario(`u-envio-${u.id}`, {
                        id: u.id,
                        printnode_printer_id: printerId,
                        printnode_printer_nome: p?.name ?? null,
                      });
                    }}
                    emptyLabel="Nenhuma (usa padrão do galpão)"
                  />
                  <PrinterRow
                    label="Produto"
                    printers={printers}
                    value={u.printnode_printer_id_produto}
                    saving={savingId === `u-prod-${u.id}`}
                    onChange={(printerId) => {
                      const p = printers.find((x) => x.id === printerId);
                      patchUsuario(`u-prod-${u.id}`, {
                        id: u.id,
                        printnode_printer_id_produto: printerId,
                        printnode_printer_nome_produto: p?.name ?? null,
                      });
                    }}
                    emptyLabel="Nenhuma (usa padrão do galpão)"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {!hasPrinters && !loadingPrinters && !connStatus && apiKeyConfigured && (
          <p className="wms-td-mute" style={{ fontSize: 12 }}>
            Teste a conexão para listar as impressoras disponíveis.
          </p>
        )}
      </div>
    </Card>
  );
}

function PrinterRow({
  label,
  hint,
  printers,
  value,
  saving,
  onChange,
  emptyLabel = "Nenhuma",
}: {
  label: string;
  hint?: string;
  printers: PrintNodePrinter[];
  value: number | null;
  saving: boolean;
  onChange: (printerId: number | null) => void;
  emptyLabel?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 4,
      }}
    >
      <span
        title={hint}
        className="wms-td-mute"
        style={{ width: 72, fontSize: 11, flexShrink: 0 }}
      >
        {label}
      </span>
      <select
        className="wms-select"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        disabled={saving}
        style={{ flex: 1 }}
      >
        <option value="">{emptyLabel}</option>
        {printers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.computer})
          </option>
        ))}
      </select>
      {saving && (
        <span className="wms-td-mute" style={{ fontSize: 10 }}>
          …
        </span>
      )}
    </div>
  );
}
