"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renderiza children no <body> via portal, re-aplicando o escopo de tokens
 * `.wms-root` (display:contents pra não criar containing block).
 *
 * Use em overlays/modais custom (que não usam o <Modal> compartilhado) pra
 * escaparem de ancestrais com overflow/transform que senão os prenderiam
 * abaixo da camada certa. `mounted` evita mismatch de hidratação — createPortal
 * só roda no cliente.
 */
export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div className="wms-root" style={{ display: "contents" }}>
      {children}
    </div>,
    document.body,
  );
}
