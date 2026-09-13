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

# --- Fairfax County GIS + VDOT, via the ArcGIS REST API ---------------------
# Every layer below was found through the ArcGIS Hub / AGOL search API and
# verified with `?f=json`. Two hosting orgs:
#   ioennV6PpG5Xodq0  Fairfax County GIS (buildings, parcels, zoning)
#   p5v98VHDX9Atv3l7  VDOT (traffic volume, TREDS crashes)
# The county layers stop at the county line, so the independent cities
# (Fairfax City, Falls Church) come out empty. That is the documented scope.
FFX="https://services1.arcgis.com/ioennV6PpG5Xodq0/arcgis/rest/services"
VDOT="https://services.arcgis.com/p5v98VHDX9Atv3l7/ArcGIS/rest/services"
BUILDINGS_URL="$FFX/Buildings/FeatureServer/0"                  # BLDG_HEIGHT, TOP_ELEV, GROUND_ELEV
PARCEL_GEOM_URL="$FFX/Parcels/FeatureServer/0"                  # PIN, the polygons
PARCELS_URL="$FFX/OpenData_A6/FeatureServer/1"                  # PARID, LUC_DESC, ZONING_DESC (tabular)
PARCEL_VALUES_URL="$FFX/OpenData_A6/FeatureServer/2"            # PARID, APRTOT (tabular)
ZONING_URL="$FFX/Zoning/FeatureServer/0"                        # ZONECODE, ZONETYPE
COUNTS_URL="$VDOT/VDOT_Traffic_Volume_2024/FeatureServer/0"     # ADT, AAWDT, ROUTE_COMMON_NAME
CRASHES_URL="$VDOT/Full_Crash/FeatureServer/0"                  # CRASH_YEAR, CRASH_SEVERITY, LAT/LON

GIS_DIR="$RAW_DIR/gis"
PAGE_SIZE=2000
CRASH_YEAR_MIN="$(( $(date +%Y) - 3 ))"

# Page a FeatureServer layer into $GIS_DIR/<name>/page_NNNNN.geojson.
#   arcgis_dump <name> <url> <where> [geometry?]
# resultOffset paging, one file per page so an interrupted run resumes. A page
# with no features ends the walk; `exceededTransferLimit` is not relied on
# because not every VDOT layer sets it.
# TWIN_GIS_LAYERS, when set, is the space-separated subset of layers to fetch.
# Two runs with disjoint subsets can page different layers in parallel; the
# resume check makes an overlap harmless rather than corrupting a page.
arcgis_dump() {
  local name="$1" url="$2" where="$3" clip="${4:-yes}"
  if [[ -n "${TWIN_GIS_LAYERS:-}" && " $TWIN_GIS_LAYERS " != *" $name "* ]]; then
    return 0
  fi
  local dir="$GIS_DIR/$name"
  mkdir -p "$dir"
  local offset=0 page=0 total=0 n
  # Terminate on an empty page, not on a short one: several layers cap
  # maxRecordCount below PAGE_SIZE, so every page comes back "short".
  while :; do
    local out
    out="$(printf '%s/page_%05d.geojson' "$dir" "$page")"
    if [[ ! -s "$out" ]]; then
      local args=(-sS -m 300 --connect-timeout 20
        --retry 5 --retry-delay 5 --retry-all-errors -G "$url/query"
        --data-urlencode "where=$where"
        --data-urlencode "outFields=*"
        --data-urlencode "outSR=4326"
        --data-urlencode "f=geojson"
        --data-urlencode "resultOffset=$offset"
        --data-urlencode "resultRecordCount=$PAGE_SIZE")
      if [[ "$clip" == "yes" ]]; then
        args+=(--data-urlencode "geometry=$BBOX"
               --data-urlencode "geometryType=esriGeometryEnvelope"
               --data-urlencode "inSR=4326"
               --data-urlencode "spatialRel=esriSpatialRelIntersects")
      fi
      if ! curl "${args[@]}" -o "$out.part.$$"; then
        rm -f "$out.part.$$"
        echo "error   $name page $page failed; the ingest stage will use what is on disk" >&2
        return 1
      fi
      mv "$out.part.$$" "$out"
    fi
    n="$(feature_count "$out")"
    if [[ "$n" -lt 0 ]]; then
      echo "error   $name page $page: $(head -c 300 "$out")" >&2; rm -f "$out"; return 1
    fi
    [[ "$n" -eq 0 ]] && break
    total=$(( total + n )); offset=$(( offset + n )); page=$(( page + 1 ))
    printf '\r  %-16s %7d features' "$name" "$total" >&2
  done
  printf '\r  %-16s %7d features\n' "$name" "$total" >&2
}

