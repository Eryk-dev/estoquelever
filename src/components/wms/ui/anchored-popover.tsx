"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

interface Coords {
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  minWidth?: number;
}

/**
 * Popover ancorado a um trigger, renderizado via portal pro <body>.
 *
 * Por que portal: popover `position: absolute` dentro de uma tabela/card com
 * `overflow: hidden` (ex: `.wms-tbl`) ou dentro de um ancestral com `transform`
 * fica CLIPADO ou preso abaixo da camada certa. Portalizando pro body e
 * posicionando via `getBoundingClientRect` (coords de viewport, `position:
 * fixed`), o popover escapa de qualquer stacking/clipping de ancestral e usa o
 * z-index canônico `--wms-z-popover` (acima de modais).
 *
 * Dono de: posicionamento (com flip/clamp pra caber na viewport), clique-fora,
 * Esc e reposição em scroll/resize. O caller NÃO deve duplicar essa lógica.
 */
export function AnchoredPopover({
  anchorRef,
  open,
  onClose,
  placement = "bottom-start",
  gap = 4,
  matchAnchorWidth = false,
  className,
  style,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: Placement;
  gap?: number;
  /** minWidth = largura do anchor (útil pra dropdowns de input). */
  matchAnchorWidth?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const a = anchorRef.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pop = popRef.current;
      const ph = pop?.offsetHeight ?? 0;
      const pw = pop?.offsetWidth ?? 0;

      // Flip vertical se não couber no lado pedido mas couber no oposto.
      let vertical: "bottom" | "top" = placement.startsWith("bottom")
        ? "bottom"
        : "top";
      if (vertical === "bottom" && r.bottom + gap + ph > vh - 8 && r.top - gap - ph > 8) {
        vertical = "top";
      } else if (vertical === "top" && r.top - gap - ph < 8 && r.bottom + gap + ph < vh - 8) {
        vertical = "bottom";
      }

      const next: Coords = {};
      if (vertical === "bottom") next.top = Math.round(r.bottom + gap);
      else next.bottom = Math.round(vh - r.top + gap);

      if (placement.endsWith("end")) {
        // Alinha bordas direitas; clamp pra não vazar à esquerda.
        next.right = Math.min(Math.max(8, Math.round(vw - r.right)), vw - 8);
      } else {
        let left = Math.round(r.left);
        if (pw && left + pw > vw - 8) left = Math.max(8, vw - 8 - pw);
        next.left = left;
      }
      if (matchAnchorWidth) next.minWidth = Math.round(r.width);
      setCoords(next);
    };
    compute();
    // capture=true pega scroll de qualquer container ancestral, não só window.
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open, placement, gap, matchAnchorWidth, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!mounted || !open) return null;

  return createPortal(
    // display:contents re-estabelece o escopo de tokens .wms-root sem criar um
    // box (que viraria containing block e quebraria o position:fixed do filho).
    <div className="wms-root" style={{ display: "contents" }}>
      <div
        ref={popRef}
        className={cn("wms-anchored-pop", className)}
        style={{
          ...style,
          position: "fixed",
          visibility: coords ? "visible" : "hidden",
          ...coords,
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
