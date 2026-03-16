"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Printer,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import type { GalpaoHierarquia, UsuarioPrintNode } from "./types";

interface PrintNodePrinter {
  id: number;
  name: string;
  computer: string;
  state: string;
}

export function PrintNodeSection({
  galpoes,
  usuarios,
  onRefresh,
}: {
  galpoes: GalpaoHierarquia[];
  usuarios: UsuarioPrintNode[];
  onRefresh: () => void;
}) {
  const { user } = useAuth();
  const [testing, setTesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{
    ok: boolean;
    email?: string;
    error?: string;
  } | null>(null);
  const [printers, setPrinters] = useState<PrintNodePrinter[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  // API key state
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyMasked, setApiKeyMasked] = useState<string | null>(null);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [loadingKey, setLoadingKey] = useState(true);

  if (!user || !(user.cargos ?? [user.cargo]).includes("admin")) return null;

  // Fetch API key status on mount
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    async function loadKeyStatus() {
      try {
        const res = await fetch("/api/admin/printnode/api-key", {
          headers: { "x-siso-user-id": user!.id },
        });
        if (res.ok) {
          const data = await res.json();
          setApiKeyConfigured(data.configured);
          setApiKeyMasked(data.masked);
        }
      } catch {
        // ignore
      } finally {
        setLoadingKey(false);
      }
    }
    loadKeyStatus();
  }, [user]);

  async function handleSaveApiKey() {
    if (!apiKeyInput.trim()) return;
    setSavingKey(true);
    try {
      const res = await fetch("/api/admin/printnode/api-key", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-siso-user-id": user!.id,
        },
        body: JSON.stringify({ api_key: apiKeyInput.trim() }),
      });
      if (!res.ok) throw new Error("Erro ao salvar");
      const key = apiKeyInput.trim();
      const masked = key.length > 4
        ? "•".repeat(key.length - 4) + key.slice(-4)
        : "•".repeat(key.length);
      setApiKeyConfigured(true);
      setApiKeyMasked(masked);
      setApiKeyInput("");
      setShowApiKey(false);
      setConnectionStatus(null);
      setPrinters([]);
      toast.success("API Key salva");
    } catch {
      toast.error("Erro ao salvar API Key");
    } finally {
      setSavingKey(false);
    }
  }

  async function handleDeleteApiKey() {
    if (!confirm("Remover a API Key do PrintNode?")) return;
    try {
      await fetch("/api/admin/printnode/api-key", {
        method: "DELETE",
        headers: { "x-siso-user-id": user!.id },
      });
      setApiKeyConfigured(false);
      setApiKeyMasked(null);
      setConnectionStatus(null);
      setPrinters([]);
      toast.success("API Key removida");
    } catch {
      toast.error("Erro ao remover API Key");
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setConnectionStatus(null);
    try {
      const res = await fetch("/api/admin/printnode/test", {
        method: "POST",
        headers: { "x-siso-user-id": user!.id },
      });
      const data = await res.json();
      if (!res.ok) {
        setConnectionStatus({ ok: false, error: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setConnectionStatus(data);
      if (data.ok) {
        await fetchPrinters();
      }
    } catch (err) {
      setConnectionStatus({
        ok: false,
        error: err instanceof Error ? err.message : "Erro de rede",
      });
    } finally {
      setTesting(false);
    }
  }

  async function fetchPrinters() {
    setLoadingPrinters(true);
    try {
      const res = await fetch("/api/admin/printnode/printers", {
        headers: { "x-siso-user-id": user!.id },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPrinters(Array.isArray(data) ? data : []);
    } catch {
      toast.error("Erro ao listar impressoras");
    } finally {
      setLoadingPrinters(false);
    }
  }

  async function handleGalpaoPrinterChange(galpaoId: string, printerId: number | null) {
    const printer = printers.find((p) => p.id === printerId);
    setSavingId(`galpao-${galpaoId}`);
    try {
      const res = await fetch(`/api/admin/galpoes/${galpaoId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          printnode_printer_id: printerId,
          printnode_printer_nome: printer?.name ?? null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Impressora do galpão atualizada");
      onRefresh();
    } catch {
      toast.error("Erro ao salvar impressora do galpão");
    } finally {
      setSavingId(null);
    }
  }

  async function handleUsuarioPrinterChange(usuarioId: string, printerId: number | null) {
    const printer = printers.find((p) => p.id === printerId);
    setSavingId(`user-${usuarioId}`);
    try {
      const res = await fetch("/api/admin/usuarios", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: usuarioId,
          printnode_printer_id: printerId,
          printnode_printer_nome: printer?.name ?? null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Impressora do usuário atualizada");
      onRefresh();
    } catch {
      toast.error("Erro ao salvar impressora do usuário");
    } finally {
      setSavingId(null);
    }
  }

  const hasPrinters = printers.length > 0;
  const galpoesWithoutPrinter = galpoes.filter(
    (g) => g.ativo && !g.printnode_printer_id,
  );

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-paper">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Printer className="h-4 w-4 text-violet-500" />
        <h2 className="text-sm font-semibold text-ink">
          Impressão (PrintNode)
        </h2>
      </div>

      <div className="space-y-4 px-4 py-4">
        {/* API Key */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-ink-muted">API Key</p>

          {loadingKey ? (
            <div className="flex items-center gap-2 text-xs text-ink-faint">
              <Loader2 className="h-3 w-3 animate-spin" />
              Carregando...
            </div>
          ) : apiKeyConfigured ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
                <Key className="h-3 w-3 text-ink-faint" />
                <span className="font-mono text-xs text-ink-muted">
                  {apiKeyMasked}
                </span>
                <Check className="h-3 w-3 text-emerald-500" />
              </div>
              <button
                onClick={() => {
                  setApiKeyConfigured(false);
                  setApiKeyInput("");
                }}
                className="text-xs text-ink-faint hover:text-ink"
                title="Alterar"
              >
                Alterar
              </button>
              <button
                onClick={handleDeleteApiKey}
                className="text-xs text-red-500 hover:text-red-600"
                title="Remover"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="relative flex-1 max-w-sm">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="Cole a API Key do PrintNode"
                  className="w-full rounded-lg border border-line bg-surface px-3 py-1.5 pr-8 font-mono text-xs text-ink outline-none focus:border-ink-faint"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveApiKey();
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
                >
                  {showApiKey ? (
                    <EyeOff className="h-3 w-3" />
                  ) : (
                    <Eye className="h-3 w-3" />
                  )}
                </button>
              </div>
              <button
                onClick={handleSaveApiKey}
                disabled={savingKey || !apiKeyInput.trim()}
                className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {savingKey ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Salvar"
                )}
              </button>
            </div>
          )}
        </div>

        {/* Connection test */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleTestConnection}
            disabled={testing || (!apiKeyConfigured && !apiKeyInput.trim())}
            className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {testing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Printer className="h-3 w-3" />
            )}
            Testar Conexão
          </button>

          {connectionStatus && (
            <span className="flex items-center gap-1.5 text-xs">
              {connectionStatus.ok ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                  <span className="text-emerald-600 dark:text-emerald-400">
                    Conectado ({connectionStatus.email})
                  </span>
                </>
              ) : (
                <>
                  <X className="h-3.5 w-3.5 text-red-500" />
                  <span className="text-red-600 dark:text-red-400">
                    {connectionStatus.error}
                  </span>
                </>
              )}
            </span>
          )}
        </div>

        {/* Printers loading */}
        {loadingPrinters && (
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            <Loader2 className="h-3 w-3 animate-spin" />
            Carregando impressoras...
          </div>
        )}

        {/* Galpão printers */}
        {hasPrinters && (
          <div>
            <p className="mb-2 text-xs font-medium text-ink-muted">
              Impressora padrão por Galpão
            </p>
            <div className="space-y-2">
              {galpoes
                .filter((g) => g.ativo)
                .map((galpao) => (
                  <div
                    key={galpao.id}
                    className="flex items-center gap-3"
                  >
                    <span className="w-16 text-xs font-semibold text-ink">
                      {galpao.nome}
                    </span>
                    <select
                      value={galpao.printnode_printer_id ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        handleGalpaoPrinterChange(
                          galpao.id,
                          val ? Number(val) : null,
                        );
                      }}
                      disabled={savingId === `galpao-${galpao.id}`}
                      className="flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink outline-none disabled:opacity-50"
                    >
                      <option value="">Nenhuma</option>
                      {printers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.computer})
                        </option>
                      ))}
                    </select>
                    {savingId === `galpao-${galpao.id}` && (
                      <Loader2 className="h-3 w-3 animate-spin text-ink-faint" />
                    )}
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Warning for galpões without printer */}
        {hasPrinters && galpoesWithoutPrinter.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 dark:bg-amber-950/30">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {galpoesWithoutPrinter.length === 1
                ? `Galpão ${galpoesWithoutPrinter[0].nome} sem impressora configurada`
                : `${galpoesWithoutPrinter.length} galpões sem impressora configurada`}
            </p>
          </div>
        )}

        {/* User overrides */}
        {hasPrinters && usuarios.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-ink-muted">
              Override por Usuário (opcional)
            </p>
            <div className="space-y-2">
              {usuarios.map((u) => (
                <div key={u.id} className="flex items-center gap-3">
                  <span className="w-24 truncate text-xs text-ink">
                    {u.nome}
                  </span>
                  <select
                    value={u.printnode_printer_id ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      handleUsuarioPrinterChange(
                        u.id,
                        val ? Number(val) : null,
                      );
                    }}
                    disabled={savingId === `user-${u.id}`}
                    className="flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink outline-none disabled:opacity-50"
                  >
                    <option value="">Nenhuma (usa padrão do galpão)</option>
                    {printers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.computer})
                      </option>
                    ))}
                  </select>
                  {savingId === `user-${u.id}` && (
                    <Loader2 className="h-3 w-3 animate-spin text-ink-faint" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No printers and no connection test yet */}
        {!hasPrinters && !loadingPrinters && !connectionStatus && apiKeyConfigured && (
          <p className="text-xs text-ink-faint">
            Teste a conexão para listar as impressoras disponíveis.
          </p>
        )}
      </div>
    </section>
  );
}
