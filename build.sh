#!/usr/bin/env bash
# Concatenates parts/*.sh into scaffold-monorepo.sh. Edit the parts, then run this.
#   ./build.sh          → rebuild
#   ./build.sh --check  → fail if scaffold-monorepo.sh is out of date (for CI)
set -euo pipefail
cd "$(dirname "$0")"

out="$(mktemp)"
trap 'rm -f "$out"' EXIT
cat parts/[0-9][0-9]-*.sh >"$out"
bash -n "$out"

if [[ "${1:-}" == "--check" ]]; then
  cmp -s "$out" scaffold-monorepo.sh || { echo "scaffold-monorepo.sh is out of date; run ./build.sh" >&2; exit 1; }
  echo "scaffold-monorepo.sh is up to date"
  exit 0
fi

cp "$out" scaffold-monorepo.sh
chmod +x scaffold-monorepo.sh
echo "Built scaffold-monorepo.sh from $(ls parts/[0-9][0-9]-*.sh | wc -l) parts"
