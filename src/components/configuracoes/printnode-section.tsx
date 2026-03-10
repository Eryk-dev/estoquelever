"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Loader2,
  Printer,
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

  if (!user || user.cargo !== "admin") return null;

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
        {/* Connection test */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleTestConnection}
            disabled={testing}
            className="btn-primary px-3 py-1.5 text-xs"
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
        {!hasPrinters && !loadingPrinters && !connectionStatus && (
          <p className="text-xs text-ink-faint">
            Teste a conexão para listar as impressoras disponíveis.
          </p>
        )}
      </div>
    </section>
  );
}
