"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, type IconName } from "@/components/wms/ui/wms-ui";
import {
  AjusteModal,
  ReceberModal,
  RealocarModal,
  TransferModal,
} from "@/components/wms/ui/modals";
import { SidebarGalpaoSwitcher } from "@/components/wms/sidebar-galpao-switcher";
import type { Produto } from "@/lib/wms/types";

// ──────────────────────────────────────────────────────────────────
// Modal Context — qualquer página pode disparar abertura de modal.

type ModalKind = "receber" | "ajuste" | "transferir" | "realocar" | null;

interface RealocarSeedExt {
  produto?: Produto;
  empresa_id?: string;
  galpao_id?: string;
  localizacao_origem_id?: string;
  localizacao_destino_id?: string;
  qty?: number;
  motivo?: string;
}

type ModalSeed = { produto?: Produto } & Partial<RealocarSeedExt>;

interface ModalContextValue {
  open: (kind: Exclude<ModalKind, null>, seed?: ModalSeed) => void;
  openCommandK: () => void;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function useWmsModals() {
  const ctx = useContext(ModalContext);
  if (!ctx)
    throw new Error("useWmsModals deve ser usado dentro do WmsShell");
  return ctx;
}

// ──────────────────────────────────────────────────────────────────
// Navegação

interface NavItem {
  href: string;
  icon: IconName;
  label: string;
  badge?: number;
}
interface NavSection {
  id: string;
  label: string;
  itens: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    id: "vendas",
    label: "Vendas",
    itens: [
      { href: "/wms/pedidos", icon: "clipboard", label: "Pedidos" },
      { href: "/wms/separacao", icon: "list", label: "Separação" },
      { href: "/wms/compras", icon: "truck", label: "Compras" },
    ],
  },
  {
    id: "principal",
    label: "Visibilidade",
    itens: [
      { href: "/wms/estoque", icon: "box", label: "Estoque" },
      { href: "/wms/cobertura", icon: "gauge", label: "Cobertura" },
    ],
  },
  {
    id: "operacoes",
    label: "Operações",
    itens: [
      { href: "/wms/transferir", icon: "arrows", label: "Transferências" },
      { href: "/wms/replenishment", icon: "shuffle", label: "Realocar" },
      { href: "/wms/devolucoes", icon: "rotate", label: "Devoluções" },
      { href: "/wms/receber", icon: "plus", label: "Receber" },
      { href: "/wms/guarda", icon: "box", label: "Guarda" },
    ],
  },
  {
    id: "inventario",
    label: "Inventário",
    itens: [
      { href: "/wms/inventario", icon: "clipboard", label: "Sessões" },
      { href: "/wms/inventario/metricas", icon: "gauge", label: "Métricas" },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    itens: [
      { href: "/wms/insights", icon: "sparkle", label: "Hub" },
      { href: "/wms/insights/pessoas", icon: "handshake", label: "Pessoas" },
      { href: "/wms/insights/fluxo", icon: "arrows", label: "Fluxo" },
      { href: "/wms/insights/estoque", icon: "gauge", label: "Estoque" },
      { href: "/wms/insights/financeiro", icon: "building", label: "Financeiro" },
      { href: "/wms/insights/devolucoes", icon: "rotate", label: "Devoluções" },
      { href: "/wms/insights/regras", icon: "sliders", label: "Regras" },
    ],
  },
  {
    id: "cadastros",
    label: "Cadastros",
    itens: [
      { href: "/wms/produtos", icon: "tag", label: "Produtos" },
      { href: "/wms/cross", icon: "sparkle", label: "Cross" },
      { href: "/wms/localizacoes", icon: "pin", label: "Localizações" },
      { href: "/wms/fornecedores", icon: "truck", label: "Fornecedores" },
      { href: "/wms/emprestimos", icon: "handshake", label: "Empréstimos" },
    ],
  },
  {
    id: "sistema",
    label: "Sistema",
    itens: [
      { href: "/wms/configuracoes", icon: "building", label: "Configurações" },
    ],
  },
];

const ALL_NAV: NavItem[] = NAV_SECTIONS.flatMap((s) => s.itens);

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (href === "/wms/inventario") {
    return (
      pathname.startsWith("/wms/inventario/") &&
      !pathname.startsWith("/wms/inventario/metricas")
    );
  }
  // /wms/separacao casa checklist + embalagem (sub-rotas)
  // /wms/pedidos casa /wms/pedidos/[id]
  // /wms/cross casa /wms/cross/[sku]
  return pathname.startsWith(`${href}/`);
}

// ──────────────────────────────────────────────────────────────────
// Sidebar

