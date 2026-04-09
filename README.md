# Impala

A desktop app for reviewing git worktree changes. Built with Tauri, React, and Rust.

## Features

- **Diff viewer** — review file changes across git worktrees with inline annotations
- **Integrated terminal** — run commands without leaving the app, with split view support
- **Annotations** — leave inline comments on diffs, track and resolve them
- **MCP server** — exposes annotations to Claude Code so AI agents can read and resolve review comments
- **Themes** — customizable appearance with theme support
- **Auto-updates** — built-in update checker with automatic downloads
- **Command palette** — quick access to actions via keyboard shortcuts

## Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS, Vite
- **Backend:** Rust (Tauri 2), SQLite for annotation storage
- **MCP Server:** Standalone Rust binary (`impala-mcp`) using stdio transport
- **Build:** Bun, Turborepo

## Project Structure

```
apps/desktop/       React frontend (Vite + Tailwind)
backend/tauri/      Tauri backend (Rust)
backend/mcp/        MCP server for Claude Code integration
```

## Development

Prerequisites: [Bun](https://bun.sh), [Rust](https://www.rust-lang.org/tools/install), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
bun install
bun run dev
```

This starts both the Vite dev server and the Tauri backend.

## Building

```sh
bun run build
```

## Releasing

Push a tag matching `desktop-v*.*.*` to trigger the release workflow.
