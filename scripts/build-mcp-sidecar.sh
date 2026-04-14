#!/usr/bin/env bash
set -euo pipefail

# Build the impala-mcp binary and stage it as a Tauri sidecar so it gets
# bundled into the .app. Tauri's externalBin requires the file to be named
# with the host target triple suffix.

PROFILE="${1:-release}"
TRIPLE=$(rustc -vV | sed -n 's/host: //p')

if [ "$PROFILE" = "release" ]; then
  cargo build --release --manifest-path backend/mcp/Cargo.toml
else
  cargo build --manifest-path backend/mcp/Cargo.toml
fi

mkdir -p backend/tauri/binaries
cp "backend/mcp/target/$PROFILE/impala-mcp" "backend/tauri/binaries/impala-mcp-$TRIPLE"
