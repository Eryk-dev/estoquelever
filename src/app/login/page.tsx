"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

export default function LoginPage() {
  const { user, loading: authLoading, login } = useAuth();
  const router = useRouter();
  const [nome, setNome] = useState("");
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");
  const pinRef = useRef<HTMLInputElement>(null);

  // Redirect if already logged in
  useEffect(() => {
    if (!authLoading && user) {
      router.replace("/");
    }
  }, [user, authLoading, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!nome.trim() || pin.length !== 4) return;

    setLoading(true);
    setErro("");

    const result = await login(nome.trim(), pin);

    if (result.ok) {
      toast.success(`Bem-vindo, ${nome.trim()}!`);
      router.replace("/");
    } else {
      setErro(result.erro ?? "Erro ao fazer login");
      setPin("");
      pinRef.current?.focus();
    }

    setLoading(false);
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (user) return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm animate-fade-in">
        {/* Logo */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            SISO
          </h1>
          <p className="mt-1 text-sm text-zinc-400 dark:text-zinc-500">
            Separação de Ordens
          </p>
        </div>

        {/* Login card */}
        <form
          onSubmit={handleSubmit}
          className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700/60 dark:bg-zinc-900"
        >
          <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
            <Lock className="h-4 w-4 text-zinc-400" />
            <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
              Entrar
            </span>
          </div>

          <div className="space-y-4 px-5 py-5">
            {/* Nome */}
            <div>
              <label
                htmlFor="nome"
                className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400"
              >
                Nome
              </label>
              <input
                id="nome"
                type="text"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Seu nome"
                autoComplete="username"
                autoFocus
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-700 outline-none transition-colors focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:focus:border-zinc-500"
              />
            </div>

            {/* PIN */}
            <div>
              <label
                htmlFor="pin"
                className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400"
              >
                PIN (4 dígitos)
              </label>
              <input
                id="pin"
                ref={pinRef}
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "").slice(0, 4);
                  setPin(v);
                  setErro("");
                }}
                placeholder="0000"
                autoComplete="current-password"
                className={cn(
                  "w-full rounded-lg border bg-zinc-50 px-3 py-2.5 text-center font-mono text-lg tracking-[0.5em] text-zinc-700 outline-none transition-colors focus:ring-1 dark:bg-zinc-800 dark:text-zinc-300",
                  erro
                    ? "border-red-300 focus:border-red-400 focus:ring-red-400 dark:border-red-700"
                    : "border-zinc-200 focus:border-zinc-400 focus:ring-zinc-400 dark:border-zinc-700 dark:focus:border-zinc-500",
                )}
              />
            </div>

            {/* Error */}
            {erro && (
              <p className="animate-shake text-center text-xs font-medium text-red-600 dark:text-red-400">
                {erro}
              </p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !nome.trim() || pin.length !== 4}
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-all",
                "bg-zinc-900 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
                "disabled:cursor-not-allowed disabled:opacity-30",
              )}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Entrando...
                </>
              ) : (
                "Entrar"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
