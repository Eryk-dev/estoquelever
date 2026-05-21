"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useCallback,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Cargo, UserGalpao } from "@/types";
import type { PermissaoCodigo } from "@/lib/permissions";

interface AuthUser {
  id: string;
  nome: string;
  cargo: Cargo;
  cargos: Cargo[];
  roles: Array<{ id: string; codigo: string; nome: string }>;
  permissoes: string[];     // serializável (Set não é) — hook usePermissoes converte pra Set
  sessionId?: string;
  galpoes: UserGalpao[];
}

interface AuthContextValue {
  user: AuthUser | null;
  sessionId: string | null;
  loading: boolean;
  /** Currently active galpão ID (null = all galpões / admin view) */
  activeGalpaoId: string | null;
  /** Name of the active galpão (null when viewing all) */
  activeGalpaoNome: string | null;
  /** Set the active galpão for filtering. Pass null for "all". */
  setActiveGalpao: (galpaoId: string | null) => void;
  login: (nome: string, pin: string) => Promise<{ ok: boolean; erro?: string }>;
  logout: () => void;
  /**
   * Re-busca o usuário em /api/auth/me e atualiza state + localStorage.
   * Use após criar/editar galpão pra refletir a lista nova no seletor sem
   * exigir logout. Re-valida activeGalpaoId contra a nova lista (limpa se
   * sumiu).
   */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "siso_user";
const GALPAO_KEY = "siso_active_galpao";

function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;

    const parsed = JSON.parse(stored) as AuthUser | null;
    if (!parsed?.sessionId) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(GALPAO_KEY);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function getStoredGalpaoId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(GALPAO_KEY);
  } catch {
    return null;
  }
}

/** Validate that stored galpaoId is still in the user's allowed galpões */
function validateGalpaoId(galpaoId: string | null, galpoes: UserGalpao[]): string | null {
  if (!galpaoId) return null;
  if (galpoes.some((g) => g.id === galpaoId)) return galpaoId;
  return null;
}

function isAdmin(cargos: Cargo[]): boolean {
  return cargos.includes("admin");
}

function resolveInitialGalpaoId(
  galpoes: UserGalpao[],
  cargos: Cargo[],
  storedGalpaoId: string | null,
): string | null {
  if (galpoes.length === 0) return null;

  const validStoredGalpaoId = validateGalpaoId(storedGalpaoId, galpoes);
  if (validStoredGalpaoId) return validStoredGalpaoId;

  if (galpoes.length === 1) return galpoes[0].id;

  return isAdmin(cargos) ? null : galpoes[0].id;
}

