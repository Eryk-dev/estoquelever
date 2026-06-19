"use client";

import { useEffect, useState } from "react";
import { sisoFetch } from "@/lib/auth-context";

/**
 * Sinal leve "este SKU tem equivalentes no cross?" — usado pra só mostrar o
 * botão Equivalentes onde há equivalência de verdade (decisão Eryk 2026-06-14).
 * Fonte única: a ficha do caderno (/api/wms/cross/produtos/[sku]); tem cross =
 * equivalentes.length>0. Cache módulo-level + dedup de in-flight pra não
 * re-checar o mesmo SKU em vários cards na mesma sessão.
 */
const hasCrossCache = new Map<string, boolean>();
const inFlight = new Map<string, Promise<boolean>>();

async function checkHasCross(sku: string): Promise<boolean> {
  const cached = hasCrossCache.get(sku);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(sku);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const res = await sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}`,
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { equivalentes?: unknown[] };
      const has = (data.equivalentes?.length ?? 0) > 0;
      hasCrossCache.set(sku, has);
      return has;
    } catch {
      return false;
    } finally {
      inFlight.delete(sku);
    }
  })();

  inFlight.set(sku, promise);
  return promise;
}

/**
 * Retorna null enquanto carrega, depois true/false. O valor sai do cache
 * (derivado no render); o effect só dispara o fetch e força um re-render quando
 * ele resolve (setState no callback assíncrono, nunca síncrono no effect).
 */
export function useHasCross(sku: string | null | undefined): boolean | null {
  const [, bump] = useState(0);

  useEffect(() => {
    if (!sku) return;
    let vivo = true;
    void checkHasCross(sku).then(() => {
      if (vivo) bump((n) => n + 1);
    });
    return () => {
      vivo = false;
    };
  }, [sku]);

  if (!sku) return false;
  const cached = hasCrossCache.get(sku);
  return cached === undefined ? null : cached;
}
