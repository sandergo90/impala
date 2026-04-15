#!/usr/bin/env bash
set -euo pipefail

# Build impala-pty-daemon and stage it as a Tauri sidecar so it gets bundled
# into the .app. Tauri's externalBin requires the file to be named with the
# host target triple suffix.

PROFILE="${1:-release}"
TRIPLE=$(rustc -vV | sed -n 's/host: //p')

if [ "$PROFILE" = "release" ]; then
  cargo build --release --manifest-path backend/tauri/Cargo.toml -p impala-pty-daemon
else
  cargo build --manifest-path backend/tauri/Cargo.toml -p impala-pty-daemon
fi

mkdir -p backend/tauri/binaries
cp "backend/tauri/target/$PROFILE/impala-pty-daemon" \
   "backend/tauri/binaries/impala-pty-daemon-$TRIPLE"