# A layer can lose its connection halfway through a few hundred pages; the
# resume check means a retry costs only the pages that are missing.
arcgis_layer() {
  for attempt in 1 2 3 4 5; do
    if arcgis_dump "$@"; then
      return 0
    fi
    echo "retry   $1 (attempt $attempt)" >&2
    sleep 10
  done
  return 1
}

# Features in one page file; -1 when the server returned an error document.
feature_count() {
  python3 -c "import json,sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(-1); raise SystemExit
print(-1 if 'error' in d else len(d.get('features', [])))" "$1" 2>/dev/null || echo -1
}

if [[ "${TWIN_SKIP_GIS:-0}" != "1" ]]; then
  echo "arcgis  Fairfax County GIS + VDOT -> $GIS_DIR"
  arcgis_layer buildings     "$BUILDINGS_URL"     "1=1" || true
  arcgis_layer parcel_geom   "$PARCEL_GEOM_URL"   "1=1" || true
  arcgis_layer parcels       "$PARCELS_URL"       "1=1" no || true
  arcgis_layer parcel_values "$PARCEL_VALUES_URL" "1=1" no || true
  arcgis_layer zoning        "$ZONING_URL"        "1=1" || true
  arcgis_layer counts        "$COUNTS_URL"        "1=1" || true
  arcgis_layer crashes       "$CRASHES_URL"       "CRASH_YEAR >= $CRASH_YEAR_MIN" || true
fi

# --- GTFS -------------------------------------------------------------------
# Fairfax Connector and CUE are open. WMATA needs a developer key; without
# TWIN_WMATA_KEY it is skipped with a warning and the transit network is just
# the two local operators.
GTFS_DIR="$RAW_DIR/gtfs"
mkdir -p "$GTFS_DIR"
fetch_gtfs() {
  local name="$1" url="$2"; shift 2
  local out="$GTFS_DIR/$name.zip"
  if [[ -s "$out" ]]; then echo "have    $out ($(du -h "$out" | cut -f1))"; return 0; fi
  if curl -fL --retry 3 --connect-timeout 20 -m 300 "$@" -o "$out.part.$$" "$url"; then
    mv "$out.part.$$" "$out"; echo "saved   $out ($(du -h "$out" | cut -f1))"
  else
    rm -f "$out.part.$$"; echo "error   $name GTFS download failed; skipping that agency" >&2
  fi
}
fetch_gtfs connector "https://www.fairfaxcounty.gov/connector/sites/connector/files/Assets/connector_gtfs.zip"
fetch_gtfs cue       "https://www.fairfaxva.gov/files/assets/city/v/2/public-works/documents/schedules-and-maps/cue-gtfs.zip"
if [[ -n "${TWIN_WMATA_KEY:-}" ]]; then
  fetch_gtfs wmata_bus  "https://api.wmata.com/gtfs/bus-gtfs-static.zip"  -H "api_key: $TWIN_WMATA_KEY"
  fetch_gtfs wmata_rail "https://api.wmata.com/gtfs/rail-gtfs-static.zip" -H "api_key: $TWIN_WMATA_KEY"
else
  echo "warn    TWIN_WMATA_KEY is unset; skipping WMATA bus and rail GTFS." >&2
  echo "        Get a key at developer.wmata.com and re-run to include Metro." >&2
fi

TARGET="$CLIPPED"
[[ -f "$TARGET" ]] || TARGET="$FULL"
echo
echo "next    cargo run --release -p twin-pipeline -- \\"
echo "          ingest-roads --pbf $TARGET --bbox $BBOX --out data/build/"
echo "        cargo run --release -p twin-pipeline -- cch-order"
echo "        cargo run --release -p twin-pipeline -- demand"
echo "        cargo run --release -p twin-pipeline -- ingest-gis"
echo "        cargo run --release -p twin-pipeline -- ingest-gtfs"
echo "        cargo run --release -p twin-pipeline -- ingest-counts"
echo "        cargo run --release -p twin-pipeline -- ingest-crashes"
echo "        scripts/build-tiles.sh --force"
