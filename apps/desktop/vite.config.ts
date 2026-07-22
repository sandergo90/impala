import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import pkg from "./package.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;

const vendorChunkName = (moduleId: string) => {
  const packagePath = moduleId.replaceAll("\\", "/").split("/node_modules/").at(-1);
  if (!packagePath) return null;

  const [scopeOrName, scopedName, ...modulePath] = packagePath.split("/");
  if (scopeOrName === "@shikijs" && scopedName === "langs") {
    const moduleName = modulePath.join("-").replaceAll(/[^a-zA-Z0-9_-]/g, "-");
    return `vendor-shikijs-langs-${moduleName}`;
  }

  const packageName = scopeOrName.startsWith("@")
    ? `${scopeOrName.slice(1)}-${scopedName}`
    : scopeOrName;

  return `vendor-${packageName.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
};

export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: "impala",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: { name: `impala@${pkg.version}` },
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
  },
  build: {
    modulePreload: false,
    sourcemap: true,
    rolldownOptions: {
      preserveEntrySignatures: "allow-extension",
      output: {
        codeSplitting: {
          groups: [
            {
              name: vendorChunkName,
              test: /node_modules[\\/]/,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // CodeMirror breaks (silently loses syntax highlighting) when more than one
    // copy of its core packages is bundled, because it relies on facet /
    // NodeProp identity. Package bumps left the direct deps ahead of the
    // @codemirror/lang-* transitive pins, so force a single copy of each.
    // https://codemirror.net/docs/faq/#multiple-instances
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/search",
      "@codemirror/autocomplete",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
    ],
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
