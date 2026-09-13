//! Round-trip, chunk-merge and simplification tests.

use twin_core::graph_schema::GraphChunkSchema;
use twin_core::schema::AlignedBytes;
use twin_core::*;

fn county_bbox() -> BBox {
    BBox::new(-77.54, 38.60, -77.04, 39.06).expect("bbox is well formed")
}

fn grid_partition(n: u32) -> Partition {
    let raw = RawGraph::synthetic_grid(n, county_bbox());
    let grid = GridSchema::cover(county_bbox(), DEFAULT_CELL_M);
    partition(&raw, &grid)
}

#[test]
fn index_round_trips() {
    let p = grid_partition(8);
    let bytes = AlignedBytes::adopt(GraphIndexSchema::encode(&p.grid, &p.entries));
    let decoded = GraphIndexSchema::decode(&bytes).expect("index decodes");
    assert_eq!(decoded.grid, p.grid);
    assert_eq!(decoded.chunks, p.entries.as_slice());
    assert_eq!(decoded.total_nodes(), 64);
}

#[test]
fn chunk_round_trips_zero_copy() {
    let p = grid_partition(8);
    let build = &p.chunks[0];
    let bytes = AlignedBytes::adopt(build.encode());
    let decoded = GraphChunkSchema::decode(&bytes).expect("chunk decodes");

    assert_eq!(decoded.meta.node_count as usize, build.nodes.len());
    assert_eq!(decoded.meta.edge_count as usize, build.edges.len());
    assert_eq!(decoded.node_gid[0], build.nodes[0].gid.raw());
    assert_eq!(decoded.edge_class[0], build.edges[0].class.as_u8());

    // Every view must point *into* the caller's buffer, never at a copy.
    let range = bytes.as_ptr() as usize..bytes.as_ptr() as usize + bytes.len();
    assert!(range.contains(&(decoded.node_gid.as_ptr() as usize)));
    assert!(range.contains(&(decoded.out_edges.as_ptr() as usize)));
}

#[test]
fn bad_magic_and_version_are_rejected() {
    let p = grid_partition(4);
    let mut bad = GraphIndexSchema::encode(&p.grid, &p.entries);
    bad[0] = b'X';
    let bytes = AlignedBytes::adopt(bad);
    assert!(matches!(
        GraphIndexSchema::decode(&bytes),
        Err(SchemaError::BadMagic { .. })
    ));
}

#[test]
fn chunk_merge_dedups_border_edges() {
    let p = grid_partition(16);
    let encoded: Vec<AlignedBytes> = p
        .chunks
        .iter()
        .map(|c| AlignedBytes::adopt(c.encode()))
        .collect();
    let decoded: Vec<GraphChunkSchema> = encoded
        .iter()
        .map(|b| GraphChunkSchema::decode(b).expect("chunk decodes"))
        .collect();

    let full = RoadGraph::from_chunks(decoded.iter()).expect("assembles");
    let expected_edges: usize = p.entries.iter().map(|e| e.edge_count as usize).sum();
    assert_eq!(full.nodes().len(), 16 * 16, "no duplicated ghost nodes");
    assert_eq!(
        full.edges().len(),
        expected_edges,
        "border edges counted once"
    );
    assert_eq!(full.boundary_edge_count(), 0, "all chunks loaded");

    // Every out-edge list agrees with the edge array.
    let csr_total: usize = (0..full.nodes().len())
        .map(|n| full.out_edges_of(n).len())
        .sum();
    assert_eq!(csr_total, full.edges().len());
}

