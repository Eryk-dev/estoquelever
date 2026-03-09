import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SISO - Separação de Ordens",
  description:
    "Sistema Inteligente de Separação de Ordens — gerencie pedidos e estoque entre filiais.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body
        className={`${outfit.variable} ${jetbrainsMono.variable} antialiased bg-zinc-50 text-zinc-900`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
