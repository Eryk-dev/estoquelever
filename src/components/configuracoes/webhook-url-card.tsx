"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Shield, Webhook } from "lucide-react";
import { cn } from "@/lib/utils";

export function WebhookUrlCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("URL copiada!");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-paper">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Webhook className="h-4 w-4 text-blue-500" />
        <h2 className="text-sm font-semibold text-ink">URL do Webhook</h2>
      </div>
      <div className="space-y-3 px-4 py-4">
        <p className="text-xs text-ink-muted">
          Configure esta URL no Tiny ERP como webhook de{" "}
          <strong>atualização de pedido</strong> para cada empresa.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink">
            {url || "..."}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-all",
              copied
                ? "border-emerald-300 bg-emerald-50 text-emerald-600 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                : "border-line bg-paper text-ink-muted hover:bg-surface hover:text-ink",
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
