import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SISO",
};

export default function SisoLayout({ children }: { children: React.ReactNode }) {
  return children;
}
