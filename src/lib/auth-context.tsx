"use client";

import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  useCallback,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Cargo, UserGalpao } from "@/types";

interface AuthUser {
  id: string;
  nome: string;
  cargo: Cargo;
  cargos: Cargo[];
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
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "siso_user";
const GALPAO_KEY = "siso_active_galpao";

function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
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

/**
 * Fetch wrapper that automatically adds X-Session-Id and X-Galpao-Id headers.
 * Falls back to regular fetch if no sessionId is stored.
 */
export function sisoFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const stored = getStoredUser();
  const sessionId = stored?.sessionId;
  if (!sessionId) return fetch(url, init);

  const headers = new Headers(init?.headers);
  headers.set("X-Session-Id", sessionId);

  // Send active galpão ID if stored
  const galpaoId = getStoredGalpaoId();
  if (galpaoId) {
    headers.set("X-Galpao-Id", galpaoId);
  }

  return fetch(url, { ...init, headers });
}
