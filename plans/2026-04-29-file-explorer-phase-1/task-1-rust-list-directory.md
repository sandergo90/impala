# Task 1: Rust `list_directory` command

**Plan:** File Explorer — Phase 1: Walking Skeleton
**Goal:** Expose a Tauri command that returns the immediate children of one directory inside a worktree, tagging each entry as `ignored` (via `.gitignore` rules) without filtering them out.
**Depends on:** none

**Files:**

- Create: `backend/tauri/src/file_tree.rs`
- Modify: `backend/tauri/src/lib.rs` — add `mod file_tree;` near the other module declarations and `file_tree::list_directory` to the `invoke_handler` list
- Modify: `backend/tauri/Cargo.toml` — add `ignore = "0.4"` under `[dependencies]`

**Background context the implementer needs:**

- All other Rust modules live as flat files in `backend/tauri/src/`. See `watcher.rs` for the canonical shape of a `#[tauri::command]` Rust file with state. We do not need state for this command.
- Module declarations in `lib.rs` are alphabetised at the top (currently lines 1-22). Add `mod file_tree;` between `mod daemon_client;` and `mod fonts;`.
- Handler registration is in `tauri::generate_handler![...]` starting at `lib.rs:1417`. Existing modules use the `module::function` syntax (e.g. `watcher::watch_worktree` at line 1495). Follow that pattern.
- The `ignore` crate is the standard Rust filesystem walker (used by `ripgrep`/`fd`). API docs: <https://docs.rs/ignore>. We use `WalkBuilder` for the walk and `gitignore::GitignoreBuilder` to compute the `ignored` flag per entry.

**Steps:**

1. **Add the dependency.** In `backend/tauri/Cargo.toml`, add this line in the `[dependencies]` block (alphabetical order; goes between `dirs = "6"` and `libc = "0.2"`):

   ```toml
   ignore = "0.4"
   ```

2. **Create `backend/tauri/src/file_tree.rs`** with this content:

   ```rust
   use ignore::gitignore::{Gitignore, GitignoreBuilder};
   use ignore::WalkBuilder;
   use serde::Serialize;
   use std::path::{Path, PathBuf};

   #[derive(Serialize, Clone, Debug)]
   #[serde(rename_all = "camelCase")]
   pub struct FsEntry {
       pub name: String,
       pub kind: &'static str,    // "file" | "directory" | "symlink"
       pub relative_path: String, // POSIX-style, relative to worktree root
       pub ignored: bool,
   }

   fn to_posix(path: &Path) -> String {
       path.components()
           .map(|c| c.as_os_str().to_string_lossy().into_owned())
           .collect::<Vec<_>>()
           .join("/")
   }

   fn build_gitignore(worktree_root: &Path) -> Gitignore {
       let mut builder = GitignoreBuilder::new(worktree_root);
       let _ = builder.add(worktree_root.join(".gitignore"));
       let _ = builder.add(worktree_root.join(".git/info/exclude"));
       builder.build().unwrap_or_else(|_| Gitignore::empty())
   }

   #[tauri::command]
   pub async fn list_directory(
       worktree_path: String,
       rel_dir: String,
   ) -> Result<Vec<FsEntry>, String> {
       tokio::task::spawn_blocking(move || {
           let root = PathBuf::from(&worktree_path);
           let target = if rel_dir.is_empty() {
               root.clone()
           } else {
               root.join(&rel_dir)
           };

           if !target.starts_with(&root) {
               return Err(format!("rel_dir escapes worktree: {}", rel_dir));
           }

           let gitignore = build_gitignore(&root);

           let mut entries: Vec<FsEntry> = Vec::new();
           let walker = WalkBuilder::new(&target)
               .max_depth(Some(1))
               .standard_filters(false)
               .hidden(false)
               .build();

           for dent in walker.filter_map(Result::ok) {
               // Skip the directory itself (max_depth(1) yields the root entry first).
               if dent.path() == target {
                   continue;
               }

               let path = dent.path();
               let name = match path.file_name() {
                   Some(n) => n.to_string_lossy().into_owned(),
                   None => continue,
               };

               // Always exclude .git unconditionally (we never want to surface it,
               // even if the user toggled "show ignored" on).
               if name == ".git" {
                   continue;
               }

               let file_type = dent.file_type();
               let kind: &'static str = match file_type {
                   Some(ft) if ft.is_dir() => "directory",
                   Some(ft) if ft.is_symlink() => "symlink",
                   Some(_) => "file",
                   None => "file",
               };

               let relative = path
                   .strip_prefix(&root)
                   .map_err(|e| format!("strip_prefix: {}", e))?;
               let relative_posix = to_posix(relative);

               let ignored = gitignore
                   .matched_path_or_any_parents(relative, kind == "directory")
                   .is_ignore();

               entries.push(FsEntry {
                   name,
                   kind,
                   relative_path: relative_posix,
                   ignored,
               });
           }

           // Directories first, then files; alphabetical within each group.
           entries.sort_by(|a, b| {
               match (a.kind == "directory", b.kind == "directory") {
                   (true, false) => std::cmp::Ordering::Less,
                   (false, true) => std::cmp::Ordering::Greater,
                   _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
               }
           });

           Ok(entries)
       })
       .await
       .map_err(|e| format!("Task join error: {}", e))?
   }
   ```

