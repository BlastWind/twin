#!/usr/bin/env bash
# Fetch the open data twin-pipeline ingests.
#
#   scripts/download-data.sh
#
# 1. Geofabrik's Virginia OSM extract, clipped to the county bbox with
#    `osmium extract` when osmium is installed  ->  ingest-roads.
# 2. LEHD LODES 8 home->work flows and the block crosswalk (which carries
#    2020 census block centroids)              ->  demand.
#
# Everything is idempotent; nothing here is required to build or test the
# project. `ingest-roads --synthetic-grid N` and `demand --synthetic` cover the
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

# --- LEHD LODES 8 -----------------------------------------------------------
# `od_main` is VA-resident -> VA-job; `od_aux` is the out-of-state inflow, which
# for Fairfax is most of the I-95/I-395/I-495 commute. `xwalk` maps each 2020
# census block to its block group and carries the block centroid, so no
# separate TIGER download is needed.
LODES="https://lehd.ces.census.gov/data/lodes/LODES8/va"
for name in od/va_od_main_JT00_2023.csv.gz od/va_od_aux_JT00_2023.csv.gz va_xwalk.csv.gz; do
  out="$RAW_DIR/$(basename "$name")"
  if [[ -f "$out" ]]; then
    echo "have    $out ($(du -h "$out" | cut -f1))"
    continue
  fi
  echo "fetch   $LODES/$name"
  if curl -fL --continue-at - --retry 3 --connect-timeout 20 -o "$out" "$LODES/$name"; then
    echo "saved   $out ($(du -h "$out" | cut -f1))"
  else
    rm -f "$out"
    echo "error   LODES download failed; the demand stage will fall back to" >&2
    echo "        a synthetic gravity model and say so in the manifest." >&2
  fi
done

TARGET="$CLIPPED"
[[ -f "$TARGET" ]] || TARGET="$FULL"
echo
echo "next    cargo run --release -p twin-pipeline -- \\"
echo "          ingest-roads --pbf $TARGET --bbox $BBOX --out data/build/"
echo "        cargo run --release -p twin-pipeline -- cch-order"
echo "        cargo run --release -p twin-pipeline -- demand"