function Sidebar({
  pathname,
  onCmdK,
  userInitials,
  userName,
  userRole,
  isOpen,
  onNavigate,
}: {
  pathname: string;
  onCmdK: () => void;
  userInitials: string;
  userName: string;
  userRole: string;
  isOpen: boolean;
  onNavigate: () => void;
}) {
  return (
    <aside className={`wms-sb ${isOpen ? "is-open" : ""}`}>
      <div className="wms-sb-hd">
        <Link href="/wms" className="wms-sb-logo" onClick={onNavigate}>
          <div className="wms-sb-logo-mark">N</div>
          <div>
            <div className="wms-sb-logo-name">NetAir WMS</div>
            <div className="wms-sb-logo-org">SISO</div>
          </div>
        </Link>
        <SidebarGalpaoSwitcher />
        <button className="wms-sb-cmd" onClick={onCmdK}>
          <Icon name="search" size={12} />
          <span>Buscar</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
      <nav className="wms-sb-nav">
        {NAV_SECTIONS.map((sec) => (
          <div key={sec.id} className="wms-sb-sect">
            <div className="wms-sb-sect-lbl">{sec.label}</div>
            {sec.itens.map((n) => {
              const active = isActive(pathname, n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`wms-sb-item ${active ? "is-active" : ""}`}
                  onClick={onNavigate}
                >
                  <Icon name={n.icon} />
                  <span>{n.label}</span>
                  {n.badge ? <em className="wms-sb-badge">{n.badge}</em> : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="wms-sb-ft">
        <div className="wms-sb-user">
          <div className="wms-sb-avatar">{userInitials}</div>
          <div>
            <div className="wms-sb-user-name">{userName}</div>
            <div className="wms-sb-user-role">{userRole}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function MobileTopbar({ onOpen }: { onOpen: () => void }) {
  return (
    <header className="wms-topbar">
      <button
        type="button"
        className="wms-topbar-burger"
        aria-label="Abrir menu"
        onClick={onOpen}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M3 5h12M3 9h12M3 13h12" />
        </svg>
      </button>
      <Link href="/wms" className="wms-topbar-logo">
        <span className="wms-topbar-logo-mark">N</span>
        <span>NetAir WMS</span>
      </Link>
    </header>
  );
}

// ──────────────────────────────────────────────────────────────────
// CommandK

interface ProdutoLite {
  id: string;
  sku: string;
  descricao: string;
}

function CommandK({
  open,
  onClose,
  router,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  router: ReturnType<typeof useRouter>;
  onAction: (kind: Exclude<ModalKind, null>) => void;
}) {
  if (!open) return null;
  return (
    <CommandKInner onClose={onClose} router={router} onAction={onAction} />
  );
}

function CommandKInner({
  onClose,
  router,
  onAction,
}: {
  onClose: () => void;
  router: ReturnType<typeof useRouter>;
  onAction: (kind: Exclude<ModalKind, null>) => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, []);

  const ql = q.trim().toLowerCase();
  const navResults = ALL_NAV.filter(
    (n) => !ql || n.label.toLowerCase().includes(ql),
  );

  const produtosQuery = useQuery({
    queryKey: ["wms-cmdk-produtos", ql],
    queryFn: () =>
      wmsApi<{ rows: ProdutoLite[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(ql)}&limit=6`,
      ),
    enabled: ql.length >= 2,
    staleTime: 30 * 1000,
  });
  const prodResults = produtosQuery.data?.rows ?? [];

  const actions = [
    {
      id: "a1",
      label: "Receber mercadoria",
      hint: "Nova entrada",
      go: () => {
        onAction("receber");
        onClose();
      },
    },
    {
      id: "a2",
      label: "Nova transferência",
      hint: "Entre galpões",
      go: () => {
        onAction("transferir");
        onClose();
      },
    },
    {
      id: "a3",
      label: "Realocar",
      hint: "Mover entre localizações",
      go: () => {
        onAction("realocar");
        onClose();
      },
    },
    {
      id: "a4",
      label: "Ajuste manual",
      hint: "Entrada ou saída",
      go: () => {
        onAction("ajuste");
        onClose();
      },
    },
    {
      id: "a5",
      label: "Iniciar inventário",
      hint: "Cycle count",
      go: () => {
        router.push("/wms/inventario");
        onClose();
      },
    },
  ].filter((a) => !ql || a.label.toLowerCase().includes(ql));

  return (
    <div className="wms-ck-overlay" onClick={onClose}>
      <div className="wms-ck" onClick={(e) => e.stopPropagation()}>
        <div className="wms-ck-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar produto, SKU, ação ou navegar…"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="wms-ck-body">
          {prodResults.length > 0 && (
            <div className="wms-ck-group">
              <div className="wms-ck-group-h">Produtos</div>
              {prodResults.map((p) => (
                <button
                  key={p.id}
                  className="wms-ck-item"
                  onClick={() => {
                    router.push(`/wms/estoque?produto=${p.id}`);
                    onClose();
                  }}
                >
                  <span className="wms-ck-item-mono">{p.sku}</span>
                  <span className="wms-ck-item-desc">{p.descricao}</span>
                </button>
              ))}
            </div>
          )}
          {actions.length > 0 && (
            <div className="wms-ck-group">
              <div className="wms-ck-group-h">Ações rápidas</div>
              {actions.map((a) => (
                <button key={a.id} className="wms-ck-item" onClick={a.go}>
                  <Icon name="sparkle" size={12} />
                  <span className="wms-ck-item-desc">{a.label}</span>
                  <span className="wms-ck-item-meta">{a.hint}</span>
                </button>
              ))}
            </div>
          )}
          {navResults.length > 0 && (
            <div className="wms-ck-group">
              <div className="wms-ck-group-h">Navegar</div>
              {navResults.map((n) => (
                <button
                  key={n.href}
                  className="wms-ck-item"
                  onClick={() => {
                    router.push(n.href);
                    onClose();
                  }}
                >
                  <Icon name={n.icon} size={12} />
                  <span className="wms-ck-item-desc">{n.label}</span>
                </button>
              ))}
            </div>
          )}
          {prodResults.length === 0 &&
            actions.length === 0 &&
            navResults.length === 0 && (
              <div className="wms-ck-empty">
                Nenhum resultado para &ldquo;{q}&rdquo;
              </div>
            )}
        </div>
        <div className="wms-ck-ft">
          <span>
            <kbd>↑↓</kbd> navegar
          </span>
          <span>
            <kbd>↵</kbd> abrir
          </span>
          <span>
            <kbd>esc</kbd> fechar
          </span>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// WmsShell

export function WmsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/wms";
  const router = useRouter();
  const { user, loading } = useAuth();

  const [ckOpen, setCkOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modal, setModal] = useState<{
    kind: Exclude<ModalKind, null>;
    seed?: ModalSeed;
  } | null>(null);

  // Fecha a drawer ao trocar de rota
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSidebarOpen(false);
  }, [pathname]);

  // ESC fecha drawer mobile
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  const openModal = useCallback(
    (kind: Exclude<ModalKind, null>, seed?: ModalSeed) => {
      setModal({ kind, seed });
    },
    [],
  );

  const ctxValue = useMemo<ModalContextValue>(
    () => ({
      open: openModal,
      openCommandK: () => setCkOpen(true),
    }),
    [openModal],
  );

  // ⌘K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCkOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auth gate
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="wms-root">
        <div
          style={{
            display: "grid",
            placeItems: "center",
            height: "100vh",
            background: "var(--wms-c-bg)",
          }}
        >
          <Loader2 className="h-6 w-6 animate-spin text-ink-faint" />
        </div>
      </div>
    );
  }
  if (!user) return null;

  const initials = (user.nome || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  const role = (user.cargos ?? [user.cargo])
    .map((c) => c.replace("_", " "))
    .join(", ");

  return (
    <ModalContext.Provider value={ctxValue}>
      <div className="wms-root">
        <div className="wms-app">
          <Sidebar
            pathname={pathname}
            onCmdK={() => setCkOpen(true)}
            userInitials={initials}
            userName={user.nome}
            userRole={role}
            isOpen={sidebarOpen}
            onNavigate={() => setSidebarOpen(false)}
          />
          <div
            className={`wms-sb-backdrop ${sidebarOpen ? "is-open" : ""}`}
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
          <div className="wms-main">
            <MobileTopbar onOpen={() => setSidebarOpen(true)} />
            <div className="wms-view">{children}</div>
          </div>

          <CommandK
            open={ckOpen}
            onClose={() => setCkOpen(false)}
            router={router}
            onAction={openModal}
          />

          {modal?.kind === "receber" && (
            <ReceberModal
              seed={modal.seed}
              onClose={() => setModal(null)}
            />
          )}
          {modal?.kind === "ajuste" && (
            <AjusteModal seed={modal.seed} onClose={() => setModal(null)} />
          )}
          {modal?.kind === "transferir" && (
            <TransferModal seed={modal.seed} onClose={() => setModal(null)} />
          )}
          {modal?.kind === "realocar" && (
            <RealocarModal seed={modal.seed} onClose={() => setModal(null)} />
          )}
        </div>
      </div>
    </ModalContext.Provider>
  );
}
