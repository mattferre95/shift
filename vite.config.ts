import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { formatBuildLabel, readBuildMetadata } from "./build/build-info";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const buildLabel = formatBuildLabel(readBuildMetadata(rootDir));

// Tauri drives this dev server; keep the port fixed and stay off src-tauri.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __SHIFT_BUILD_LABEL__: JSON.stringify(buildLabel) },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "safari15", sourcemap: false },
});
