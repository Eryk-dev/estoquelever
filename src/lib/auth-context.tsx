"use client";

import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  useCallback,
  type ReactNode,
} from "react";
import type { Cargo } from "@/types";

interface AuthUser {
  id: string;
  nome: string;
  cargo: Cargo;
  cargos: Cargo[];
  sessionId?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  sessionId: string | null;
  loading: boolean;
  login: (nome: string, pin: string) => Promise<{ ok: boolean; erro?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "siso_user";

function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

// Hydration gate: server=false, client=true (no mismatch via useSyncExternalStore)
const noop = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(getStoredUser);
  const hydrated = useHydrated();
  const loading = !hydrated;

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
    const authUser: AuthUser = {
      id: data.usuario.id,
      nome: data.usuario.nome,
      cargo: cargos[0],
      cargos,
      ...(data.sessionId && { sessionId: data.sessionId }),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authUser));
    setUser(authUser);
    return { ok: true };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, sessionId: user?.sessionId ?? null, loading, login, logout }}>
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
 * Fetch wrapper that automatically adds X-Session-Id header from stored session.
 * Falls back to regular fetch if no sessionId is stored.
 */
export function sisoFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const stored = getStoredUser();
  const sessionId = stored?.sessionId;
  if (!sessionId) return fetch(url, init);

  const headers = new Headers(init?.headers);
  headers.set("X-Session-Id", sessionId);
  return fetch(url, { ...init, headers });
}
