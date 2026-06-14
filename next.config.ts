import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // zxing-wasm (decode de barcodes de etiqueta raster Shopee) carrega seu .wasm
  // via node_modules em runtime — mantém como external pra não ser bundlado e
  // garante que o binário entre no trace do output standalone.
  serverExternalPackages: ["zxing-wasm"],
  outputFileTracingIncludes: {
    "/**": ["./node_modules/zxing-wasm/dist/reader/zxing_reader.wasm"],
  },
};

export default nextConfig;