// Hydration gate: server=false, client=true (no mismatch via useSyncExternalStore)
const noop = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(getStoredUser);
  const [activeGalpaoId, setActiveGalpaoIdState] = useState<string | null>(() => {
    const stored = getStoredUser();
    const storedGalpao = getStoredGalpaoId();
    const cargos = stored?.cargos?.length ? stored.cargos : stored?.cargo ? [stored.cargo] : [];
    return stored
      ? resolveInitialGalpaoId(stored.galpoes ?? [], cargos, storedGalpao)
      : null;
  });
  const hydrated = useHydrated();
  const loading = !hydrated;

  const setActiveGalpao = useCallback((galpaoId: string | null) => {
    const cargos = user?.cargos?.length ? user.cargos : user?.cargo ? [user.cargo] : [];
    const nextGalpaoId = resolveInitialGalpaoId(
      user?.galpoes ?? [],
      cargos,
      galpaoId,
    );

    setActiveGalpaoIdState(nextGalpaoId);
    if (nextGalpaoId) {
      localStorage.setItem(GALPAO_KEY, nextGalpaoId);
    } else {
      localStorage.removeItem(GALPAO_KEY);
    }

    queryClient.invalidateQueries();
  }, [queryClient, user]);

  const activeGalpaoNome = user?.galpoes?.find((g) => g.id === activeGalpaoId)?.nome ?? null;

  const login = useCallback(async (nome: string, pin: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, pin }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, erro: data.erro ?? "Erro ao fazer login" };
    }
    const cargos: Cargo[] = data.usuario.cargos ?? [data.usuario.cargo];
    const galpoes: UserGalpao[] = data.usuario.galpoes ?? [];
    const authUser: AuthUser = {
      id: data.usuario.id,
      nome: data.usuario.nome,
      cargo: cargos[0],
      cargos,
      roles: data.usuario.roles ?? [],
      permissoes: data.usuario.permissoes ?? [],
      galpoes,
      ...(data.sessionId && { sessionId: data.sessionId }),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authUser));
    setUser(authUser);

    const storedGalpao = getStoredGalpaoId();
    const initialGalpao = resolveInitialGalpaoId(galpoes, cargos, storedGalpao);
    setActiveGalpaoIdState(initialGalpao);
    if (initialGalpao) {
      localStorage.setItem(GALPAO_KEY, initialGalpao);
    } else {
      localStorage.removeItem(GALPAO_KEY);
    }

    queryClient.invalidateQueries();

    return { ok: true };
  }, [queryClient]);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(GALPAO_KEY);
    setUser(null);
    setActiveGalpaoIdState(null);
    queryClient.clear();
  }, [queryClient]);

  const refreshUser = useCallback(async () => {
    const stored = getStoredUser();
    if (!stored?.sessionId) return;

    try {
      const res = await fetch("/api/auth/me", {
        headers: { "X-Session-Id": stored.sessionId },
      });
      if (!res.ok) {
        // 401 será tratado pelo sisoFetch em chamadas regulares; aqui só
        // ignoramos pra não disparar logout fantasma se /me retornar 401
        // por causa de race condition.
        return;
      }
      const data = await res.json();
      const cargos: Cargo[] = data.usuario.cargos ?? [data.usuario.cargo];
      const galpoes: UserGalpao[] = data.usuario.galpoes ?? [];
      const updated: AuthUser = {
        id: data.usuario.id,
        nome: data.usuario.nome,
        cargo: cargos[0],
        cargos,
        roles: data.usuario.roles ?? [],
        permissoes: data.usuario.permissoes ?? [],
        galpoes,
        sessionId: stored.sessionId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      setUser(updated);

      // Re-valida activeGalpaoId contra a nova lista
      const currentGalpao = getStoredGalpaoId();
      const next = resolveInitialGalpaoId(galpoes, cargos, currentGalpao);
      setActiveGalpaoIdState(next);
      if (next) {
        localStorage.setItem(GALPAO_KEY, next);
      } else {
        localStorage.removeItem(GALPAO_KEY);
      }

      queryClient.invalidateQueries();
    } catch {
      // network error — silencioso, próxima tentativa do user resolve
    }
  }, [queryClient]);

  // Auto-refresh do user (galpoes, cargos, ativo) uma vez por sessão de aba.
  // Sem isso, o localStorage cacheia user.galpoes do último login e galpões
  // criados depois ficam invisíveis no seletor até relogar/criar/editar algo.
  const didAutoRefresh = useRef(false);
  useEffect(() => {
    if (didAutoRefresh.current) return;
    if (!user?.sessionId) return;
    didAutoRefresh.current = true;
    void refreshUser();
  }, [user?.sessionId, refreshUser]);

  return (
    <AuthContext.Provider
      value={{
        user,
        sessionId: user?.sessionId ?? null,
        loading,
        activeGalpaoId,
        activeGalpaoNome,
        setActiveGalpao,
        login,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function usePermissoes() {
  const { user } = useAuth();
  const set = useMemo(() => new Set(user?.permissoes ?? []), [user?.permissoes]);
  const can = useCallback(
    (...required: PermissaoCodigo[]) =>
      required.length === 0 ? true : required.every((p) => set.has(p)),
    [set],
  );
  const canAny = useCallback(
    (...required: PermissaoCodigo[]) =>
      required.length > 0 && required.some((p) => set.has(p)),
    [set],
  );
  return { can, canAny, permissoes: set };
}

/**
 * Detect a 401 in any sisoFetch response and force a clean logout +
 * redirect to /login. Without this, an expired/revoked session leaves
 * the client in a zombie state: localStorage still has the user object
 * (so useAuth renders them as logged in) but every API call returns
 * 401 ({error: "unauthorized"}), and the UI shows error rows everywhere.
 *
 * Module-level flag prevents the redirect from firing multiple times
 * when several queries fail in parallel.
 */
let unauthorizedRedirectInFlight = false;

function urlPath(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.pathname;
  return url.url;
}

function isAuthEndpoint(url: string | URL | Request): boolean {
  return urlPath(url).includes("/api/auth/login");
}

function handleUnauthorized(): void {
  if (unauthorizedRedirectInFlight) return;
  if (typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/login")) return;

  unauthorizedRedirectInFlight = true;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(GALPAO_KEY);
  } catch {
    // localStorage unavailable (private mode quota, etc) — proceed to redirect anyway
  }
  window.location.replace("/login?reason=session-expired");
}

/**
 * Fetch wrapper that automatically adds X-Session-Id and X-Galpao-Id headers.
 * Falls back to regular fetch if no sessionId is stored.
 *
 * On 401 from any endpoint other than /api/auth/login, clears the stored
 * session and redirects to /login (see handleUnauthorized).
 */
export async function sisoFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const stored = getStoredUser();
  const sessionId = stored?.sessionId;

  let response: Response;
  if (!sessionId) {
    response = await fetch(url, init);
  } else {
    const headers = new Headers(init?.headers);
    headers.set("X-Session-Id", sessionId);

    // Send active galpão ID if stored
    const galpaoId = getStoredGalpaoId();
    if (galpaoId) {
      headers.set("X-Galpao-Id", galpaoId);
    }

    response = await fetch(url, { ...init, headers });
  }

  if (response.status === 401 && !isAuthEndpoint(url)) {
    handleUnauthorized();
  }

  return response;
}
