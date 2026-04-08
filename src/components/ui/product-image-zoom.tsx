"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProductImageZoomProps {
  src: string;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
}

/**
 * Clickable product thumbnail that expands into a fullscreen overlay.
 * - Desktop: double-click to expand
 * - Mobile/tablet: single tap to expand
 */
export function ProductImageZoom({ src, alt, className, loading = "lazy" }: ProductImageZoomProps) {
  const [open, setOpen] = useState(false);
  const isTouchRef = useRef(false);

  useEffect(() => {
    // Detect touch device once
    isTouchRef.current = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  }, []);

  const handleClick = useCallback(() => {
    if (isTouchRef.current) {
      setOpen(true);
    }
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (!isTouchRef.current) {
      setOpen(true);
    }
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className={cn("cursor-zoom-in", className)}
        loading={loading}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      />

      {/* Fullscreen overlay */}
      {open && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <button
            className="absolute right-4 top-4 rounded-full bg-white/20 p-2 text-white hover:bg-white/30 transition-colors"
            onClick={() => setOpen(false)}
            aria-label="Fechar"
          >
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