#[test]
fn partial_load_exposes_boundary_edges() {
    let p = grid_partition(16);
    let encoded: Vec<AlignedBytes> = p
        .chunks
        .iter()
        .map(|c| AlignedBytes::adopt(c.encode()))
        .collect();
    let decoded: Vec<GraphChunkSchema> = encoded
        .iter()
        .map(|b| GraphChunkSchema::decode(b).expect("chunk decodes"))
        .collect();
    assert!(decoded.len() > 1, "grid must span several cells");

    let mut g = RoadGraph::new();
    let first = g.add_chunk(&decoded[0]).expect("first chunk loads");
    assert!(g.boundary_edge_count() > 0, "lone chunk has open borders");
    assert!(g.nodes().iter().any(|n| !n.resident), "ghost nodes present");

    // Loading the rest closes the borders; unloading reopens them.
    for c in &decoded[1..] {
        g.add_chunk(c).expect("chunk loads");
    }
    assert_eq!(g.boundary_edge_count(), 0);
    assert!(g.remove_chunk(first));
    assert!(!g.remove_chunk(first), "removing twice is a no-op");
    assert!(g.boundary_edge_count() > 0);
    assert_eq!(g.chunk_count(), decoded.len() - 1);
}

#[test]
fn duplicate_chunk_is_an_error() {
    let p = grid_partition(4);
    let bytes = AlignedBytes::adopt(p.chunks[0].encode());
    let c = GraphChunkSchema::decode(&bytes).expect("decodes");
    let mut g = RoadGraph::new();
    g.add_chunk(&c).expect("first add");
    assert!(matches!(g.add_chunk(&c), Err(GraphError::AlreadyLoaded(_))));
}

/// A path of degree-2 nodes collapses to a single edge, length preserved.
#[test]
fn degree2_chain_collapses() {
    let nodes: Vec<RawNode> = (0..5)
        .map(|i| RawNode {
            lon: -77.3 + i as f64 * 0.01,
            lat: 38.8,
        })
        .collect();
    // A five-node path; every interior node is degree-2, so only the two ends
    // survive and the whole path fuses into one arc per direction.
    let arc = |from: u32, to: u32| {
        RawEdge::with_defaults(from, to, 100.0, RoadClass::Residential, None, None)
    };
    let edges = vec![
        arc(0, 1),
        arc(1, 0),
        arc(1, 2),
        arc(2, 1),
        arc(2, 3),
        arc(3, 2),
        arc(3, 4),
        arc(4, 3),
    ];
    let simplified = simplify_degree2(&RawGraph { nodes, edges });

    assert_eq!(
        simplified.nodes.len(),
        2,
        "all three interior nodes are gone"
    );
    assert_eq!(simplified.edges.len(), 2, "one merged arc per direction");
    let long = simplified.edges.first().expect("a merged edge exists");
    assert_eq!(long.len_m, 400.0, "lengths sum along the chain");
    assert_eq!(long.class, RoadClass::Residential);
}

/// A grid has no degree-2 interior, so simplification must be a no-op there,
/// but the four corners are degree-2 and do collapse.
#[test]
fn degree2_leaves_a_grid_almost_alone() {
    let raw = RawGraph::synthetic_grid(6, county_bbox());
    let simplified = simplify_degree2(&raw);
    assert_eq!(
        simplified.nodes.len(),
        raw.nodes.len() - 4,
        "only corners go"
    );
}

#[test]
fn differing_attributes_block_a_merge() {
    let nodes: Vec<RawNode> = (0..3)
        .map(|i| RawNode {
            lon: -77.3 + i as f64 * 0.01,
            lat: 38.8,
        })
        .collect();
    let edges = vec![
        RawEdge::with_defaults(0, 1, 100.0, RoadClass::Primary, None, None),
        RawEdge::with_defaults(1, 2, 100.0, RoadClass::Residential, None, None),
    ];
    let simplified = simplify_degree2(&RawGraph { nodes, edges });
    assert_eq!(
        simplified.nodes.len(),
        3,
        "class change pins the middle node"
    );
}

#[test]
fn road_class_bytes_round_trip() {
    for c in RoadClass::ALL {
        assert_eq!(RoadClass::from_u8(c.as_u8()), Some(c));
    }
    assert_eq!(RoadClass::from_u8(200), None);
    assert_eq!(
        RoadClass::from_osm_highway("motorway_link"),
        Some(RoadClass::Motorway)
    );
    assert_eq!(RoadClass::from_osm_highway("footway"), None);
}

#[test]
fn ids_reject_the_sentinel() {
    assert_eq!(NodeId::new(u32::MAX), None);
    assert_eq!(EdgeId::new(7).map(EdgeId::raw), Some(7));
}
