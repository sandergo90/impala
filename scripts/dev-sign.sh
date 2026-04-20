#!/usr/bin/env bash
set -euo pipefail

# Cargo runner. macOS TCC (Files & Folders, Full Disk Access) keys grants by
# code identity, so every rebuild invalidates them unless we pin an identifier.
# Ad-hoc sign with a stable `--identifier` and the grant survives.

BIN="$1"
shift

case "$(basename "$BIN")" in
  impala)            IDENT="be.kodeus.impala.dev" ;;
  impala-mcp)        IDENT="be.kodeus.impala.mcp.dev" ;;
  impala-pty-daemon) IDENT="be.kodeus.impala.pty-daemon.dev" ;;
  *)                 IDENT="" ;;
esac

if [ -n "$IDENT" ]; then
  codesign --sign - --force --identifier "$IDENT" "$BIN" >/dev/null 2>&1 || true
fi

exec "$BIN" "$@"
