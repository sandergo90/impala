# Settings Screen & Theme Support

## Overview

Add a full-page settings screen to Differ, starting with an Appearance page that provides theme support. Users can switch between built-in theme presets (with mini UI previews) and import custom themes via JSON files.

## Theme Data Model

Each theme — built-in or custom — is a plain TypeScript object:

```ts
interface Theme {
  id: string;              // "default-dark", "github-dark", or uuid for custom
  name: string;            // "Default Dark", "GitHub Dark"
  type: "dark" | "light";  // controls OS title bar style & fallback defaults
  author?: string;
  description?: string;
  ui: {
    background: string;    // app background
    foreground: string;    // primary text color
    primary: string;       // brand/accent color (buttons, active states, links)
    border: string;        // borders, separators, dividers
    accent: string;        // secondary accent (hover states, selections, highlights)
  };
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}
```

The `ui` section is intentionally minimal (5 tokens, matching superset's approach). A `resolveTheme(theme: Theme)` function derives the full set of ~30 CSS variables needed by the shadcn/Tailwind system:

- `card`, `popover`, `sidebar` — from `background` (same or slightly offset)
- `muted`, `secondary` — blended from `background` and `foreground`
- `*-foreground` variants — calculated for contrast against their parent
- `destructive` — a fixed red appropriate for the theme type
- `input`, `ring` — from `border` and `primary`
- `chart-*` — grayscale ramp derived from `background`/`foreground`
- `sidebar-primary` — from `primary`; `sidebar-accent`, `sidebar-border` — from their UI counterparts

This keeps custom themes simple to author (5 UI colors + terminal palette) while still producing the full CSS variable set the app needs.

The `terminal` keys map to the Ghostty `ITheme` interface — full ANSI 16-color palette plus background, foreground, cursor, and selection colors. UI and terminal colors are independent sections, like superset.

### Built-in Themes (4)

- **Default Dark** — derived from current dark mode values in `index.css`, terminal palette matching the current hardcoded Ghostty theme
- **Default Light** — derived from current light mode values in `index.css`, light terminal palette
- **GitHub Dark** — GitHub's dark color scheme with GitHub's terminal colors
- **GitHub Light** — GitHub's light color scheme with GitHub's terminal colors

Built-in themes are defined as constants in source code, not stored in the user's persisted state.

## Settings Screen

### Access

- Gear icon at the bottom of the existing sidebar
- Keyboard shortcut `Cmd+,`

### Routing

A `currentView: 'main' | 'settings'` field in `useUIStore`. When `'settings'`, `App.tsx` renders `<SettingsView />` instead of the resizable panel layout. No router library needed.

### Layout

Full-page view replacing the main app:

- **Title bar**: still visible, shows "Settings" centered, back button replaces sidebar toggle
- **Settings sidebar** (~200px): nav items with the active one highlighted
- **Content area**: scrollable pane to the right

### Settings Sidebar Nav Items

- **Appearance** — functional (theme picker)
- **General** — disabled placeholder
- **Editor** — disabled placeholder
- **Keyboard** — disabled placeholder
- **Terminal** — disabled placeholder

Disabled items are greyed out and non-clickable, signaling future expansion.

## Appearance Page

### Theme Grid

- Cards grouped under "Dark" and "Light" section headings
- 2-3 cards per row depending on content area width
- Each card is a **mini UI preview**: a small rendering of differ's layout (sidebar, diff area, commit panel) using the theme's actual colors as simple shapes
- Active theme shows a selection ring and radio indicator
- Clicking a card immediately applies the theme

### Custom Themes Section

Below the built-in themes:

- **"Import Theme" button** — dashed-border card that opens a native Tauri file dialog filtered to `.json`
- **"Download template" link** — saves a starter JSON file via Tauri save dialog, containing all tokens with values from Default Dark and `_comment_*` fields explaining each group
- Imported custom themes appear as cards in the same grid
- Custom theme cards show a trash icon on hover for deletion
- Deleting the active custom theme falls back to Default Dark

### JSON Import Format

Matches superset's approach. Accepts:
- A single theme object
- An array of theme objects
- An object with `{ themes: [...] }`

```json
{
  "id": "my-theme",
  "name": "My Custom Theme",
  "type": "dark",
  "author": "Sander",
  "ui": {
    "background": "#1a1a2e",
    "foreground": "#e0e0e0",
    "primary": "#7c6bf5",
    "border": "#333333",
    "accent": "#2a2a4e"
  },
  "terminal": {
    "background": "#1a1a2e",
    "foreground": "#e0e0e0",
    "cursor": "#c0c0c0",
    "red": "#ff6b6b",
    "green": "#51cf66"
  }
}
```

Both `ui` and `terminal` support partial overrides — missing values fall back to Default Dark or Default Light depending on `type`. Color values can be hex, rgb, hsl, or oklch strings.

### Validation

- `id` must be present and unique (no collision with built-in IDs)
- `name` and `type` ("dark" | "light") are required
- `ui` object must exist (can be partial)
- Toast notification on success ("Imported 2 themes") or error with details

## Theme Application

### Runtime

`applyTheme(theme: Theme)` first calls `resolveTheme(theme)` to expand the 5 UI tokens into the full ~30 CSS variable set, then sets each on `document.documentElement` via `style.setProperty()`. It also sets `data-theme-type="dark"|"light"` on `<html>`, replacing the current `.dark` class system. The `theme.terminal` object is passed directly to Ghostty's `setTheme()` method on the terminal instance.

### Persistence

`useUIStore` gets two new fields:

- `activeThemeId: string` — defaults to `"default-dark"`
- `customThemes: Theme[]` — user-imported themes

### Startup (Flash Prevention)

A synchronous script in `index.html` reads `differ-ui-state` from `localStorage`, extracts the active theme ID, resolves the theme (checking built-ins then custom themes), and applies CSS variables before React mounts. This prevents a flash of wrong-theme content. The script also removes any legacy `.dark` class from `<html>` and sets `data-theme-type` instead.

### CSS Changes

- `:root` in `index.css` keeps only structural defaults (radius, fonts)
- All color values move into theme objects in `themes/built-in.ts`
- `@custom-variant dark` switches from `.dark` to `[data-theme-type="dark"]`
- The `.dark` class and its CSS block are removed

## File Structure

```
apps/desktop/src/
├── themes/
│   ├── types.ts              # Theme interface
│   ├── built-in.ts           # 4 built-in theme definitions
│   ├── apply.ts              # applyTheme(), resolveTheme() — expands 5 UI tokens to full CSS var set + terminal theme
│   └── import.ts             # JSON validation, parse, fallback logic
├── components/
│   ├── SettingsView.tsx       # Full-page settings shell (sidebar + content)
│   ├── settings/
│   │   └── AppearancePane.tsx # Theme grid, import/export UI
│   └── ThemeCard.tsx          # Mini UI preview card component
├── store.ts                   # + activeThemeId, customThemes
├── App.tsx                    # + currentView routing, settings gear entry
├── index.css                  # Stripped to structural tokens only
└── index.html                 # + theme bootstrap script
```
