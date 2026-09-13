#!/usr/bin/env bash
# Build data/build/world.pmtiles (layers: buildings, roads) from an OSM PBF
# with Planetiler. Layered config: defaults <- twin.toml <- TWIN_* env <- flags.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- defaults ----------------------------------------------------------------
PLANETILER_VERSION="0.10.2"
BBOX="-77.54,38.60,-77.04,39.06"            # Fairfax County + buffer
MIN_ZOOM="4"
MAX_ZOOM="15"
RAW_DIR="$ROOT/data/raw"
BUILD_DIR="$ROOT/data/build"
TOOLS_DIR="$ROOT/data/tools"
GEOFABRIK_URL="https://download.geofabrik.de/north-america/us/virginia-latest.osm.pbf"
JAR_URL_BASE="https://github.com/onthegomap/planetiler/releases/download"
FORCE="0"

# ---- twin.toml layer ---------------------------------------------------------
if [[ -f "$ROOT/twin.toml" ]]; then
  while IFS='=' read -r key value; do
    key="$(echo "$key" | tr -d '[:space:]')"; value="$(echo "$value" | tr -d '[:space:]"')"
    case "$key" in
      bbox) BBOX="$value" ;;
      max_zoom) MAX_ZOOM="$value" ;;
      min_zoom) MIN_ZOOM="$value" ;;
      planetiler_version) PLANETILER_VERSION="$value" ;;
    esac
  done < <(sed -n '/^\[tiles\]/,/^\[/p' "$ROOT/twin.toml" | grep '=' || true)
fi

# ---- environment layer -------------------------------------------------------
BBOX="${TWIN_BBOX:-$BBOX}"
MIN_ZOOM="${TWIN_MIN_ZOOM:-$MIN_ZOOM}"
MAX_ZOOM="${TWIN_MAX_ZOOM:-$MAX_ZOOM}"
PLANETILER_VERSION="${TWIN_PLANETILER_VERSION:-$PLANETILER_VERSION}"
RAW_DIR="${TWIN_RAW_DIR:-$RAW_DIR}"
BUILD_DIR="${TWIN_BUILD_DIR:-$BUILD_DIR}"

