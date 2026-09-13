//! `Scenario`: the ADT of edits the UI can make to the road network, and the
//! overlay view that applies them.
//!
//! Applying a scenario never touches the base graph. The overlay holds one
//! entry per *edited* edge — a handful, even for an ambitious scenario — so a
//! `ScenarioView` costs bytes, not megabytes, and the same base `RoadGraph`
//! backs the baseline and every variant at once.

use crate::graph::{GraphEdge, GraphView};
use crate::ids::{EdgeId, NodeId};
use std::collections::HashMap;

/// Metres per second from km/h. The wire format speaks m/s; the graph files
/// speak km/h.
#[inline]
pub fn kph_to_mps(kph: f32) -> f32 {
    kph * (1000.0 / 3600.0)
}

#[inline]
pub fn mps_to_kph(mps: f32) -> f32 {
    mps * 3.6
}

/// One user edit. An ADT rather than a struct of nullable fields, so
/// "close this edge" and "widen this edge" cannot be confused.
#[derive(Clone, Debug, PartialEq)]
pub enum Edit {
    /// Take the edge out of service. Traffic reroutes.
    CloseEdge(EdgeId),
    /// Change whichever attributes are given; the rest keep their base values.
    SetEdge {
        edge: EdgeId,
        lanes: Option<u8>,
        speed_mps: Option<f32>,
        capacity_vph: Option<f32>,
    },
    /// Not yet applied — the overlay cannot grow the node/edge arrays without
    /// copying them, which is Phase 3 work. Recorded as a warning.
    AddEdge {
        from: NodeId,
        to: NodeId,
        lanes: u8,
        speed_mps: f32,
    },
    /// Placeholder for the transit editor (DESIGN.md section 6).
    TransitEdit(TransitEdit),
}

/// Stub: the transit half of the scenario ADT, so the wire format does not have
/// to change when the editor lands.
#[derive(Clone, Debug, PartialEq)]
pub enum TransitEdit {
    Noop,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scenario {
    pub edits: Vec<Edit>,
}

impl Scenario {
    pub fn empty() -> Self {
        Self::default()
    }
}

/// The attributes the assignment reads off an edge. Produced identically from
/// a base row or from an overlay entry, so the solver never branches on
/// "edited or not".
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct EdgeAttrs {
    pub len_m: f32,
    pub free_flow_s: f32,
    pub capacity_vph: f32,
    pub open: bool,
}

impl EdgeAttrs {
    fn of(e: &GraphEdge) -> Self {
        Self {
            len_m: e.len_m,
            free_flow_s: e.free_flow_s(),
            capacity_vph: e.capacity_vph.max(1.0),
            open: true,
        }
    }
}

/// Base graph plus a sparse overlay. Reads go through [`Self::attrs`], which is
/// a slice read for the untouched majority and a small-map hit for the edited
/// few.
pub struct ScenarioView<'a> {
    base: GraphView<'a>,
    patch: HashMap<u32, EdgeAttrs>,
    warnings: Vec<String>,
}

impl<'a> ScenarioView<'a> {
    /// Fold the edits onto `base`. Edits naming an edge that is not loaded (or
    /// not yet implemented) are collected as warnings rather than failing the
    /// run: a scenario is a user document, and half of it applying is more
    /// useful than none of it.
    pub fn apply(base: GraphView<'a>, scenario: &Scenario) -> Self {
        let index_of_edge: HashMap<EdgeId, u32> = base
            .edges()
            .iter()
            .enumerate()
            .map(|(i, e)| (e.id, i as u32))
            .collect();
        let mut patch: HashMap<u32, EdgeAttrs> = HashMap::new();
        let mut warnings: Vec<String> = Vec::new();

        for edit in &scenario.edits {
            let target = match edit {
                Edit::CloseEdge(e) | Edit::SetEdge { edge: e, .. } => Some(*e),
                _ => None,
            };
            let dense = target.and_then(|e| index_of_edge.get(&e).copied());
            match (edit, dense) {
                (Edit::AddEdge { from, to, .. }, _) => warnings.push(format!(
                    "AddEdge {}->{} ignored: the overlay cannot grow the graph yet",
                    from.raw(),
                    to.raw()
                )),
                (Edit::TransitEdit(_), _) => {
                    warnings.push("TransitEdit ignored: no transit network loaded".into())
                }
                (_, None) => warnings.push(format!(
                    "edit on edge {} ignored: not in the loaded study area",
                    target.map(EdgeId::raw).unwrap_or_default()
                )),
                (Edit::CloseEdge(_), Some(i)) => {
                    let a = patch
                        .entry(i)
                        .or_insert_with(|| EdgeAttrs::of(&base.edges()[i as usize]));
                    a.open = false;
                }
                (
                    Edit::SetEdge {
                        lanes,
                        speed_mps,
                        capacity_vph,
                        ..
                    },
                    Some(i),
                ) => {
                    let row = &base.edges()[i as usize];
                    let a = patch.entry(i).or_insert_with(|| EdgeAttrs::of(row));
                    if let Some(v) = speed_mps {
                        a.free_flow_s = a.len_m / v.max(f32::EPSILON);
                    }
                    // Lanes without an explicit capacity rescale the base
                    // capacity per lane, which is how the base was derived.
                    if let Some(l) = lanes {
                        let per_lane = row.capacity_vph / row.lanes.max(1) as f32;
                        a.capacity_vph = (per_lane * (*l).max(1) as f32).max(1.0);
                    }
                    if let Some(c) = capacity_vph {
                        a.capacity_vph = c.max(1.0);
                    }
                }
            }
        }
        Self {
            base,
            patch,
            warnings,
        }
    }

    /// The baseline: no edits, no overlay.
    pub fn base(base: GraphView<'a>) -> Self {
        Self {
            base,
            patch: HashMap::new(),
            warnings: Vec::new(),
        }
    }

    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    pub fn graph(&self) -> &GraphView<'a> {
        &self.base
    }

    pub fn edge_count(&self) -> usize {
        self.base.edges().len()
    }

    pub fn node_count(&self) -> usize {
        self.base.nodes().len()
    }

    #[inline]
    pub fn attrs(&self, e: usize) -> EdgeAttrs {
        match self.patch.get(&(e as u32)) {
            Some(a) => *a,
            None => EdgeAttrs::of(&self.base.edges()[e]),
        }
    }

    /// Every edge's attributes, in dense edge order. The solver takes this once
    /// per run; the base arrays are still never copied more than this.
    pub fn attrs_all(&self) -> Vec<EdgeAttrs> {
        (0..self.edge_count()).map(|e| self.attrs(e)).collect()
    }

    #[inline]
    pub fn head_of(&self, e: usize) -> u32 {
        self.base.edges()[e].to
    }

    #[inline]
    pub fn tail_of(&self, e: usize) -> u32 {
        self.base.edges()[e].from
    }

    #[inline]
    pub fn out_edges_of(&self, n: usize) -> &'a [u32] {
        self.base.out_edges_of(n)
    }

    pub fn edge_id(&self, e: usize) -> EdgeId {
        self.base.edges()[e].id
    }

    pub fn index_of_node(&self, id: NodeId) -> Option<u32> {
        self.base.index_of(id)
    }
}
