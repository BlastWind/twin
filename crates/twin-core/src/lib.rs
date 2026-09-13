//! Pure core of the twin digital twin: ids, binary layouts, graph assembly.
//! No filesystem, no network, no globals — everything here is a function from
//! slices to values, so the same code runs natively and in wasm32.

pub mod assembly;
pub mod graph;
pub mod graph_schema;
pub mod grid;
pub mod ids;
pub mod schema;

pub use assembly::{partition, simplify_degree2, Partition, RawEdge, RawGraph, RawNode};
pub use graph::{GraphEdge, GraphError, GraphNode, RoadGraph};
pub use graph_schema::{
    ChunkBuild, ChunkEdge, ChunkEntrySchema, ChunkMetaSchema, ChunkNode, GraphChunkSchema,
    GraphIndexSchema,
};
pub use grid::{BBox, GridSchema, DEFAULT_CELL_M};
pub use ids::{ChunkId, EdgeId, NodeId, RoadClass};
pub use schema::{AlignedBytes, SchemaError};
