import "./wms.css";
import { WmsShell } from "@/components/wms/wms-shell";

export default function WmsLayout({ children }: { children: React.ReactNode }) {
  return <WmsShell>{children}</WmsShell>;
}
