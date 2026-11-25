#!/usr/bin/env bash
# Re-sync plan data from PT Bot's spec folder (seed/ is the source of truth).
# Usage: scripts/sync-seed.sh [/path/to/pt-rehab]   (default /workspace/pt-rehab)
set -euo pipefail
SRC="${1:-/workspace/pt-rehab}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/public/data"
mkdir -p "$DATA/schemas" "$ROOT/test/fixtures"
for f in levels exercises tests decision-config hashes posture-cycle; do
  [ -f "$SRC/seed/$f.json" ] && cp "$SRC/seed/$f.json" "$DATA/$f.json"
done
cp "$SRC"/schemas/*.schema.json "$DATA/schemas/"
cp "$SRC/seed/test-vectors.json" "$ROOT/test/fixtures/"
cp "$SRC"/seed/examples/* "$ROOT/test/fixtures/"
# The agent brief is copied verbatim into every export; take it from the example export.
python3 - "$SRC/seed/examples/weekly-export.example.json" "$DATA/agent-brief.json" <<'PY'
import json, sys
json.dump(json.load(open(sys.argv[1]))["agent_brief"], open(sys.argv[2], "w"), indent=2, ensure_ascii=False)
PY
# Optional settings defaults if PT Bot ships them.
for f in profile profile-defaults settings-defaults; do
  [ -f "$SRC/seed/$f.json" ] && cp "$SRC/seed/$f.json" "$DATA/$f.json" && echo "copied $f.json"
done
ls "$SRC/seed"
echo "Synced seed + schemas from $SRC"
