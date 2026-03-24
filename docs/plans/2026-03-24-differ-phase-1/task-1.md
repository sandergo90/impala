# Task 1: Scaffold Tauri + React App

**Plan:** Differ Phase 1 — Walking Skeleton
**Goal:** Create a Tauri v2 app with React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui (Base UI), @pierre/diffs, and Zustand — all configured and building.
**Depends on:** none

**Files:**

- Create: Full project structure at `/Users/sander/Projects/differ/differ/`
- Key files: `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `components.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`

**Steps:**

1. Scaffold the Tauri app with React + TypeScript template. Run from the project root (`/Users/sander/Projects/differ/differ/`):

```bash
bun create tauri-app . --template react-ts --manager bun
```

If the interactive CLI doesn't accept those flags, run it interactively and select: TypeScript, bun, React, TypeScript.

**Important:** The project root already has a `.git` directory. The scaffold should create files inside the existing directory. If the CLI insists on a fresh directory, scaffold into a temp directory and move files back.

2. Verify the scaffold built correctly:

```bash
cd /Users/sander/Projects/differ/differ && bun install && bun run tauri dev
```

Expected: A Tauri window opens with the default React template. Close it after confirming.

3. Install frontend dependencies:

```bash
bun add @pierre/diffs zustand
```

4. Set up Tailwind CSS. Install Tailwind and its Vite plugin:

```bash
bun add -D tailwindcss @tailwindcss/vite
```

Update `vite.config.ts` to include the Tailwind plugin:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
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
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
```

Create `src/index.css` (or update the existing one) with:

```css
@import "tailwindcss";
```

Make sure `src/main.tsx` imports this CSS file.

5. Set up shadcn/ui with Base UI primitives. Run the shadcn init command:

```bash
bunx shadcn@latest init --base base
```

During init, accept defaults. This creates a `components.json` file configured for Base UI primitives and sets up the `src/components/ui/` directory.

Verify `components.json` exists and has `"base": "base"` or similar Base UI configuration.

6. Update `src-tauri/tauri.conf.json` to set the app identifier and name:

```json
{
  "identifier": "com.differ.app",
  "productName": "Differ"
}
```

Find these fields in the existing config and update them (don't replace the whole file).

7. Add the Tauri shell plugin for executing git commands. From `src-tauri/`:

```bash
cd /Users/sander/Projects/differ/differ/src-tauri && cargo add tauri-plugin-shell
```

And install the frontend bindings:

```bash
cd /Users/sander/Projects/differ/differ && bun add @tauri-apps/plugin-shell
```

Register the plugin in `src-tauri/src/lib.rs`:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Add shell permissions to `src-tauri/capabilities/default.json`. Add these to the `permissions` array:

```json
"shell:allow-execute",
"shell:allow-spawn"
```

8. Replace `src/App.tsx` with a minimal placeholder to verify everything works together:

```tsx
function App() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <div className="w-56 border-r p-4">Sidebar</div>
      <div className="w-64 border-r p-4">Commits</div>
      <div className="flex-1 p-4">Diff View</div>
    </div>
  );
}

export default App;
```

9. Verify the full setup:

```bash
cd /Users/sander/Projects/differ/differ && bun run tauri dev
```

Expected: A Tauri window opens showing three panels side by side with Tailwind styling applied (background colors, border between panels). Close after confirming.

10. Verify TypeScript compiles cleanly:

```bash
cd /Users/sander/Projects/differ/differ && bun run build
```

Expected: No TypeScript errors. Tauri build may warn about signing, that's fine.

11. Commit:

```bash
cd /Users/sander/Projects/differ/differ
git add -A
git commit -m "feat: scaffold Tauri v2 app with React, Tailwind, shadcn/ui, and Pierre diffs"
```

**Done When:**

- [ ] `bun run tauri dev` opens a window with three-panel layout
- [ ] Tailwind classes render correctly
- [ ] shadcn/ui with Base UI is initialized (`components.json` exists)
- [ ] `@pierre/diffs` and `zustand` are in `package.json`
- [ ] Tauri shell plugin registered and permitted
- [ ] TypeScript compiles without errors
- [ ] Committed
