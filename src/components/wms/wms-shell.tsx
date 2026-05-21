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
import { Loader2, LogOut } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth, usePermissoes } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, type IconName } from "@/components/wms/ui/wms-ui";
import {
  AjusteModal,
  RealocarModal,
  TransferModal,
} from "@/components/wms/ui/modals";
import { SidebarGalpaoSwitcher } from "@/components/wms/sidebar-galpao-switcher";
import type { Produto } from "@/lib/wms/types";
import { type PermissaoCodigo } from "@/lib/permissions";

// ──────────────────────────────────────────────────────────────────
// Modal Context — qualquer página pode disparar abertura de modal.

type ModalKind = "receber" | "ajuste" | "transferir" | "realocar" | null;

interface RealocarSeedExt {
  produto?: Produto;
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
  /** OR-set: usuário com pelo menos uma das permissões vê o item. */
  requires?: PermissaoCodigo[];
}
interface NavSection {
  id: string;
  label: string;
  itens: NavItem[];
  /** OR-set: usuário com pelo menos uma das permissões vê a seção (e seus items respeitam o próprio requires). */
  requires?: PermissaoCodigo[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    id: "vendas",
    label: "Vendas",
    itens: [
      { href: "/wms/vendas", icon: "handshake", label: "Vendas Diretas", requires: ["vendas.ver"] },
      { href: "/wms/pedidos", icon: "clipboard", label: "Pedidos", requires: ["pedidos.ver"] },
      { href: "/wms/separacao", icon: "list", label: "Separação", requires: ["separacao.ver"] },
      { href: "/wms/compras", icon: "truck", label: "Compras", requires: ["compras.ver"] },
    ],
  },
  {
    id: "principal",
    label: "Visibilidade",
    requires: ["estoque.ver", "cobertura.ver"],
    itens: [
      { href: "/wms/estoque", icon: "box", label: "Estoque", requires: ["estoque.ver"] },
      { href: "/wms/cobertura", icon: "gauge", label: "Cobertura", requires: ["cobertura.ver"] },
    ],
  },
  {
    id: "operacoes",
    label: "Operações",
    requires: ["operacoes.transferir", "operacoes.replenishment", "operacoes.devolucoes", "operacoes.receber", "operacoes.guarda"],
    itens: [
      { href: "/wms/transferir", icon: "arrows", label: "Transferências", requires: ["operacoes.transferir"] },
      { href: "/wms/replenishment", icon: "shuffle", label: "Realocar", requires: ["operacoes.replenishment"] },
      { href: "/wms/devolucoes", icon: "rotate", label: "Devoluções", requires: ["operacoes.devolucoes"] },
      { href: "/wms/receber", icon: "plus", label: "Receber", requires: ["operacoes.receber"] },
      { href: "/wms/guarda", icon: "box", label: "Guarda", requires: ["operacoes.guarda"] },
    ],
  },
  {
    id: "inventario",
    label: "Inventário",
    requires: ["inventario.ver"],
    itens: [
      { href: "/wms/inventario", icon: "clipboard", label: "Sessões", requires: ["inventario.ver"] },
      { href: "/wms/inventario/metricas", icon: "gauge", label: "Métricas", requires: ["inventario.ver"] },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    requires: ["insights.ver"],
    itens: [
      { href: "/wms/insights", icon: "sparkle", label: "Hub", requires: ["insights.ver"] },
      { href: "/wms/insights/pessoas", icon: "handshake", label: "Pessoas", requires: ["insights.ver"] },
      { href: "/wms/insights/fluxo", icon: "arrows", label: "Fluxo", requires: ["insights.ver"] },
      { href: "/wms/insights/estoque", icon: "gauge", label: "Estoque", requires: ["insights.ver"] },
      { href: "/wms/insights/financeiro", icon: "building", label: "Financeiro", requires: ["insights.financeiro"] },
      { href: "/wms/insights/devolucoes", icon: "rotate", label: "Devoluções", requires: ["insights.ver"] },
      { href: "/wms/insights/regras", icon: "sliders", label: "Regras", requires: ["insights.regras"] },
    ],
  },
  {
    id: "relatorios",
    label: "Relatórios",
    requires: ["relatorios.ver"],
    itens: [
      { href: "/wms/relatorios/movs-por-empresa", icon: "columns", label: "Movs por Empresa", requires: ["relatorios.ver"] },
      { href: "/wms/relatorios/historico-custo", icon: "history", label: "Histórico de Custo", requires: ["relatorios.ver"] },
      { href: "/wms/relatorios/saldos-por-empresa", icon: "box", label: "Saldos por Empresa", requires: ["relatorios.ver"] },
    ],
  },
  {
    id: "cadastros",
    label: "Cadastros",
    requires: ["produtos.editar", "localizacoes.editar", "fornecedores.editar"],
    itens: [
      { href: "/wms/produtos", icon: "tag", label: "Produtos", requires: ["produtos.editar"] },
      { href: "/wms/cross", icon: "sparkle", label: "Cross", requires: ["produtos.editar"] },
      { href: "/wms/localizacoes", icon: "pin", label: "Localizações", requires: ["localizacoes.editar"] },
      { href: "/wms/fornecedores", icon: "truck", label: "Fornecedores", requires: ["fornecedores.editar"] },
    ],
  },
  {
    id: "sistema",
    label: "Sistema",
    requires: ["sistema.usuarios", "sistema.roles", "sistema.conexoes", "sistema.galpoes_empresas"],
    itens: [
      { href: "/wms/configuracoes", icon: "building", label: "Configurações", requires: ["sistema.usuarios"] },
    ],
  },
];

/** Filtra seções e items conforme permissões do usuário (OR-set). */
function filterNavForUser(permissoes: Set<string>): NavSection[] {
  const hasAny = (req?: PermissaoCodigo[]) =>
    !req || req.length === 0 || req.some((p) => permissoes.has(p));

  return NAV_SECTIONS.flatMap<NavSection>((sec) => {
    if (!hasAny(sec.requires)) return [];
    const itens = sec.itens.filter((it) => hasAny(it.requires));
    if (itens.length === 0) return [];
    return [{ ...sec, itens }];
  });
}

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
  sections,
  isOpen,
  onToggle,
  onLogout,
  onNavigate,
}: {
  pathname: string;
  onCmdK: () => void;
  userInitials: string;
  userName: string;
  userRole: string;
  sections: NavSection[];
  isOpen: boolean;
  onToggle: () => void;
  onLogout: () => void;
  onNavigate?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  return (
    <aside className={`wms-sb ${isOpen ? "is-open" : ""}`}>
      <div className="wms-sb-hd">
        <div className="wms-sb-brand">
          <button
            type="button"
            className="wms-sb-toggle"
            aria-label={isOpen ? "Recolher menu" : "Abrir menu"}
            onClick={onToggle}
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
          <Link href="/wms" className="wms-sb-logo" onClick={() => onNavigate?.()}>
            <div className="wms-sb-logo-mark">N</div>
            <div className="wms-sb-logo-text">
              <div className="wms-sb-logo-name">NetAir WMS</div>
              <div className="wms-sb-logo-org">SISO</div>
            </div>
          </Link>
        </div>
        <SidebarGalpaoSwitcher />
        <button className="wms-sb-cmd" onClick={onCmdK}>
          <Icon name="search" size={12} />
          <span>Buscar</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
      <nav className="wms-sb-nav">
        {sections.map((sec) => (
          <div key={sec.id} className="wms-sb-sect">
            <div className="wms-sb-sect-lbl">{sec.label}</div>
            {sec.itens.map((n) => {
              const active = isActive(pathname, n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`wms-sb-item ${active ? "is-active" : ""}`}
                  onClick={() => onNavigate?.()}
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
      <div className="wms-sb-ft" ref={menuRef}>
        {menuOpen && (
          <div className="wms-sb-user-menu" role="menu">
            <button
              type="button"
              className="wms-sb-user-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onLogout();
              }}
            >
              <LogOut size={14} />
              <span>Sair</span>
            </button>
          </div>
        )}
        <button
          type="button"
          className="wms-sb-user"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <div className="wms-sb-avatar">{userInitials}</div>
          <div className="wms-sb-user-info">
            <div className="wms-sb-user-name">{userName}</div>
            <div className="wms-sb-user-role">{userRole}</div>
          </div>
        </button>
      </div>
    </aside>
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
  const { user, loading, logout } = useAuth();
  const { permissoes } = usePermissoes();

  const [ckOpen, setCkOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // "receber" não é mais modal — é navegação pra /wms/receber. State guarda
  // apenas os modais que de fato renderizam aqui.
  const [modal, setModal] = useState<{
    kind: Exclude<ModalKind, null | "receber">;
    seed?: ModalSeed;
  } | null>(null);

  // Hidrata do localStorage no mount (a decisão do operador persiste entre rotas e reloads
  // — mas só no desktop; no mobile a sidebar começa sempre fechada pra não invadir a tela)
  useEffect(() => {
    try {
      if (window.matchMedia("(max-width: 720px)").matches) return;
      const saved = window.localStorage.getItem("wms-sidebar-open");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved === "1") setSidebarOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  // Persiste sempre que muda (não persiste no mobile pra preservar preferência do desktop)
  useEffect(() => {
    try {
      if (window.matchMedia("(max-width: 720px)").matches) return;
      window.localStorage.setItem("wms-sidebar-open", sidebarOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [sidebarOpen]);

  const openModal = useCallback(
    (kind: Exclude<ModalKind, null>, seed?: ModalSeed) => {
      // "receber" deixou de ser modal: navega pra tela única de lote
      // (pré-seleciona o produto se vier de um drawer/linha de estoque)
      if (kind === "receber") {
        const produtoId = seed?.produto?.id;
        router.push(
          produtoId
            ? `/wms/receber?produto_id=${produtoId}`
            : "/wms/receber",
        );
        return;
      }
      setModal({ kind, seed });
    },
    [router],
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

  const closeSidebarIfMobile = () => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches) {
      setSidebarOpen(false);
    }
  };

  return (
    <ModalContext.Provider value={ctxValue}>
      <div className="wms-root">
        <div className={`wms-app ${sidebarOpen ? "is-sidebar-open" : ""}`}>
          {/* Botão flutuante visível apenas no mobile (via CSS) */}
          <button
            type="button"
            className="wms-mobile-toggle"
            aria-label="Abrir menu"
            onClick={() => setSidebarOpen(true)}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M3 6h14M3 10h14M3 14h14" />
            </svg>
          </button>
          {/* Backdrop mobile — fecha sidebar ao tocar */}
          <div
            className="wms-sb-backdrop"
            aria-hidden
            onClick={() => setSidebarOpen(false)}
          />
          <Sidebar
            pathname={pathname}
            onCmdK={() => setCkOpen(true)}
            userInitials={initials}
            userName={user.nome}
            userRole={role}
            sections={filterNavForUser(permissoes)}
            isOpen={sidebarOpen}
            onToggle={() => setSidebarOpen((o) => !o)}
            onLogout={() => {
              logout();
              router.replace("/login");
            }}
            onNavigate={closeSidebarIfMobile}
          />
          <div className="wms-main">
            <div className="wms-view">{children}</div>
          </div>

          <CommandK
            open={ckOpen}
            onClose={() => setCkOpen(false)}
            router={router}
            onAction={openModal}
          />

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
