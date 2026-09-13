//! OSM PBF -> [`RawGraph`]. Two passes over the file: ways first (to learn
//! which nodes matter), then nodes.

use anyhow::{Context, Result};
use osmpbf::{Element, ElementReader};
use std::collections::HashMap;
use std::path::Path;
use twin_core::grid::haversine_m;
use twin_core::{BBox, RawEdge, RawGraph, RawNode, RoadClass};

/// A highway way reduced to what the graph needs.
struct WayDTO {
    refs: Vec<i64>,
    class: RoadClass,
    lanes: Option<u8>,
    speed_kph: Option<f32>,
    direction: Direction,
}

/// Which way traffic may travel along the way's node order.
#[derive(Copy, Clone, PartialEq)]
enum Direction {
    Both,
    Forward,
    Backward,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct OsmStats {
    pub ways_kept: u64,
    pub nodes_resolved: u64,
    pub segments: u64,
    pub dropped_outside_bbox: u64,
}

/// Parse `path`, keeping drivable highway ways whose segments lie inside
/// `bbox`. Service roads are opt-in because they roughly double the edge count
/// for little assignment value.
///
/// Two passes. The first keeps only nodes inside the bbox, which is what makes
/// running a state-sized extract against a county bbox affordable: a
/// Virginia-wide way index would be several GB, while the county's nodes are a
/// few million. The second pass then keeps a way segment only when both of its
/// endpoints survived, so clipping falls out for free.
pub fn read_pbf(path: &Path, bbox: BBox, keep_service: bool) -> Result<(RawGraph, OsmStats)> {
    let mut stats = OsmStats::default();
    let mut coords: HashMap<i64, (f64, f64)> = HashMap::new();

    ElementReader::from_path(path)
        .with_context(|| format!("opening {}", path.display()))?
        .for_each(|element| {
            let (id, lon, lat) = match element {
                Element::Node(n) => (n.id(), n.lon(), n.lat()),
                Element::DenseNode(n) => (n.id(), n.lon(), n.lat()),
                _ => return,
            };
            if bbox.contains(lon, lat) {
                coords.insert(id, (lon, lat));
            }
        })
        .with_context(|| format!("scanning nodes in {}", path.display()))?;
    stats.nodes_resolved = coords.len() as u64;

    let mut ways: Vec<WayDTO> = Vec::new();
    ElementReader::from_path(path)?
        .for_each(|element| {
            let Element::Way(w) = element else { return };
            let Some(way) = parse_way(&w, keep_service) else {
                return;
            };
            if way.refs.iter().any(|r| coords.contains_key(r)) {
                ways.push(way);
            }
        })
        .with_context(|| format!("scanning ways in {}", path.display()))?;
    stats.ways_kept = ways.len() as u64;

    Ok((assemble(&ways, &coords, &mut stats), stats))
}

fn parse_way(w: &osmpbf::Way<'_>, keep_service: bool) -> Option<WayDTO> {
    let tags: HashMap<&str, &str> = w.tags().collect();
    let class = RoadClass::from_osm_highway(tags.get("highway").copied()?)?;
    if class == RoadClass::Service && !keep_service {
        return None;
    }
    if matches!(tags.get("access").copied(), Some("no") | Some("private")) {
        return None;
    }
    let refs: Vec<i64> = w.refs().collect();
    if refs.len() < 2 {
        return None;
    }
    Some(WayDTO {
        refs,
        class,
        lanes: tags.get("lanes").and_then(|v| v.parse::<u8>().ok()),
        speed_kph: tags.get("maxspeed").and_then(|v| parse_maxspeed(v)),
        direction: match tags.get("oneway").copied() {
            Some("yes") | Some("true") | Some("1") => Direction::Forward,
            Some("-1") | Some("reverse") => Direction::Backward,
            _ => Direction::Both,
        },
    })
}

/// `"50"`, `"35 mph"`, `"50 km/h"`. Anything else is left to the class default.
fn parse_maxspeed(raw: &str) -> Option<f32> {
    let text = raw.trim();
    let (num, mph) = match text.strip_suffix("mph") {
        Some(n) => (n, true),
        None => (text.strip_suffix("km/h").unwrap_or(text), false),
    };
    let v: f32 = num.trim().parse().ok()?;
    Some(if mph { v * 1.609_344 } else { v })
}

/// Turn ways into directed edges between interned nodes, dropping segments
/// with an endpoint outside the study bbox.
fn assemble(ways: &[WayDTO], coords: &HashMap<i64, (f64, f64)>, stats: &mut OsmStats) -> RawGraph {
    let mut nodes: Vec<RawNode> = Vec::new();
    let mut index: HashMap<i64, u32> = HashMap::new();
    let mut edges: Vec<RawEdge> = Vec::new();

    for way in ways {
        for pair in way.refs.windows(2) {
            let (Some(&a), Some(&b)) = (coords.get(&pair[0]), coords.get(&pair[1])) else {
                // One end is outside the bbox, so the segment is clipped away.
                stats.dropped_outside_bbox += 1;
                continue;
            };
            let len = haversine_m(a.0, a.1, b.0, b.1) as f32;
            if len <= 0.0 {
                continue;
            }
            let ia = intern(pair[0], a, &mut nodes, &mut index);
            let ib = intern(pair[1], b, &mut nodes, &mut index);
            stats.segments += 1;
            let mk = |from, to| {
                RawEdge::with_defaults(from, to, len, way.class, way.lanes, way.speed_kph)
            };
            if way.direction != Direction::Backward {
                edges.push(mk(ia, ib));
            }
            if way.direction != Direction::Forward {
                edges.push(mk(ib, ia));
            }
        }
    }
    RawGraph { nodes, edges }
}

fn intern(
    osm_id: i64,
    ll: (f64, f64),
    nodes: &mut Vec<RawNode>,
    index: &mut HashMap<i64, u32>,
) -> u32 {
    *index.entry(osm_id).or_insert_with(|| {
        nodes.push(RawNode {
            lon: ll.0,
            lat: ll.1,
        });
        nodes.len() as u32 - 1
    })
}

/// Drop nodes with no incident edge and renumber. Simplification and bbox
/// clipping both leave strays behind.
pub fn prune_isolated(graph: &RawGraph) -> RawGraph {
    let mut used = vec![false; graph.nodes.len()];
    for e in &graph.edges {
        used[e.from as usize] = true;
        used[e.to as usize] = true;
    }
    let mut remap = vec![u32::MAX; graph.nodes.len()];
    let mut nodes: Vec<RawNode> = Vec::with_capacity(graph.nodes.len());
    for (i, keep) in used.iter().enumerate() {
        if *keep {
            remap[i] = nodes.len() as u32;
            nodes.push(graph.nodes[i]);
        }
    }
    let edges = graph
        .edges
        .iter()
        .map(|e| RawEdge {
            from: remap[e.from as usize],
            to: remap[e.to as usize],
            ..*e
        })
        .collect();
    RawGraph { nodes, edges }
}
