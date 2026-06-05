import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/wms/cenarios/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "src/lib/wms/_archive/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
