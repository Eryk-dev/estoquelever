"use client";

import { useMemo } from "react";

/**
 * Avatar redondo do usuário. Mostra a foto se `fotoUrl` existir, senão
 * cai pras iniciais do nome com fundo colorido determinístico (hash do
 * nome → cor) pra ficar consistente entre sessões.
 *
 * Tamanhos pré-definidos pra evitar valores avulsos:
 *   - xs: 20 (chips, tooltips)
 *   - sm: 28 (listas densas)
 *   - md: 36 (cards de party)
 *   - lg: 48 (perfil)
 *   - xl: 72 (upload, tela de perfil)
 */
const SIZE_MAP = { xs: 20, sm: 28, md: 36, lg: 48, xl: 72 } as const;
type Size = keyof typeof SIZE_MAP;

const BG_PALETTE = [
  "#1e3a8a", // navy
  "#7c2d12", // burnt
  "#365314", // olive
  "#581c87", // purple
  "#831843", // wine
  "#0c4a6e", // teal
  "#713f12", // amber
  "#134e4a", // emerald
] as const;

function hashName(nome: string): number {
  let h = 0;
  for (let i = 0; i < nome.length; i++) {
    h = (h * 31 + nome.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0]!.slice(0, 2).toUpperCase();
  return (partes[0]![0]! + partes[partes.length - 1]![0]!).toUpperCase();
}

export interface AvatarProps {
  nome: string;
  fotoUrl?: string | null;
  size?: Size;
  /** ring sutil ao redor (útil pra destacar operador ativo) */
  ring?: boolean;
  /** título no hover; default = nome */
  title?: string;
}

export function Avatar({
  nome,
  fotoUrl,
  size = "md",
  ring = false,
  title,
}: AvatarProps) {
  const px = SIZE_MAP[size];
  const fontSize = Math.round(px * 0.42);
  const cor = useMemo(
    () => BG_PALETTE[hashName(nome) % BG_PALETTE.length],
    [nome],
  );
  const ini = useMemo(() => iniciais(nome), [nome]);

  const baseStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    fontWeight: 600,
    color: "#fff",
    fontSize,
    letterSpacing: 0.5,
    background: cor,
    boxShadow: ring
      ? "0 0 0 2px var(--wms-c-bg), 0 0 0 4px var(--wms-c-accent, #2563eb)"
      : undefined,
    userSelect: "none",
    lineHeight: 1,
  };

  return (
    <span style={baseStyle} title={title ?? nome}>
      {fotoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fotoUrl}
          alt={nome}
          width={px}
          height={px}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        ini
      )}
    </span>
  );
}
