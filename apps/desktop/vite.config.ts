import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import pkg from "./package.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: "impala-desktop",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: { name: `impala@${pkg.version}` },
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
  },
  build: {
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  worker: {
    format: "es",
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },
}));
