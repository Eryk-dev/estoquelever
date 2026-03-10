"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { DepositoSelector } from "./deposito-selector";
import type { TinyConnection } from "./types";

function StatusBadge({ connection }: { connection: TinyConnection }) {
  const hasCredentials = connection.has_client_id && connection.has_client_secret;

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

export function ConnectionCard({
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

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-3 px-3 py-2">
        <PlugZap className="h-3.5 w-3.5 text-ink-faint" />
        <span className="flex-1 text-xs font-medium text-ink-muted">
          Conexão Tiny
        </span>
        <StatusBadge connection={connection} />
      </div>

      {connection.is_authorized && (
        <DepositoSelector connection={connection} onSaved={onUpdated} />
      )}

      <div className="border-t border-line/60 px-3 py-2">
        {editing ? (
          <div className="space-y-2">
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Client ID"
              className="w-full rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-xs text-ink outline-none"
              autoFocus
            />
            <div className="relative">
              <input
                type={showSecret ? "text" : "password"}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Client Secret"
                className="w-full rounded-lg border border-line bg-paper px-3 py-1.5 pr-8 font-mono text-xs text-ink outline-none"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-ink-faint"
                tabIndex={-1}
              >
                {showSecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveCredentials}
                disabled={saving}
                className="btn-primary px-3 py-1.5 text-xs"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Salvar
              </button>
              <button
                onClick={() => { setEditing(false); setClientId(""); setClientSecret(""); }}
                className="text-xs text-ink-faint hover:text-ink-muted"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {hasCredentials ? (
                <code className="flex-1 rounded bg-paper px-2 py-1 font-mono text-[11px] text-ink-muted">
                  {connection.client_id_preview ?? "***"}
                </code>
              ) : (
                <span className="flex-1 text-[11px] italic text-ink-faint">
                  Sem credenciais OAuth2
                </span>
              )}
              <button
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] font-medium text-ink-muted hover:bg-paper"
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
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] font-medium text-ink-muted hover:bg-paper"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    Re-autorizar
                  </button>
                  <button
                    onClick={handleTest}
                    disabled={testing}
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] font-medium text-ink-muted hover:bg-paper disabled:opacity-30"
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
