import { defineConfig } from "vite";
import { resolve } from "node:path";

// Les plugins SiYuan sont chargés comme un module CommonJS `index.js`
// qui fait `require("siyuan")` : on produit ce format et on externalise `siyuan`.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["siyuan"],
      output: { exports: "default" },
    },
  },
});
