//! Pure core of the twin digital twin: ids, binary layouts, graph assembly.
//! No filesystem, no network, no globals — everything here is a function from
//! slices to values, so the same code runs natively and in wasm32.

pub mod assembly;
pub mod assign;
pub mod cch_order;
pub mod demand;
pub mod graph;
pub mod graph_schema;
pub mod grid;
pub mod ids;
pub mod routing;
pub mod scenario;
pub mod schema;

pub use assembly::{partition, simplify_degree2, Partition, Polyline, RawEdge, RawGraph, RawNode};
pub use assign::{all_or_nothing_pass, assign, free_flow_costs, AssignParams, HourResult, Kpis};
pub use cch_order::{CchOrderSchema, OrderKind};
pub use demand::{DemandMetaSchema, DemandSchema, OdTripleSchema, NHTS_HOUR_PROFILE};
pub use graph::{GraphEdge, GraphError, GraphNode, GraphView, RoadGraph};
pub use graph_schema::{
    ChunkBuild, ChunkEdge, ChunkEntrySchema, ChunkMetaSchema, ChunkNode, GeomCsr, GraphChunkSchema,
    GraphIndexSchema,
};
pub use grid::{BBox, GridSchema, DEFAULT_CELL_M};
pub use ids::{ChunkId, EdgeId, Hour, NodeId, RoadClass, ZoneId, HOURS_PER_DAY};
pub use routing::{nested_dissection_order, Skim};
pub use scenario::{Edit, Scenario, ScenarioView, TransitEdit};
pub use schema::{AlignedBytes, SchemaError};
