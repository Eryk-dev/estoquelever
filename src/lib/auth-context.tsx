"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { Cargo, Usuario } from "@/types";

interface AuthUser {
  id: string;
  nome: string;
  cargo: Cargo;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (nome: string, pin: string) => Promise<{ ok: boolean; erro?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "siso_user";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setUser(JSON.parse(stored));
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

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
    const authUser: AuthUser = {
      id: data.usuario.id,
      nome: data.usuario.nome,
      cargo: data.usuario.cargo,
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
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
