//! Customizable contraction hierarchies over a loaded study area.
//!
//! The contraction order is metric-independent and comes from the pipeline
//! (`cch_order.bin`); only customization happens at runtime, and it is cheap
//! enough to redo whenever edge costs change. Used for zone-to-zone skims and
//! for the point-to-point queries the UI asks for; the equilibrium loop needs
//! whole shortest-path *trees*, which a CCH one-to-many does not produce, so
//! [`crate::assign`] grows its own.

use crate::scenario::ScenarioView;
use cch::graph::Graph;
use cch::{degree_order, distances_from, inertial_order, Cch, Customizer, Metric};

/// Cost unit on the wire to `cch`, which works in `u32`: hundredths of a
/// second. A county crossing is ~4e5 of these, so overflow is not a concern.
pub const COST_SCALE: f32 = 100.0;

#[inline]
pub fn seconds_to_weight(s: f32) -> u32 {
    (s * COST_SCALE).clamp(0.0, (i32::MAX / 4) as f32) as u32
}

/// A nested-dissection contraction order over a whole graph, from the arc list
/// and node coordinates. Inertial flow is the quality option; the degree order
/// is the fallback for a graph with no usable geometry.
pub fn nested_dissection_order(
    node_count: u32,
    tail: &[u32],
    head: &[u32],
    lat: &[f32],
    lon: &[f32],
) -> Vec<u32> {
    match node_count {
        0 => Vec::new(),
        _ => inertial_order(node_count, tail, head, lat, lon),
    }
}

/// Degree order: no coordinates needed, much worse hierarchies. Kept as the
/// documented fallback of DESIGN.md section 9.
pub fn degree_fallback_order(first_out: &[u32], head: &[u32]) -> Vec<u32> {
    degree_order(&Graph {
        first_out: first_out.to_vec(),
        head: head.to_vec(),
        weight: vec![1; head.len()],
    })
}

/// A built hierarchy over the currently loaded study area, plus the mapping
/// from our dense edge ids to `cch`'s CSR arc ids.
pub struct Skim {
    cch: Cch,
    /// `edge_of_arc[a]` is the dense edge index that CSR arc `a` came from.
    edge_of_arc: Vec<u32>,
    metric: Metric,
}

impl Skim {
    /// Build the hierarchy. `order` is over the same dense node indices as
    /// `view`; pass [`nested_dissection_order`]'s output for the loaded graph,
    /// or a permutation restricted from `cch_order.bin`.
    pub fn build(view: &ScenarioView<'_>, order: &[u32]) -> Self {
        let n = view.node_count();
        let mut first_out = Vec::with_capacity(n + 1);
        let mut head = Vec::with_capacity(view.edge_count());
        let mut edge_of_arc = Vec::with_capacity(view.edge_count());
        first_out.push(0u32);
        for v in 0..n {
            for &e in view.out_edges_of(v) {
                head.push(view.head_of(e as usize));
                edge_of_arc.push(e);
            }
            first_out.push(head.len() as u32);
        }
        let graph = Graph {
            first_out,
            head,
            weight: vec![1u32; edge_of_arc.len()],
        };
        let cch = Cch::build(&graph, order);
        let metric = cch.customize(&graph.weight);
        Self {
            cch,
            edge_of_arc,
            metric,
        }
    }

    pub fn customizer(&self) -> Customizer<'_> {
        self.cch.customizer()
    }

    /// Re-price the hierarchy from per-edge travel times in seconds. Reuses the
    /// metric buffers, so a re-customize allocates nothing.
    pub fn customize_seconds(&mut self, cost_s: &[f32]) {
        let weights: Vec<u32> = self
            .edge_of_arc
            .iter()
            .map(|&e| seconds_to_weight(cost_s[e as usize]))
            .collect();
        // `customizer()` re-derives the level partition; holding one across
        // calls would need a self-referential struct, and the partition is a
        // small fraction of customization.
        self.cch
            .customizer()
            .customize_into(&weights, &mut self.metric);
    }

    /// One-to-many distances in hundredths of a second, in target order.
    pub fn distances(&self, source: u32, targets: &[u32]) -> Vec<u32> {
        distances_from(&self.cch.view(), &self.metric.view(), source, targets)
    }

    pub fn node_count(&self) -> usize {
        self.cch.node_count()
    }
}
