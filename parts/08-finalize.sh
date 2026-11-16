# --- Fill placeholders (only in files created by this run) ----------------------------------------
if (( ${#WRITTEN[@]} )); then
  SCOPE="$SCOPE" DB_PREFIX="$DB_PREFIX" NODE_MAJOR="$NODE_MAJOR" PNPM_VERSION="$PNPM_VERSION" perl -pi -e '
    s/__DB_PREFIX__/$ENV{DB_PREFIX}/g;
    s/__SCOPE_RE__/$ENV{SCOPE}/g;
    s/__SCOPE__/$ENV{SCOPE}/g;
    s/__NODE_MAJOR__/$ENV{NODE_MAJOR}/g;
    s/__PNPM__/$ENV{PNPM_VERSION}/g;
  ' "${WRITTEN[@]}"
fi

# Record the CLAUDE.md block hash (only when architecture.json was just created)
if grep -q '__CLAUDE_SHA__' architecture.json 2>/dev/null; then
  CLAUDE_SHA="$(node scripts/arch-check.mjs --claude-hash)"
  CLAUDE_SHA="$CLAUDE_SHA" perl -pi -e 's/__CLAUDE_SHA__/$ENV{CLAUDE_SHA}/g' architecture.json
fi

# --- Install + verify ----------------------------------------------------------------------
git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main
if (( INSTALL )); then
  echo "→ Installing dependencies..."
  pnpm install
  if (( ${#WRITTEN[@]} )); then
    pnpm exec biome check --write --files-ignore-unknown=true --no-errors-on-unmatched \
      "${WRITTEN[@]}" >/dev/null || true
  fi
  echo "→ pnpm verify"
  pnpm verify
fi

cat <<EOF

✓ Scaffold ready: $(pwd)  (${#WRITTEN[@]} new files)

Next steps:
  cp .env.example .env && docker compose up -d
  pnpm dev                       # api :3000, web :5173, worker
  .github/CODEOWNERS             # assign owners for architecture files
  git add -A && git commit -m "chore: scaffold"
EOF
