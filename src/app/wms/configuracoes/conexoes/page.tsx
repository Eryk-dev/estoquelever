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
} from "@/components/wms/configuracoes-types";

interface GalpaoConexao {
  id: string;
  nome: string;
  ativo: boolean;
  printnode_printer_id: number | null;
  printnode_printer_nome: string | null;
  printnode_account_id: string | null;
  printnode_printer_id_produto: number | null;
  printnode_printer_nome_produto: string | null;
  printnode_account_id_produto: string | null;
  siso_empresas: Array<{ id: string; nome: string; cnpj: string; ativo: boolean }>;
}

interface EmpresaLite {
  id: string;
  nome: string;
  cnpj: string;
  ativo: boolean;
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
  const [empresas, setEmpresas] = useState<EmpresaLite[]>([]);
  const [galpoes, setGalpoes] = useState<GalpaoConexao[]>([]);
  const [usuarios, setUsuarios] = useState<UsuarioPrintNode[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [connRes, empRes, galpRes, userRes] = await Promise.all([
        sisoFetch("/api/wms/tiny/connections"),
        sisoFetch("/api/wms/admin/empresas"),
        sisoFetch("/api/wms/admin/galpoes"),
        sisoFetch("/api/wms/admin/usuarios"),
      ]);
      const [connData, empData, galpData, userData] = await Promise.all([
        connRes.json(),
        empRes.json(),
        galpRes.json(),
        userRes.json(),
      ]);
      setConnections(Array.isArray(connData) ? connData : []);
      setEmpresas(Array.isArray(empData) ? empData : []);
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
    const mlSuccess = searchParams.get("ml_success");
    const mlError = searchParams.get("ml_error");
    if (success) {
      toast.success(`Empresa ${success} autorizada com sucesso!`);
      router.replace("/wms/configuracoes/conexoes");
      fetchAll();
    }
    if (error) {
      toast.error(`Erro na autorização: ${error}`);
      router.replace("/wms/configuracoes/conexoes");
    }
    if (mlSuccess) {
      toast.success(`Conta Mercado Livre "${mlSuccess}" conectada`);
      router.replace("/wms/configuracoes/conexoes");
      fetchAll();
    }
    if (mlError) {
      toast.error(`Erro Mercado Livre: ${mlError}`);
      router.replace("/wms/configuracoes/conexoes");
    }
  }, [searchParams, fetchAll, router]);

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/wms/webhook/tiny`
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
          empresas={empresas}
          loading={loading}
          onRefresh={fetchAll}
        />

        <MercadoLivreCard />

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
  empresas,
  loading,
  onRefresh,
}: {
  connections: TinyConnection[];
  empresas: EmpresaLite[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const cnpjsConectados = new Set(connections.map((c) => c.cnpj));
  const empresasOrfas = empresas.filter(
    (e) =>
      e.ativo &&
      e.cnpj !== "00000000000000" &&
      !cnpjsConectados.has(e.cnpj),
  );

  return (
    <Card title={`Conexões Tiny (${connections.length})`}>
      {loading ? (
        <div className="wms-loading-pane">Carregando conexões…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {connections.length === 0 ? (
            <p className="wms-td-mute" style={{ fontSize: 12 }}>
              Nenhuma conexão. Cadastre uma empresa primeiro em{" "}
              <a href="/wms/configuracoes" className="wms-btn-link">
                Configurações → Empresas
              </a>
              .
            </p>
          ) : (
            connections.map((c) => (
              <ConnectionRow key={c.id} connection={c} onUpdated={onRefresh} />
            ))
          )}

          <ConectarTinyButton
            empresasOrfas={empresasOrfas}
            onConnected={onRefresh}
          />
        </div>
      )}
    </Card>
  );
}

function ConectarTinyButton({
  empresasOrfas,
  onConnected,
}: {
  empresasOrfas: EmpresaLite[];
  onConnected: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [empresaId, setEmpresaId] = useState("");
  const [saving, setSaving] = useState(false);

  async function conectar() {
    if (!empresaId) {
      toast.error("Selecione uma empresa");
      return;
    }
    setSaving(true);
    try {
      const r = await sisoFetch("/api/wms/tiny/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empresa_id: empresaId }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      toast.success("Conexão Tiny criada — agora preencha as credenciais");
      setOpen(false);
      setEmpresaId("");
      onConnected();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao criar conexão");
    } finally {
      setSaving(false);
    }
  }

  if (empresasOrfas.length === 0) {
    return (
      <p
        className="wms-td-mute"
        style={{ fontSize: 11, fontStyle: "italic", marginTop: 4 }}
      >
        Todas as empresas ativas já têm conexão Tiny. Cadastre uma nova em{" "}
        <a href="/wms/configuracoes" className="wms-btn-link">
          Configurações → Empresas
        </a>
        .
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="wms-btn wms-btn-ghost wms-btn-sm"
        onClick={() => setOpen(true)}
        style={{ alignSelf: "flex-start" }}
      >
        <Icon name="plus" size={11} />
        Conectar Tiny ({empresasOrfas.length} empresa
        {empresasOrfas.length > 1 ? "s" : ""} sem conexão)
      </button>
    );
  }

  return (
    <div
      style={{
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        background: "var(--wms-c-panel-2)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <span className="wms-td-mute" style={{ fontSize: 11 }}>
        Empresa pra conectar Tiny:
      </span>
      <select
        className="wms-select"
        value={empresaId}
        onChange={(e) => setEmpresaId(e.target.value)}
        autoFocus
      >
        <option value="">Selecionar…</option>
        {empresasOrfas.map((e) => (
          <option key={e.id} value={e.id}>
            {e.nome} — {e.cnpj}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="wms-btn wms-btn-primary wms-btn-sm"
          onClick={conectar}
          disabled={saving || !empresaId}
        >
          <Icon name="check" size={11} />
          {saving ? "Criando…" : "Criar conexão"}
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={() => {
            setOpen(false);
            setEmpresaId("");
          }}
        >
          Cancelar
        </button>
      </div>
    </div>
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
      ? `${window.location.origin}/api/wms/tiny/oauth/callback`
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
      const r = await sisoFetch("/api/wms/tiny/connections", {
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
    window.location.href = `/api/wms/tiny/oauth?connectionId=${connection.id}`;
  }

  async function testConn() {
    if (!connection.is_authorized) {
      toast.error("Autorize antes de testar");
      return;
    }
    setTesting(true);
    try {
      const r = await sisoFetch("/api/wms/tiny/test-connection", {
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
    // token_status='erro' = última renovação OAuth falhou (refresh_token
    // morto) — sobrepõe qualquer teste antigo bem-sucedido.
    if (connection.is_authorized && connection.token_status === "erro")
      return { label: "Token expirado — re-autorizar", cls: "wms-badge-danger" };
    if (connection.is_authorized && connection.ultimo_teste_ok === true)
      return { label: "Conectado", cls: "wms-badge-ok" };
    if (connection.is_authorized)
      return { label: "Autorizado", cls: "wms-badge-info" };
    if (hasCredentials)
      return { label: "Aguardando", cls: "wms-badge-warn" };
    return { label: "Sem credenciais", cls: "wms-badge-mute" };
  })();

  const tokenInfo = (() => {
    if (!connection.is_authorized) return null;
    if (connection.token_status === "erro") {
      return { texto: connection.token_erro ?? "Falha na renovação do token", erro: true };
    }
    if (connection.token_renovado_em) {
      return {
        texto: `Token renovado em ${new Date(connection.token_renovado_em).toLocaleString("pt-BR")}`,
        erro: false,
      };
    }
    return null;
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

      {tokenInfo && (
        <div
          className={tokenInfo.erro ? "" : "wms-td-mute"}
          style={{
            fontSize: 11,
            marginBottom: 8,
            ...(tokenInfo.erro ? { color: "var(--wms-c-danger)" } : {}),
          }}
        >
          {tokenInfo.texto}
        </div>
      )}

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
        `/api/wms/tiny/deposits?connectionId=${connection.id}`,
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
      const r = await sisoFetch("/api/wms/tiny/connections", {
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

interface PrintNodeContaResumo {
  id: string;
  label: string;
  ativo: boolean;
  masked: string;
  criado_em: string;
  atualizado_em: string;
}

interface PrinterGroup {
  accountId: string;
  accountLabel: string;
  printers: PrintNodePrinter[];
  error: string | null;
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

  const [contas, setContas] = useState<PrintNodeContaResumo[]>([]);
  const [loadingContas, setLoadingContas] = useState(true);
  const [printerGroups, setPrinterGroups] = useState<PrinterGroup[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchContas = useCallback(async () => {
    if (!user) return;
    setLoadingContas(true);
    try {
      const r = await sisoFetch("/api/wms/admin/printnode/contas", {
        headers: { "x-siso-user-id": user.id },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setContas(Array.isArray(data) ? data : []);
    } catch {
      // silent
    } finally {
      setLoadingContas(false);
    }
  }, [user]);

  const fetchPrinters = useCallback(async () => {
    if (!user) return;
    setLoadingPrinters(true);
    try {
      const r = await sisoFetch("/api/wms/admin/printnode/printers", {
        headers: { "x-siso-user-id": user.id },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setPrinterGroups(Array.isArray(data) ? data : []);
    } catch {
      toast.error("Erro ao listar impressoras");
    } finally {
      setLoadingPrinters(false);
    }
  }, [user]);

  useEffect(() => {
    fetchContas();
  }, [fetchContas]);

  // Quando muda a lista de contas ativas, recarrega o pool de impressoras.
  useEffect(() => {
    if (contas.some((c) => c.ativo)) fetchPrinters();
    else setPrinterGroups([]);
  }, [contas, fetchPrinters]);

  async function patchGalpao(
    galpaoId: string,
    key: string,
    body: Record<string, unknown>,
  ) {
    setSavingId(key);
    try {
      const r = await sisoFetch(`/api/wms/admin/galpoes/${galpaoId}`, {
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
      const r = await sisoFetch("/api/wms/admin/usuarios", {
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

  const hasPrinters = printerGroups.some((g) => g.printers.length > 0);
  const galpoesSemImpressora = galpoes.filter(
    (g) => g.ativo && !g.printnode_printer_id,
  );
  const hasAnyAccount = contas.length > 0;

  return (
    <Card title={`PrintNode${contas.length > 0 ? ` (${contas.length} conta${contas.length > 1 ? "s" : ""})` : ""}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Contas */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <h4 className="wms-sec-h" style={{ margin: 0, fontSize: 12 }}>
              Contas (API keys)
            </h4>
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              cada conta carrega seu próprio conjunto de impressoras
            </span>
          </div>

          {loadingContas ? (
            <span className="wms-td-mute" style={{ fontSize: 12 }}>
              Carregando…
            </span>
          ) : (
            <ContasList
              contas={contas}
              onChanged={fetchContas}
              onReloadPrinters={fetchPrinters}
            />
          )}
        </div>

        {/* Impressoras agregadas */}
        {hasAnyAccount && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h4 className="wms-sec-h" style={{ margin: 0, fontSize: 12 }}>
                Impressoras disponíveis
              </h4>
              <button
                type="button"
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={fetchPrinters}
                disabled={loadingPrinters}
              >
                <Icon name="rotate" size={11} />
                {loadingPrinters ? "Recarregando…" : "Recarregar"}
              </button>
            </div>
            {printerGroups
              .filter((g) => g.error)
              .map((g) => (
                <div
                  key={`err-${g.accountId}`}
                  className="wms-hint-card wms-hint-warn"
                  style={{ fontSize: 11 }}
                >
                  <Icon name="alert" />
                  <span>
                    <strong>{g.accountLabel}:</strong> {g.error}
                  </span>
                </div>
              ))}
            {hasPrinters && (
              <span className="wms-td-mute" style={{ fontSize: 11 }}>
                {printerGroups.reduce((sum, g) => sum + g.printers.length, 0)} impressoras
                em {printerGroups.filter((g) => g.printers.length > 0).length} conta
                {printerGroups.filter((g) => g.printers.length > 0).length > 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}

        {/* Impressora padrão por galpão */}
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
                      groups={printerGroups}
                      value={g.printnode_printer_id}
                      saving={savingId === `g-envio-${g.id}`}
                      onChange={(picked) => {
                        patchGalpao(g.id, `g-envio-${g.id}`, {
                          printnode_printer_id: picked?.printer.id ?? null,
                          printnode_printer_nome: picked?.printer.name ?? null,
                          printnode_account_id: picked?.accountId ?? null,
                        });
                      }}
                    />
                    <PrinterRow
                      label="Produto"
                      hint="Cai pra impressora de envio se vazio"
                      groups={printerGroups}
                      value={g.printnode_printer_id_produto}
                      saving={savingId === `g-prod-${g.id}`}
                      onChange={(picked) => {
                        patchGalpao(g.id, `g-prod-${g.id}`, {
                          printnode_printer_id_produto: picked?.printer.id ?? null,
                          printnode_printer_nome_produto: picked?.printer.name ?? null,
                          printnode_account_id_produto: picked?.accountId ?? null,
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
                    groups={printerGroups}
                    value={u.printnode_printer_id}
                    saving={savingId === `u-envio-${u.id}`}
                    onChange={(picked) => {
                      patchUsuario(`u-envio-${u.id}`, {
                        id: u.id,
                        printnode_printer_id: picked?.printer.id ?? null,
                        printnode_printer_nome: picked?.printer.name ?? null,
                        printnode_account_id: picked?.accountId ?? null,
                      });
                    }}
                    emptyLabel="Nenhuma (usa padrão do galpão)"
                  />
                  <PrinterRow
                    label="Produto"
                    groups={printerGroups}
                    value={u.printnode_printer_id_produto}
                    saving={savingId === `u-prod-${u.id}`}
                    onChange={(picked) => {
                      patchUsuario(`u-prod-${u.id}`, {
                        id: u.id,
                        printnode_printer_id_produto: picked?.printer.id ?? null,
                        printnode_printer_nome_produto: picked?.printer.name ?? null,
                        printnode_account_id_produto: picked?.accountId ?? null,
                      });
                    }}
                    emptyLabel="Nenhuma (usa padrão do galpão)"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {!hasPrinters && !loadingPrinters && hasAnyAccount && (
          <p className="wms-td-mute" style={{ fontSize: 12 }}>
            Nenhuma impressora encontrada nas contas ativas. Verifique se o PrintNode
            Client está rodando nos computadores e as impressoras aparecem em{" "}
            <a
              href="https://app.printnode.com/account/printers"
              target="_blank"
              rel="noreferrer"
              className="wms-btn-link"
            >
              app.printnode.com
            </a>
            .
          </p>
        )}
      </div>
    </Card>
  );
}

function ContasList({
  contas,
  onChanged,
  onReloadPrinters,
}: {
  contas: PrintNodeContaResumo[];
  onChanged: () => void;
  onReloadPrinters: () => void;
}) {
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {contas.map((c) => (
        <ContaRow
          key={c.id}
          conta={c}
          onChanged={() => {
            onChanged();
            onReloadPrinters();
          }}
        />
      ))}

      {creating ? (
        <ContaForm
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            onChanged();
            onReloadPrinters();
          }}
        />
      ) : (
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={() => setCreating(true)}
          disabled={!user}
          style={{ alignSelf: "flex-start" }}
        >
          <Icon name="plus" size={11} />
          Adicionar conta PrintNode
        </button>
      )}
    </div>
  );
}

function ContaForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: { id: string; label: string };
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; email?: string; error?: string } | null>(null);

  async function test() {
    if (!user || !apiKey.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Quando é criação, ainda não tem id — usa rota de teste passando key no body.
      // Quando é edição, usa o id da conta existente (testa a key DIGITADA, não a salva).
      const url = initial
        ? `/api/wms/admin/printnode/contas/${initial.id}/test`
        : `/api/wms/admin/printnode/contas/${"00000000-0000-0000-0000-000000000000"}/test`;
      const r = await sisoFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-siso-user-id": user.id },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });
      const data = await r.json();
      setTestResult(r.ok ? data : { ok: false, error: data.error ?? `HTTP ${r.status}` });
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "Erro de rede" });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!user || !label.trim()) return;
    if (!initial && !apiKey.trim()) {
      toast.error("API key é obrigatória");
      return;
    }
    setSaving(true);
    try {
      const r = initial
        ? await sisoFetch(`/api/wms/admin/printnode/contas/${initial.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-siso-user-id": user.id },
            body: JSON.stringify({
              label: label.trim(),
              ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
            }),
          })
        : await sisoFetch("/api/wms/admin/printnode/contas", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-siso-user-id": user.id },
            body: JSON.stringify({ label: label.trim(), api_key: apiKey.trim() }),
          });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      toast.success(initial ? "Conta atualizada" : "Conta criada");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        padding: 10,
        background: "var(--wms-c-panel-2)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <input
        className="wms-input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Nome da conta (ex: PrintNode CWB)"
        autoFocus
      />
      <div style={{ position: "relative" }}>
        <input
          className="wms-input wms-mono"
          type={showKey ? "text" : "password"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={initial ? "Deixe vazio pra manter a key atual" : "API key do PrintNode"}
          style={{ paddingRight: 30 }}
        />
        <button
          type="button"
          className="wms-btn-icon"
          onClick={() => setShowKey((v) => !v)}
          style={{
            position: "absolute",
            right: 4,
            top: "50%",
            transform: "translateY(-50%)",
            border: "none",
            background: "transparent",
          }}
        >
          <Icon name={showKey ? "x" : "search"} size={11} />
        </button>
      </div>
      {testResult && (
        <div style={{ fontSize: 11 }}>
          {testResult.ok ? (
            <span style={{ color: "var(--wms-c-success, #047857)" }}>
              <Icon name="check" size={11} /> Conectado ({testResult.email})
            </span>
          ) : (
            <span style={{ color: "var(--wms-c-danger)" }}>
              <Icon name="alert" size={11} /> {testResult.error}
            </span>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className="wms-btn wms-btn-primary wms-btn-sm"
          onClick={save}
          disabled={saving || !label.trim() || (!initial && !apiKey.trim())}
        >
          <Icon name="check" size={11} />
          {saving ? "Salvando…" : initial ? "Salvar" : "Criar"}
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={test}
          disabled={testing || !apiKey.trim()}
          title="Testa a key digitada (não salva ainda)"
        >
          <Icon name="rotate" size={11} />
          {testing ? "Testando…" : "Testar key"}
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={onCancel}
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

function ContaRow({
  conta,
  onChanged,
}: {
  conta: PrintNodeContaResumo;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; email?: string; error?: string } | null>(null);

  async function toggleAtivo() {
    if (!user) return;
    setBusy(true);
    try {
      const r = await sisoFetch(`/api/wms/admin/printnode/contas/${conta.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-siso-user-id": user.id },
        body: JSON.stringify({ ativo: !conta.ativo }),
      });
      if (!r.ok) throw new Error();
      toast.success(conta.ativo ? "Conta desativada" : "Conta ativada");
      onChanged();
    } catch {
      toast.error("Erro ao atualizar");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!user) return;
    if (
      !confirm(
        `Remover conta "${conta.label}"? Galpões e usuários que usam impressoras dessa conta ficarão sem impressora.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const r = await sisoFetch(`/api/wms/admin/printnode/contas/${conta.id}`, {
        method: "DELETE",
        headers: { "x-siso-user-id": user.id },
      });
      if (!r.ok) throw new Error();
      toast.success("Conta removida");
      onChanged();
    } catch {
      toast.error("Erro ao remover");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!user) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await sisoFetch(`/api/wms/admin/printnode/contas/${conta.id}/test`, {
        method: "POST",
        headers: { "x-siso-user-id": user.id },
      });
      const data = await r.json();
      setTestResult(r.ok ? data : { ok: false, error: data.error ?? `HTTP ${r.status}` });
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "Erro de rede" });
    } finally {
      setTesting(false);
    }
  }

  if (editing) {
    return (
      <ContaForm
        initial={{ id: conta.id, label: conta.label }}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  return (
    <div
      style={{
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        padding: 10,
        background: "var(--wms-c-panel-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 6,
        }}
      >
        <strong style={{ fontSize: 13 }}>{conta.label}</strong>
        <code className="wms-mono wms-td-mute" style={{ fontSize: 11 }}>
          {conta.masked}
        </code>
        <span
          className={`wms-badge ${conta.ativo ? "wms-badge-ok" : "wms-badge-mute"}`}
        >
          {conta.ativo ? "Ativa" : "Desativada"}
        </span>
        {testResult && (
          <span style={{ fontSize: 11 }}>
            {testResult.ok ? (
              <span style={{ color: "var(--wms-c-success, #047857)" }}>
                <Icon name="check" size={11} /> {testResult.email}
              </span>
            ) : (
              <span style={{ color: "var(--wms-c-danger)" }}>
                <Icon name="alert" size={11} /> {testResult.error}
              </span>
            )}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={test}
          disabled={testing || !conta.ativo}
        >
          <Icon name="rotate" size={11} />
          {testing ? "Testando…" : "Testar"}
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={() => setEditing(true)}
          disabled={busy}
        >
          <Icon name="edit" size={11} />
          Editar
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={toggleAtivo}
          disabled={busy}
        >
          {conta.ativo ? "Desativar" : "Ativar"}
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={remove}
          disabled={busy}
          style={{ marginLeft: "auto" }}
          title="Remover conta"
        >
          <Icon name="trash" size={11} />
        </button>
      </div>
    </div>
  );
}

function PrinterRow({
  label,
  hint,
  groups,
  value,
  saving,
  onChange,
  emptyLabel = "Nenhuma",
}: {
  label: string;
  hint?: string;
  groups: PrinterGroup[];
  value: number | null;
  saving: boolean;
  onChange: (
    picked: { accountId: string; printer: PrintNodePrinter } | null,
  ) => void;
  emptyLabel?: string;
}) {
  // value bruto = "<accountId>::<printerId>" pra desambiguar quando 2 contas
  // têm IDs sobrepostos. Mas como `value` aqui vem só do banco (printer_id),
  // precisamos achar a 1ª conta que tem esse printer pra reconstruir a key.
  const selectedKey = (() => {
    if (value === null) return "";
    for (const g of groups) {
      if (g.printers.some((p) => p.id === value)) {
        return `${g.accountId}::${value}`;
      }
    }
    return "";
  })();

  function handleChange(raw: string) {
    if (!raw) {
      onChange(null);
      return;
    }
    const [accountId, printerIdStr] = raw.split("::");
    const printerId = Number(printerIdStr);
    const group = groups.find((g) => g.accountId === accountId);
    const printer = group?.printers.find((p) => p.id === printerId);
    if (!group || !printer) {
      onChange(null);
      return;
    }
    onChange({ accountId, printer });
  }

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
        value={selectedKey}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        style={{ flex: 1 }}
      >
        <option value="">{emptyLabel}</option>
        {groups
          .filter((g) => g.printers.length > 0)
          .map((g) => (
            <optgroup key={g.accountId} label={g.accountLabel}>
              {g.printers.map((p) => (
                <option key={`${g.accountId}::${p.id}`} value={`${g.accountId}::${p.id}`}>
                  {p.name} ({p.computer})
                </option>
              ))}
            </optgroup>
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

// ─────────────────────────────────────────────────────────────────────────
// Mercado Livre — App config + N conexões (multi-conta)
// ─────────────────────────────────────────────────────────────────────────

interface MlAppStatus {
  configured: boolean;
  has_app_id: boolean;
  has_client_secret: boolean;
  app_id_preview: string | null;
  site_id?: string;
  atualizado_em?: string | null;
}

interface MlConnection {
  id: string;
  ml_user_id: number;
  nickname: string;
  email: string | null;
  site_id: string;
  scope: string | null;
  ativo: boolean;
  is_authorized: boolean;
  token_expires_at: string | null;
  ultimo_sync_em: string | null;
  ultimo_erro: string | null;
}

function MercadoLivreCard() {
  const [app, setApp] = useState<MlAppStatus | null>(null);
  const [connections, setConnections] = useState<MlConnection[]>([]);
  const [loadingApp, setLoadingApp] = useState(true);
  const [loadingConns, setLoadingConns] = useState(true);

  const fetchApp = useCallback(async () => {
    setLoadingApp(true);
    try {
      const r = await sisoFetch("/api/wms/ml/app");
      const data = (await r.json()) as MlAppStatus;
      setApp(data);
    } catch {
      setApp(null);
    } finally {
      setLoadingApp(false);
    }
  }, []);

  const fetchConnections = useCallback(async () => {
    setLoadingConns(true);
    try {
      const r = await sisoFetch("/api/wms/ml/connections");
      const data = await r.json();
      setConnections(Array.isArray(data) ? data : []);
    } catch {
      setConnections([]);
    } finally {
      setLoadingConns(false);
    }
  }, []);

  useEffect(() => {
    fetchApp();
    fetchConnections();
  }, [fetchApp, fetchConnections]);

  return (
    <Card
      title={`Mercado Livre${
        connections.length > 0
          ? ` (${connections.length} conta${connections.length > 1 ? "s" : ""})`
          : ""
      }`}
    >
      <p className="wms-td-mute" style={{ fontSize: 12, marginBottom: 12 }}>
        OAuth2 multi-conta. Cadastre 1 App (App ID + Client Secret) no{" "}
        <a
          href="https://developers.mercadolivre.com.br/devcenter/"
          target="_blank"
          rel="noreferrer"
          className="wms-btn-link"
        >
          DevCenter ML
        </a>{" "}
        e conecte quantas contas precisar. Pra ver anúncios no recebimento,
        o app precisa de escopo de leitura + offline_access.
      </p>

      <MlAppSection app={app} loading={loadingApp} onSaved={fetchApp} />

      <div
        style={{
          borderTop: "1px solid var(--wms-c-border)",
          paddingTop: 12,
          marginTop: 12,
        }}
      >
        <MlConnectionsSection
          connections={connections}
          loading={loadingConns}
          appConfigured={app?.configured ?? false}
          onChanged={fetchConnections}
        />
      </div>
    </Card>
  );
}

function MlAppSection({
  app,
  loading,
  onSaved,
}: {
  app: MlAppStatus | null;
  loading: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);

  const redirectUri =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/wms/ml/oauth/callback`
      : "";

  async function copyRedirect() {
    await navigator.clipboard.writeText(redirectUri);
    toast.success("Redirect URI copiada");
  }

  async function save() {
    if (!appId.trim() || !secret.trim()) {
      toast.error("App ID e Client Secret são obrigatórios");
      return;
    }
    setSaving(true);
    try {
      const r = await sisoFetch("/api/wms/ml/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: appId.trim(),
          client_secret: secret.trim(),
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      toast.success("App ML salvo");
      setEditing(false);
      setAppId("");
      setSecret("");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="wms-loading-pane" style={{ padding: 8 }}>
        Carregando…
      </div>
    );
  }

  const configured = !!app?.configured;

  return (
    <div>
      <h4 className="wms-sec-h" style={{ marginTop: 0, fontSize: 12 }}>
        App ML (credenciais do DevCenter)
      </h4>

      <div
        className="wms-hint-card wms-hint-info"
        style={{ fontSize: 11, marginBottom: 10 }}
      >
        <div style={{ flex: 1 }}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            Redirect URI (cole no DevCenter ao criar o App)
          </strong>
          <code className="wms-mono" style={{ wordBreak: "break-all" }}>
            {redirectUri}
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

      {editing || !configured ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            className="wms-input wms-mono"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="App ID (Client ID)"
            autoFocus
          />
          <div style={{ position: "relative" }}>
            <input
              className="wms-input wms-mono"
              type={showSecret ? "text" : "password"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
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
            >
              <Icon name={showSecret ? "x" : "search"} size={11} />
            </button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="wms-btn wms-btn-primary wms-btn-sm"
              onClick={save}
              disabled={saving}
            >
              <Icon name="check" size={11} />
              {saving ? "Salvando…" : "Salvar"}
            </button>
            {configured && (
              <button
                type="button"
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={() => {
                  setEditing(false);
                  setAppId("");
                  setSecret("");
                }}
              >
                Cancelar
              </button>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <code className="wms-mono wms-td-mute" style={{ fontSize: 11 }}>
            {app?.app_id_preview ?? "***"}
          </code>
          <span className="wms-badge wms-badge-ok">Configurado</span>
          <button
            type="button"
            className="wms-btn wms-btn-ghost wms-btn-sm"
            onClick={() => setEditing(true)}
            style={{ marginLeft: "auto" }}
          >
            <Icon name="edit" size={11} />
            Alterar
          </button>
        </div>
      )}
    </div>
  );
}

function MlConnectionsSection({
  connections,
  loading,
  appConfigured,
  onChanged,
}: {
  connections: MlConnection[];
  loading: boolean;
  appConfigured: boolean;
  onChanged: () => void;
}) {
  function connect() {
    if (!appConfigured) {
      toast.error("Configure o App ML antes de conectar uma conta");
      return;
    }
    window.location.href = "/api/wms/ml/oauth";
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <h4 className="wms-sec-h" style={{ margin: 0, fontSize: 12 }}>
          Contas conectadas
        </h4>
        <button
          type="button"
          className="wms-btn wms-btn-primary wms-btn-sm"
          onClick={connect}
          disabled={!appConfigured}
          style={{ marginLeft: "auto" }}
          title={
            !appConfigured ? "Configure o App ML primeiro" : "Autorizar nova conta"
          }
        >
          <Icon name="plus" size={11} />
          Conectar conta ML
        </button>
      </div>

      {loading ? (
        <div className="wms-loading-pane" style={{ padding: 8 }}>
          Carregando…
        </div>
      ) : connections.length === 0 ? (
        <p
          className="wms-td-mute"
          style={{ fontSize: 12, fontStyle: "italic" }}
        >
          Nenhuma conta conectada. Clique em <strong>Conectar conta ML</strong>{" "}
          pra autorizar a 1ª conta.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {connections.map((c) => (
            <MlConnectionRow key={c.id} conn={c} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

function MlConnectionRow({
  conn,
  onChanged,
}: {
  conn: MlConnection;
  onChanged: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);

  async function test() {
    setTesting(true);
    try {
      const r = await sisoFetch(`/api/wms/ml/connections/${conn.id}/test`, {
        method: "POST",
      });
      const j = await r.json();
      if (j.ok) toast.success(`Conexão OK: ${j.nickname}`);
      else toast.error(`Falha: ${j.erro}`);
      onChanged();
    } catch {
      toast.error("Erro ao testar");
    } finally {
      setTesting(false);
    }
  }

  async function toggleAtivo() {
    setBusy(true);
    try {
      const r = await sisoFetch("/api/wms/ml/connections", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conn.id, ativo: !conn.ativo }),
      });
      if (!r.ok) throw new Error();
      toast.success(conn.ativo ? "Desativada" : "Ativada");
      onChanged();
    } catch {
      toast.error("Erro ao atualizar");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Remover conexão com ${conn.nickname}?`)) return;
    setBusy(true);
    try {
      const r = await sisoFetch(`/api/wms/ml/connections/${conn.id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error();
      toast.success("Conexão removida");
      onChanged();
    } catch {
      toast.error("Erro ao remover");
    } finally {
      setBusy(false);
    }
  }

  function reauthorize() {
    window.location.href = "/api/wms/ml/oauth";
  }

  const statusBadge = !conn.is_authorized
    ? { label: "Sem token", cls: "wms-badge-mute" }
    : conn.ultimo_erro
    ? { label: "Com erro", cls: "wms-badge-warn" }
    : !conn.ativo
    ? { label: "Desativada", cls: "wms-badge-mute" }
    : { label: "Conectada", cls: "wms-badge-ok" };

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
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 14 }}>{conn.nickname}</strong>
        <span className="wms-mono wms-td-mute" style={{ fontSize: 11 }}>
          ID {conn.ml_user_id}
        </span>
        <span className={`wms-badge ${statusBadge.cls}`}>
          {statusBadge.label}
        </span>
        {conn.email && (
          <span className="wms-td-mute" style={{ fontSize: 11 }}>
            {conn.email}
          </span>
        )}
      </div>

      {conn.ultimo_erro && (
        <div
          className="wms-hint-card wms-hint-warn"
          style={{ fontSize: 11, marginBottom: 8 }}
        >
          <Icon name="alert" />
          <span>{conn.ultimo_erro}</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={test}
          disabled={testing || !conn.is_authorized}
        >
          <Icon name="rotate" size={11} />
          {testing ? "Testando…" : "Testar"}
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={reauthorize}
        >
          <Icon name="arrow-right" size={11} />
          Re-autorizar
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={toggleAtivo}
          disabled={busy}
        >
          {conn.ativo ? "Desativar" : "Ativar"}
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={remove}
          disabled={busy}
          style={{ marginLeft: "auto" }}
          title="Remover conexão"
        >
          <Icon name="trash" size={11} />
        </button>
      </div>
    </div>
  );
}
