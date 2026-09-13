#!/usr/bin/env bash
# Fetch the OSM extract twin-pipeline ingests, and clip it to Fairfax County.
#
#   scripts/download-data.sh
#
# Downloads Geofabrik's Virginia extract into data/raw/ (skipped if present),
# then clips it to the county bbox with `osmium extract` when osmium is
# installed. Everything is idempotent; nothing here is required to build or
# test the project — `twin-pipeline ingest-roads --synthetic-grid N` covers the
# offline path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW_DIR="${TWIN_RAW_DIR:-$ROOT/data/raw}"
BBOX="${TWIN_BBOX:--77.54,38.60,-77.04,39.06}"   # Fairfax County
URL="https://download.geofabrik.de/north-america/us/virginia-latest.osm.pbf"
FULL="$RAW_DIR/virginia-latest.osm.pbf"
CLIPPED="$RAW_DIR/fairfax.osm.pbf"

mkdir -p "$RAW_DIR"

if [[ -f "$FULL" ]]; then
  echo "have    $FULL ($(du -h "$FULL" | cut -f1))"
else
  echo "fetch   $URL"
  # --continue so an interrupted run resumes instead of restarting.
  curl -fL --continue-at - --retry 3 --connect-timeout 20 -o "$FULL" "$URL" || {
    echo "error   download failed; run the pipeline offline instead:" >&2
    echo "        cargo run -p twin-pipeline -- ingest-roads --synthetic-grid 100" >&2
    exit 1
  }
  echo "saved   $FULL ($(du -h "$FULL" | cut -f1))"
fi

if [[ -f "$CLIPPED" ]]; then
  echo "have    $CLIPPED ($(du -h "$CLIPPED" | cut -f1))"
elif command -v osmium >/dev/null 2>&1; then
  echo "clip    $BBOX"
  osmium extract --bbox "$BBOX" --strategy complete_ways \
    --overwrite -o "$CLIPPED" "$FULL"
  echo "saved   $CLIPPED ($(du -h "$CLIPPED" | cut -f1))"
else
  echo "skip    osmium not installed; clipping skipped."
  echo "        The pipeline filters to --bbox anyway, just more slowly."
  echo "        Install with: sudo apt install osmium-tool"
fi

TARGET="$CLIPPED"
[[ -f "$TARGET" ]] || TARGET="$FULL"
echo
echo "next    cargo run --release -p twin-pipeline -- \\"
echo "          ingest-roads --pbf $TARGET --bbox $BBOX --out data/build/"
