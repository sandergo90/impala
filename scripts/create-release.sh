#!/usr/bin/env bash
set -euo pipefail

# Canopy Desktop Release Script
# Usage: ./scripts/create-release.sh [version] [--publish] [--merge]
#
# Examples:
#   ./scripts/create-release.sh              # Interactive version selection
#   ./scripts/create-release.sh 0.2.0        # Explicit version
#   ./scripts/create-release.sh --publish    # Auto-publish after build

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
error() { echo -e "${RED}✗${NC}  $*" >&2; exit 1; }

# --- Parse arguments ---
VERSION=""
AUTO_PUBLISH=false
AUTO_MERGE=false

for arg in "$@"; do
    case "$arg" in
        --publish) AUTO_PUBLISH=true ;;
        --merge)   AUTO_MERGE=true ;;
        -*)        error "Unknown flag: $arg" ;;
        *)         VERSION="$arg" ;;
    esac
done

# --- Preflight checks ---
command -v gh  &>/dev/null || error "GitHub CLI (gh) is required. Install: https://cli.github.com"
command -v jq  &>/dev/null || error "jq is required. Install: brew install jq"
gh auth status &>/dev/null || error "Not authenticated with GitHub CLI. Run: gh auth login"

if [ -n "$(git status --porcelain)" ]; then
    error "Working directory is not clean. Commit or stash your changes first."
fi

# --- Determine current version ---
LATEST_TAG=$(gh release list --json tagName --jq '[.[] | select(.tagName | startswith("desktop-v"))] | .[0].tagName // empty' 2>/dev/null || true)

if [ -n "$LATEST_TAG" ]; then
    CURRENT_VERSION="${LATEST_TAG#desktop-v}"
    info "Latest release: ${LATEST_TAG} (v${CURRENT_VERSION})"
else
    CURRENT_VERSION=$(jq -r '.version' backend/tauri/tauri.conf.json)
    info "No prior releases found. Current version from config: ${CURRENT_VERSION}"
fi

# --- Version helpers ---
increment_patch() {
    local v="$1"; IFS='.' read -r maj min pat <<< "$v"
    echo "${maj}.${min}.$((pat + 1))"
}
increment_minor() {
    local v="$1"; IFS='.' read -r maj min _ <<< "$v"
    echo "${maj}.$((min + 1)).0"
}
increment_major() {
    local v="$1"; IFS='.' read -r maj _ _ <<< "$v"
    echo "$((maj + 1)).0.0"
}

# --- Pick version ---
if [ -z "$VERSION" ]; then
    PATCH=$(increment_patch "$CURRENT_VERSION")
    MINOR=$(increment_minor "$CURRENT_VERSION")
    MAJOR=$(increment_major "$CURRENT_VERSION")

    echo ""
    echo "Select version bump (current: ${CURRENT_VERSION}):"
    echo "  1) Patch  → ${PATCH}"
    echo "  2) Minor  → ${MINOR}"
    echo "  3) Major  → ${MAJOR}"
    echo "  4) Custom"
    echo ""
    read -rp "Choice [1]: " choice
    choice="${choice:-1}"

    case "$choice" in
        1) VERSION="$PATCH" ;;
        2) VERSION="$MINOR" ;;
        3) VERSION="$MAJOR" ;;
        4) read -rp "Enter version: " VERSION ;;
        *) error "Invalid choice" ;;
    esac
fi

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    error "Invalid version format: ${VERSION}. Expected: MAJOR.MINOR.PATCH"
fi

TAG_NAME="desktop-v${VERSION}"
ok "Will release: ${TAG_NAME}"

# --- Check if tag already exists ---
if git rev-parse "$TAG_NAME" &>/dev/null 2>&1; then
    warn "Tag ${TAG_NAME} already exists locally."
    read -rp "Delete and recreate? [y/N]: " confirm
    [ "$confirm" = "y" ] || exit 0
    git tag -d "$TAG_NAME"
    if gh release view "$TAG_NAME" &>/dev/null 2>&1; then
        gh release delete "$TAG_NAME" --yes
    fi
fi

# --- Update version in config files ---
info "Updating version to ${VERSION}..."

# tauri.conf.json
jq --arg v "$VERSION" '.version = $v' backend/tauri/tauri.conf.json > tmp.json && mv tmp.json backend/tauri/tauri.conf.json

# Cargo.toml (backend/tauri)
sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" backend/tauri/Cargo.toml

# Cargo.toml (backend/mcp)
sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" backend/mcp/Cargo.toml

# package.json (apps/desktop)
jq --arg v "$VERSION" '.version = $v' apps/desktop/package.json > tmp.json && mv tmp.json apps/desktop/package.json

ok "Updated version in all config files"

# --- Commit and tag ---
BRANCH=$(git branch --show-current)

git add backend/tauri/tauri.conf.json backend/tauri/Cargo.toml backend/mcp/Cargo.toml apps/desktop/package.json
git commit -m "release: desktop v${VERSION}"
git tag "$TAG_NAME"

ok "Created commit and tag ${TAG_NAME}"

# --- Push ---
info "Pushing tag ${TAG_NAME}..."
git push origin "$BRANCH" --follow-tags

ok "Pushed to origin. GitHub Actions will start building."

# --- Monitor workflow ---
info "Waiting for workflow to start..."
sleep 5

WORKFLOW_RUN=""
for i in $(seq 1 12); do
    WORKFLOW_RUN=$(gh run list --workflow=release-desktop.yml --json databaseId,headSha,status \
        --jq "[.[] | select(.headSha == \"$(git rev-parse HEAD)\")] | .[0].databaseId // empty" 2>/dev/null || true)
    if [ -n "$WORKFLOW_RUN" ]; then
        break
    fi
    sleep 5
done

if [ -z "$WORKFLOW_RUN" ]; then
    warn "Could not find workflow run. Check GitHub Actions manually."
    echo "  https://github.com/$(gh repo view --json nameWithOwner -q '.nameWithOwner')/actions"
    exit 0
fi

ok "Workflow run: ${WORKFLOW_RUN}"
info "Watching build progress..."
gh run watch "$WORKFLOW_RUN"

# --- Check result ---
CONCLUSION=$(gh run view "$WORKFLOW_RUN" --json conclusion -q '.conclusion')
if [ "$CONCLUSION" != "success" ]; then
    error "Workflow failed with conclusion: ${CONCLUSION}"
fi

ok "Build completed successfully!"

# --- Publish release ---
ok "Release will be published automatically by the workflow."

echo ""
ok "Done! 🎉"
echo "  Release: https://github.com/$(gh repo view --json nameWithOwner -q '.nameWithOwner')/releases/tag/${TAG_NAME}"
