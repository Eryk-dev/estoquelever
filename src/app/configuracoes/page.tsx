"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Activity, Users } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { WebhookUrlCard } from "@/components/configuracoes/webhook-url-card";
import { GalpoesEmpresasSection } from "@/components/configuracoes/galpoes-empresas-section";
import { GruposSection } from "@/components/configuracoes/grupos-section";
import { PrintNodeSection } from "@/components/configuracoes/printnode-section";
import type {
  TinyConnection,
  GalpaoHierarquia,
  GrupoInfo,
  UsuarioPrintNode,
} from "@/components/configuracoes/types";

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
  const [usuarios, setUsuarios] = useState<UsuarioPrintNode[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [connRes, galpRes, grupoRes, userRes] = await Promise.all([
        fetch("/api/tiny/connections"),
        fetch("/api/admin/galpoes"),
        fetch("/api/admin/grupos"),
        fetch("/api/admin/usuarios"),
      ]);
      const [connData, galpData, grupoData, userData] = await Promise.all([
        connRes.json(),
        galpRes.json(),
        grupoRes.json(),
        userRes.json(),
      ]);
      setConnections(Array.isArray(connData) ? connData : []);
      setGalpoes(Array.isArray(galpData) ? galpData : []);
      setGrupos(Array.isArray(grupoData) ? grupoData : []);
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
    <AppShell
      title="Configurações"
      subtitle="Galpões, Empresas, Grupos e Conexões Tiny"
      backHref="/"
      mainClassName="space-y-6"
    >
      {/* ── Links rápidos ───────────────────────────────────────── */}
      <div className="flex gap-3">
        <Link
          href="/admin/usuarios"
          className="flex flex-1 items-center gap-3 rounded-xl border border-line bg-paper px-4 py-4 transition-colors hover:bg-surface"
        >
          <Users className="h-5 w-5 text-purple-500" />
          <div>
            <p className="text-sm font-semibold text-ink">Usuários</p>
            <p className="text-xs text-ink-faint">Cargos e acessos</p>
          </div>
        </Link>
        <Link
          href="/monitoramento"
          className="flex flex-1 items-center gap-3 rounded-xl border border-line bg-paper px-4 py-4 transition-colors hover:bg-surface"
        >
          <Activity className="h-5 w-5 text-emerald-500" />
          <div>
            <p className="text-sm font-semibold text-ink">Monitoramento</p>
            <p className="text-xs text-ink-faint">Logs e saúde</p>
          </div>
        </Link>
      </div>

      {/* ── Webhook URL ──────────────────────────────────────────── */}
      <WebhookUrlCard url={webhookUrl} />

      {/* ── Galpões e Empresas ────────────────────────────────────── */}
      <GalpoesEmpresasSection
        galpoes={galpoes}
        connections={connections}
        loading={loading}
        onRefresh={fetchAll}
      />

      {/* ── Grupos ────────────────────────────────────────────────── */}
      <GruposSection
        grupos={grupos}
        galpoes={galpoes}
        loading={loading}
        onRefresh={fetchAll}
      />

      {/* ── PrintNode ──────────────────────────────────────────── */}
      <PrintNodeSection
        galpoes={galpoes}
        usuarios={usuarios}
        onRefresh={fetchAll}
      />
    </AppShell>
  );
}