3. **Register the module.** In `backend/tauri/src/lib.rs`, find the module declarations at the top of the file (currently `mod agent_config;` through `mod worktrees;`, alphabetical). Insert `mod file_tree;` in alphabetical order — between `mod daemon_client;` and `mod fonts;`.

4. **Register the handler.** In `backend/tauri/src/lib.rs`, find the `tauri::generate_handler![...]` block at `lib.rs:1417`. Add `file_tree::list_directory,` to the list. Place it next to `watcher::watch_worktree` (around line 1495) for grouping with other module-prefixed commands.

5. **Compile.** Run from the repo root:

   ```bash
   cd backend/tauri && cargo check
   ```

   Expected: builds clean (or warnings only). No errors.

6. **Smoke-test the command.** Run the dev app:

   ```bash
   bun run dev
   ```

   In the running app's webview, open devtools (right-click → Inspect, or ⌘⌥I), then run in the console:

   ```js
   await __TAURI__.core.invoke("list_directory", {
     worktreePath: "/Users/sander/Projects/impala",
     relDir: "",
   })
   ```

   Expected: an array of `FsEntry` objects with `name`, `kind`, `relativePath`, `ignored`. Confirm:
   - `apps`, `backend`, `docs`, `plans`, `scripts` appear as `kind: "directory"` with `ignored: false`.
   - `node_modules` (if present at root) appears with `ignored: true`.
   - `.git` does **not** appear.
   - `package.json`, `bun.lock`, `CLAUDE.md` appear as `kind: "file"`.

   Then test a subdirectory:

   ```js
   await __TAURI__.core.invoke("list_directory", {
     worktreePath: "/Users/sander/Projects/impala",
     relDir: "apps/desktop/src",
   })
   ```

   Expected: `components`, `hooks`, `lib`, `routes`, `stores`, `themes`, `views` as directories; `App.tsx`, `main.tsx`, `router.tsx`, `store.ts`, `types.ts`, `index.css`, `vite-env.d.ts` as files.

7. **Commit:**

   ```bash
   git add backend/tauri/Cargo.toml backend/tauri/Cargo.lock backend/tauri/src/file_tree.rs backend/tauri/src/lib.rs
   git commit -m "feat(file-tree): add list_directory tauri command"
   ```

**Done When:**

- [ ] `backend/tauri/src/file_tree.rs` exists with the module shown above
- [ ] `Cargo.toml` has `ignore = "0.4"`
- [ ] `lib.rs` declares `mod file_tree;` and registers `file_tree::list_directory`
- [ ] `cargo check` from `backend/tauri/` passes with no errors
- [ ] `invoke("list_directory", ...)` from the running dev app's devtools returns the expected children for both root and a subdirectory, with `ignored: true` on `node_modules`, no `.git` entry
- [ ] Changes committed
