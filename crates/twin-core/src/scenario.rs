//! `Scenario`: the ADT of edits the UI can make to the road network, and the
//! overlay view that applies them.
//!
//! Applying a scenario never touches the base graph. The overlay holds one
//! entry per *edited* edge — a handful, even for an ambitious scenario — so a
//! `ScenarioView` costs bytes, not megabytes, and the same base `RoadGraph`
//! backs the baseline and every variant at once.

use crate::graph::{GraphEdge, GraphView};
use crate::ids::{EdgeId, NodeId, RoadClass};
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
    /// A new link between two existing nodes. It joins the view as an overlay
    /// edge, after every base edge, with an id from
    /// [`EdgeId::OVERLAY_START`] up.
    AddEdge {
        from: NodeId,
        to: NodeId,
        lanes: u8,
        speed_mps: f32,
        /// Omitted means "the class default for this many lanes".
        capacity_vph: Option<f32>,
        /// `[lon, lat]` along the new link. Empty means a straight line
        /// between the two nodes, which is what the length falls back to.
        geometry: Vec<[f32; 2]>,
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
    /// Edges the scenario added, in dense order after every base edge.
    extra: Vec<OverlayEdge>,
    /// For each node an overlay edge leaves, its base out-edges followed by the
    /// added ones. Absent for the untouched majority, which reads the base CSR
    /// slice directly.
    grown_out: HashMap<u32, Vec<u32>>,
    warnings: Vec<String>,
}

/// One added edge. Dense endpoints, so the solver reads it exactly as it reads
/// a base row.
#[derive(Clone, Debug)]
struct OverlayEdge {
    id: EdgeId,
    from: u32,
    to: u32,
    attrs: EdgeAttrs,
}

/// Metres between two lon/lat points, flat-earth over a county.
fn metres_between(a: [f32; 2], b: [f32; 2]) -> f32 {
    const METRES_PER_DEGREE: f32 = 111_320.0;
    let mid_lat = (0.5 * (a[1] + b[1])).to_radians();
    let dx = (b[0] - a[0]) * METRES_PER_DEGREE * mid_lat.cos();
    let dy = (b[1] - a[1]) * METRES_PER_DEGREE;
    (dx * dx + dy * dy).sqrt()
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
        let mut extra: Vec<OverlayEdge> = Vec::new();
        let mut grown_out: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut warnings: Vec<String> = Vec::new();

        for edit in &scenario.edits {
            let target = match edit {
                Edit::CloseEdge(e) | Edit::SetEdge { edge: e, .. } => Some(*e),
                _ => None,
            };
            let dense = target.and_then(|e| index_of_edge.get(&e).copied());
            match (edit, dense) {
                (
                    Edit::AddEdge {
                        from,
                        to,
                        lanes,
                        speed_mps,
                        capacity_vph,
                        geometry,
                    },
                    _,
                ) => {
                    let ends = base.index_of(*from).zip(base.index_of(*to));
                    let Some((a, b)) = ends else {
                        warnings.push(format!(
                            "AddEdge {}->{} ignored: an endpoint is not in the loaded study area",
                            from.raw(),
                            to.raw()
                        ));
                        continue;
                    };
                    let ends_lonlat = [a, b].map(|v| {
                        let n = &base.nodes()[v as usize];
                        [n.lon, n.lat]
                    });
                    let shape: Vec<[f32; 2]> = match geometry.len() >= 2 {
                        true => geometry.clone(),
                        false => ends_lonlat.to_vec(),
                    };
                    let len_m: f32 = shape
                        .windows(2)
                        .map(|w| metres_between(w[0], w[1]))
                        .sum::<f32>()
                        .max(1.0);
                    let lanes = (*lanes).max(1);
                    let speed = speed_mps.max(f32::EPSILON);
                    let index = (base.edges().len() + extra.len()) as u32;
                    grown_out
                        .entry(a)
                        .or_insert_with(|| base.out_edges_of(a as usize).to_vec())
                        .push(index);
                    extra.push(OverlayEdge {
                        id: EdgeId::from_index(EdgeId::OVERLAY_START + extra.len() as u32),
                        from: a,
                        to: b,
                        attrs: EdgeAttrs {
                            len_m,
                            free_flow_s: len_m / speed,
                            // The county defaults are per lane and per class;
                            // an added link has no class, so a plain arterial
                            // lane is the honest guess.
                            capacity_vph: capacity_vph
                                .unwrap_or(RoadClass::Primary.lane_capacity_vph() * lanes as f32)
                                .max(1.0),
                            open: true,
                        },
                    });
                }
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
            extra,
            grown_out,
            warnings,
        }
    }

    /// The baseline: no edits, no overlay.
    pub fn base(base: GraphView<'a>) -> Self {
        Self {
            base,
            patch: HashMap::new(),
            extra: Vec::new(),
            grown_out: HashMap::new(),
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
        self.base.edges().len() + self.extra.len()
    }

    /// Edges the scenario added, as `(id, from, to)` over dense node indices.
    /// The UI needs them to draw a link the base tiles do not have.
    pub fn added_edges(&self) -> impl Iterator<Item = (EdgeId, u32, u32)> + '_ {
        self.extra.iter().map(|e| (e.id, e.from, e.to))
    }

    #[inline]
    fn overlay(&self, e: usize) -> Option<&OverlayEdge> {
        self.extra.get(e.wrapping_sub(self.base.edges().len()))
    }

    pub fn node_count(&self) -> usize {
        self.base.nodes().len()
    }

    #[inline]
    pub fn attrs(&self, e: usize) -> EdgeAttrs {
        match (self.patch.get(&(e as u32)), self.overlay(e)) {
            (Some(a), _) => *a,
            (None, Some(x)) => x.attrs,
            (None, None) => EdgeAttrs::of(&self.base.edges()[e]),
        }
    }

    /// Every edge's attributes, in dense edge order. The solver takes this once
    /// per run; the base arrays are still never copied more than this.
    pub fn attrs_all(&self) -> Vec<EdgeAttrs> {
        (0..self.edge_count()).map(|e| self.attrs(e)).collect()
    }

    #[inline]
    pub fn head_of(&self, e: usize) -> u32 {
        match self.overlay(e) {
            Some(x) => x.to,
            None => self.base.edges()[e].to,
        }
    }

    #[inline]
    pub fn tail_of(&self, e: usize) -> u32 {
        match self.overlay(e) {
            Some(x) => x.from,
            None => self.base.edges()[e].from,
        }
    }

    #[inline]
    pub fn out_edges_of(&self, n: usize) -> &[u32] {
        match self.grown_out.get(&(n as u32)) {
            Some(v) => v,
            None => self.base.out_edges_of(n),
        }
    }

    pub fn edge_id(&self, e: usize) -> EdgeId {
        match self.overlay(e) {
            Some(x) => x.id,
            None => self.base.edges()[e].id,
        }
    }

    pub fn index_of_node(&self, id: NodeId) -> Option<u32> {
        self.base.index_of(id)
    }
}