# ---- flag layer --------------------------------------------------------------
usage() {
  cat <<USAGE
usage: build-tiles.sh [--bbox W,S,E,N] [--max-zoom N] [--min-zoom N]
                      [--pbf PATH] [--out PATH] [--planetiler-version V] [--force]
Layered config: defaults <- twin.toml [tiles] <- TWIN_* env <- these flags.
TWIN_REUSE_OSM=1 keeps the existing OSM half and rebuilds only the county and
feed layers from data/build/gis/*.geojsonl.
USAGE
}
PBF=""
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bbox) BBOX="$2"; shift 2 ;;
    --max-zoom) MAX_ZOOM="$2"; shift 2 ;;
    --min-zoom) MIN_ZOOM="$2"; shift 2 ;;
    --pbf) PBF="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --planetiler-version) PLANETILER_VERSION="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 2 ;;
  esac
done

OUT="${OUT:-$BUILD_DIR/world.pmtiles}"
# The OSM half is built on its own and then joined with the county half, so
# either can be rebuilt without redoing the other.
OSM_OUT="$BUILD_DIR/world_osm.pmtiles"
GIS_DIR="$BUILD_DIR/gis"
TIPPECANOE="${TWIN_TIPPECANOE:-$TOOLS_DIR/tippecanoe-src/tippecanoe}"
TILE_JOIN="${TWIN_TILE_JOIN:-$TOOLS_DIR/tippecanoe-src/tile-join}"
JAR="$TOOLS_DIR/planetiler-$PLANETILER_VERSION.jar"
mkdir -p "$RAW_DIR" "$BUILD_DIR" "$TOOLS_DIR"

log() { printf '[build-tiles] %s\n' "$*" >&2; }

# ---- java --------------------------------------------------------------------
JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/java}"
JAVA_BIN="${JAVA_BIN:-java}"
if ! command -v "$JAVA_BIN" >/dev/null 2>&1; then
  log "ERROR: java not found. Planetiler needs Java 21+."; exit 1
fi
JAVA_MAJOR="$("$JAVA_BIN" -version 2>&1 | sed -n '1s/^[^"]*"\([0-9]*\).*/\1/p')"
if [[ "${JAVA_MAJOR:-0}" -lt 21 ]]; then
  log "ERROR: java $JAVA_MAJOR found, Planetiler $PLANETILER_VERSION needs 21+."
  log "       install a JDK 21 and re-run with JAVA_HOME set."
  exit 1
fi

# ---- planetiler jar ----------------------------------------------------------
if [[ ! -f "$JAR" ]]; then
  log "downloading planetiler $PLANETILER_VERSION"
  curl -fL --retry 3 -o "$JAR.part" \
    "$JAR_URL_BASE/v$PLANETILER_VERSION/planetiler.jar" || {
      log "ERROR: could not download planetiler jar"; rm -f "$JAR.part"; exit 1; }
  mv "$JAR.part" "$JAR"
fi

# ---- input pbf ---------------------------------------------------------------
if [[ -z "$PBF" ]]; then
  if   [[ -f "$RAW_DIR/fairfax.osm.pbf" ]];          then PBF="$RAW_DIR/fairfax.osm.pbf"
  elif [[ -f "$RAW_DIR/virginia-latest.osm.pbf" ]];  then PBF="$RAW_DIR/virginia-latest.osm.pbf"
  else
    log "no PBF in $RAW_DIR; downloading Geofabrik Virginia extract (~350 MB)"
    curl -fL --retry 3 -o "$RAW_DIR/virginia-latest.osm.pbf.part" "$GEOFABRIK_URL" || {
      log "ERROR: Geofabrik download failed (offline?)."
      log "       Place fairfax.osm.pbf or virginia-latest.osm.pbf in $RAW_DIR and re-run,"
      log "       or use web/scripts/make-fixture-pmtiles.mjs for a dev fixture."
      rm -f "$RAW_DIR/virginia-latest.osm.pbf.part"; exit 1; }
    mv "$RAW_DIR/virginia-latest.osm.pbf.part" "$RAW_DIR/virginia-latest.osm.pbf"
    PBF="$RAW_DIR/virginia-latest.osm.pbf"
  fi
fi

if [[ -f "$OUT" && "$FORCE" != "1" ]]; then
  log "$OUT exists; pass --force to rebuild"; exit 0
fi

# ---- run ---------------------------------------------------------------------
# openmaptiles profile restricted to the two layers we need; `building` carries
# render_height/render_min_height and `transportation` carries class + osm way id
# (--output-osm-ids), which is the stand-in for edge_id until twin-pipeline
# assigns stable ids.
# The OSM half changes only when the extract does, and it is the slow half, so
# TWIN_REUSE_OSM=1 keeps it and rebuilds just the county and feed layers.
if [[ -s "$OSM_OUT" && "${TWIN_REUSE_OSM:-0}" == "1" ]]; then
  log "reusing $OSM_OUT ($(du -h "$OSM_OUT" | cut -f1))"
else
log "planetiler: bbox=$BBOX zoom=$MIN_ZOOM..$MAX_ZOOM pbf=$PBF"
rm -f "$OSM_OUT"
"$JAVA_BIN" -Xmx4g -jar "$JAR" \
  --osm-path="$PBF" \
  --bounds="$BBOX" \
  --only-layers=building,transportation \
  --minzoom="$MIN_ZOOM" --maxzoom="$MAX_ZOOM" \
  --render-maxzoom="$MAX_ZOOM" \
  --output-osm-ids \
  --download --force \
  --output="$OSM_OUT"
fi

# Note: the emitted MVT source layers are openmaptiles' `building` and
# `transportation`; the web layer registry maps them onto the `buildings` and
# `roads` layer ids (LayerEntry.sourceLayer), so no tile rewriting is needed.

# ---- county / feed layers ----------------------------------------------------
# `twin-pipeline ingest-gis|ingest-gtfs|ingest-counts|ingest-crashes` write
# newline-delimited GeoJSON into $GIS_DIR. Each group gets its own tippecanoe
# pass because they want different minimum zooms, and everything is joined into
# the single world.pmtiles the app loads.
#
# `buildings` here is the county footprint layer with real LiDAR heights; it
# supersedes openmaptiles' `building`, which stays in the file as the fallback
# for the independent cities the county data does not cover.
join_inputs=("$OSM_OUT")

tile_group() {
  local name="$1" minz="$2"; shift 2
  local layers=()
  for layer in "$@"; do
    local src="$GIS_DIR/$layer.geojsonl"
    [[ -s "$src" ]] && layers+=("-L" "$layer:$src")
  done
  if [[ ${#layers[@]} -eq 0 ]]; then
    log "skip $name: no source GeoJSON in $GIS_DIR"
    return 0
  fi
  local out="$BUILD_DIR/world_$name.pmtiles"
  rm -f "$out"
  "$TIPPECANOE" -o "$out" --force --quiet \
    --minimum-zoom="$minz" --maximum-zoom="$MAX_ZOOM" \
    --drop-densest-as-needed --extend-zooms-if-still-dropping \
    --no-tile-size-limit \
    "${layers[@]}"
  join_inputs+=("$out")
  log "built $out ($(du -h "$out" | cut -f1))"
}

if [[ -x "$TIPPECANOE" && -x "$TILE_JOIN" ]]; then
  tile_group parcels  13 buildings parcels zoning
  tile_group transit   9 transit_routes transit_stops counts
  tile_group feeds    10 crash_grid
  tile_group crashes  12 crashes
else
  log "tippecanoe not built at $TIPPECANOE; county and feed layers are skipped."
  log "       build it with: git clone --depth 1 https://github.com/felt/tippecanoe \\"
  log "                        $TOOLS_DIR/tippecanoe-src && make -C $TOOLS_DIR/tippecanoe-src"
fi

rm -f "$OUT"
if [[ ${#join_inputs[@]} -eq 1 ]]; then
  cp "$OSM_OUT" "$OUT"
else
  log "tile-join: ${#join_inputs[@]} sources -> $OUT"
  "$TILE_JOIN" -o "$OUT" --force --quiet --no-tile-size-limit "${join_inputs[@]}"
fi

log "wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Dev-time link so the app can fetch /data/world.pmtiles.
mkdir -p "$ROOT/web/public/data"
ln -sf "$OUT" "$ROOT/web/public/data/world.pmtiles"
log "linked web/public/data/world.pmtiles"
