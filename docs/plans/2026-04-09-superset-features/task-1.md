# Task 1: Shared File-Path Resolution Layer

**Plan:** Superset Feature Adoption
**Goal:** Upgrade the Rust `open_in_editor` command to support file+line:col, add a `resolve_file_path` command, and create TypeScript helpers for parsing file paths and opening files.
**Depends on:** none

**Files:**

- Modify: `backend/tauri/src/lib.rs:414-439` (upgrade `open_in_editor` command)
- Create: `apps/desktop/src/lib/file-link-parser.ts` (regex-based file path parser)
- Create: `apps/desktop/src/lib/open-file-in-editor.ts` (shared helper wrapping the Tauri command)
- Modify: `apps/desktop/src/components/OpenInEditorButton.tsx` (use new shared helper)

**Steps:**

1. Upgrade the `open_in_editor` Rust command to accept optional `line` and `col` parameters, and format editor-specific CLI arguments:

In `backend/tauri/src/lib.rs`, replace the `open_in_editor` function (lines 414-439) with:

```rust
#[tauri::command]
async fn open_in_editor(
    editor: String,
    path: String,
    line: Option<u32>,
    col: Option<u32>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let (app_name, use_cli) = match editor.as_str() {
            "cursor" => ("Cursor", true),
            "vscode" => ("Visual Studio Code", true),
            "zed" => ("Zed", true),
            "webstorm" => ("WebStorm", false),
            "sublime" => ("Sublime Text", true),
            _ => return Err(format!("Unknown editor: {}", editor)),
        };

        let output = if let Some(ln) = line {
            let col = col.unwrap_or(1);
            match editor.as_str() {
                "cursor" | "vscode" => {
                    // Use CLI: cursor/code --goto path:line:col
                    let cli = if editor == "cursor" { "cursor" } else { "code" };
                    std::process::Command::new(cli)
                        .arg("--goto")
                        .arg(format!("{}:{}:{}", path, ln, col))
                        .output()
                        .map_err(|e| format!("Failed to launch {}: {}", app_name, e))?
                }
                "zed" => {
                    std::process::Command::new("zed")
                        .arg(format!("{}:{}:{}", path, ln, col))
                        .output()
                        .map_err(|e| format!("Failed to launch Zed: {}", e))?
                }
                "sublime" => {
                    std::process::Command::new("subl")
                        .arg(format!("{}:{}:{}", path, ln, col))
                        .output()
                        .map_err(|e| format!("Failed to launch Sublime Text: {}", e))?
                }
                "webstorm" => {
                    std::process::Command::new("open")
                        .arg("-a")
                        .arg(app_name)
                        .arg("--args")
                        .arg("--line")
                        .arg(ln.to_string())
                        .arg("--column")
                        .arg(col.to_string())
                        .arg(&path)
                        .output()
                        .map_err(|e| format!("Failed to launch WebStorm: {}", e))?
                }
                _ => unreachable!(),
            }
        } else {
            // No line number — use macOS `open -a` as before
            std::process::Command::new("open")
                .arg("-a")
                .arg(app_name)
                .arg(&path)
                .output()
                .map_err(|e| format!("Failed to launch {}: {}", app_name, e))?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to open {}: {}", app_name, stderr.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
```

2. Add the `resolve_file_path` Tauri command in the same file. Add it after the `open_in_editor` function, and register it in the `invoke_handler` builder (search for `.invoke_handler(tauri::generate_handler![` and add `resolve_file_path` to the list):

```rust
#[tauri::command]
fn resolve_file_path(base_dir: String, candidate: String) -> Result<(String, bool), String> {
    let candidate = candidate.trim();

    // Try as absolute path first
    let abs = if candidate.starts_with('/') {
        std::path::PathBuf::from(candidate)
    } else if candidate.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(&candidate[2..])
        } else {
            std::path::Path::new(&base_dir).join(candidate)
        }
    } else {
        // Strip leading ./ if present
        let clean = candidate.strip_prefix("./").unwrap_or(candidate);
        std::path::Path::new(&base_dir).join(clean)
    };

    let exists = abs.exists();
    Ok((abs.to_string_lossy().to_string(), exists))
}
```

Note: check if `dirs` crate is already a dependency in `backend/tauri/Cargo.toml`. If not, add it:

Run: `grep -q '^dirs' backend/tauri/Cargo.toml && echo "already present" || echo "needs adding"`

If it needs adding, run: `cd backend/tauri && cargo add dirs`

3. Create the TypeScript file path parser:

Create `apps/desktop/src/lib/file-link-parser.ts`:

```typescript
export interface FileLink {
  path: string;
  line?: number;
  col?: number;
  startIndex: number;
  endIndex: number;
}

// Standard path:line:col — covers TypeScript, Rust, Go, ESLint, Vite, Jest, grep
const STANDARD_RE = /((?:\.?\.?\/)?[\w@./-]+\.\w+)(?::(\d+)(?::(\d+))?)?/g;

// Python tracebacks: File "path", line N
const PYTHON_RE = /File "([^"]+)", line (\d+)/g;

// Parenthesized: path(line,col) or path(line) — MSBuild, C#
const PAREN_RE = /((?:\.?\.?\/)?[\w@./-]+\.\w+)\((\d+)(?:,(\d+))?\)/g;

export function parseFileLinks(text: string): FileLink[] {
  const links: FileLink[] = [];
  const seen = new Set<string>();

  function addMatch(re: RegExp) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const path = m[1];
      // Skip very short matches (likely false positives like "e.g.")
      if (path.length < 3 || !path.includes("/") && !path.includes(".")) continue;
      // Skip URLs
      if (text.slice(Math.max(0, m.index - 8), m.index).match(/https?:\/\/$/)) continue;

      const key = `${m.index}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      links.push({
        path,
        line: m[2] ? parseInt(m[2], 10) : undefined,
        col: m[3] ? parseInt(m[3], 10) : undefined,
        startIndex: m.index,
        endIndex: m.index + m[0].length,
      });
    }
  }

  addMatch(PYTHON_RE);
  addMatch(PAREN_RE);
  addMatch(STANDARD_RE);

  // Sort by position, deduplicate overlaps
  links.sort((a, b) => a.startIndex - b.startIndex);
  return links.filter(
    (link, i) => i === 0 || link.startIndex >= links[i - 1].endIndex
  );
}
```

4. Create the shared `openFileInEditor` helper:

Create `apps/desktop/src/lib/open-file-in-editor.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore } from "../store";

export async function openFileInEditor(
  path: string,
  line?: number,
  col?: number,
): Promise<void> {
  const editor = useUIStore.getState().preferredEditor || "cursor";
  try {
    await invoke("open_in_editor", { editor, path, line: line ?? null, col: col ?? null });
  } catch (e) {
    toast.error(String(e));
  }
}
```

5. Migrate `OpenInEditorButton.tsx` to use the shared helper. Replace the `handleOpen` function body (lines 39-52) to use `openFileInEditor`:

In `apps/desktop/src/components/OpenInEditorButton.tsx`, add the import at the top:

```typescript
import { openFileInEditor } from "../lib/open-file-in-editor";
```

Then replace the `handleOpen` function (lines 39-52):

```typescript
  const handleOpen = async (editorId: string) => {
    setLoading(true);
    setOpen(false);
    try {
      // Use the shared helper but with explicit editor choice
      await invoke("open_in_editor", { editor: editorId, path: worktreePath, line: null, col: null });
      if (editorId !== preferredEditor) {
        setPreferredEditor(editorId);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  };
```

6. Verify the build compiles:

Run: `cd /Users/sander/Projects/canopy && cargo check -p canopy-desktop 2>&1 | tail -20`
Expected: no errors related to `open_in_editor` or `resolve_file_path`

Run: `cd /Users/sander/Projects/canopy && bun run --filter desktop typecheck 2>&1 | tail -20`
Expected: no TypeScript errors

7. Commit:

```bash
git add backend/tauri/src/lib.rs apps/desktop/src/lib/file-link-parser.ts apps/desktop/src/lib/open-file-in-editor.ts apps/desktop/src/components/OpenInEditorButton.tsx
git commit -m "feat: shared file-path resolution layer with line:col support

Upgrade open_in_editor to accept line/col for all editors.
Add resolve_file_path Tauri command with path validation.
Add file-link-parser.ts for regex-based path detection.
Add openFileInEditor() shared helper."
```

**Done When:**

- [ ] `open_in_editor` accepts `line` and `col` parameters and formats correctly per editor
- [ ] `resolve_file_path` resolves relative/absolute/home paths and checks existence
- [ ] `file-link-parser.ts` correctly parses standard `path:line:col`, Python, and parenthesized formats
- [ ] `openFileInEditor()` helper reads preferred editor from store and invokes Tauri command
- [ ] `OpenInEditorButton` continues to work as before (passes `null` for line/col)
- [ ] Rust and TypeScript builds pass
- [ ] Committed
