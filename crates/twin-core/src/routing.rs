//! Customizable contraction hierarchies over a loaded study area.
//!
//! The contraction order is metric-independent and comes from the pipeline
//! (`cch_order.bin`); only customization happens at runtime, and it is cheap
//! enough to redo whenever edge costs change.
//!
//! Two things are served from the same hierarchy: zone-to-zone skims and
//! point-to-point queries ([`Skim::distances`]), and the all-or-nothing loading
//! the equilibrium loop lives on ([`OneToAll`]). The loading path does *not*
//! need `cch`'s query API — it needs a whole shortest-path tree — but it does
//! not need a fork of `cch` either: [`cch::CchView`] and [`cch::MetricView`]
//! publish the elimination tree, both CSR halves and both weight arrays, which
//! is everything a PHAST sweep wants. See the crate README for the reasoning.

use crate::scenario::ScenarioView;
use cch::bundle::{CchView, MetricView, INVALID_ID};
use cch::graph::Graph;
use cch::{degree_order, distances_from, inertial_order, Cch, Customizer, Metric, INF_WEIGHT};

/// Cost unit on the wire to `cch`, which works in `u32`: hundredths of a
/// second. A county crossing is ~4e5 of these, so overflow is not a concern.
pub const COST_SCALE: f32 = 100.0;

/// Ceiling on a single arc's weight: 1e6 seconds. Closed edges price at
/// [`crate::assign`]'s `CLOSED_S`, which is far above this; clamping keeps a
/// path of a hundred closed edges below [`INF_WEIGHT`], so `saturating_add`
/// never manufactures a "reachable" node out of arithmetic.
const MAX_WEIGHT: f32 = 1.0e8;

/// Seconds to the `u32` cost unit. Never zero: [`OneToAll::load_tree`] walks
/// the predecessor tree, and a zero-weight arc would let equal-distance nodes
/// form a cycle in it.
#[inline]
pub fn seconds_to_weight(s: f32) -> u32 {
    ((s * COST_SCALE).clamp(0.0, MAX_WEIGHT) as u32).max(1)
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

    /// The hierarchy and its current metric, for [`OneToAll`].
    pub fn views(&self) -> (CchView<'_>, MetricView<'_>) {
        (self.cch.view(), self.metric.view())
    }

    /// One-to-many distances in hundredths of a second, in target order.
    pub fn distances(&self, source: u32, targets: &[u32]) -> Vec<u32> {
        distances_from(&self.cch.view(), &self.metric.view(), source, targets)
    }

    pub fn node_count(&self) -> usize {
        self.cch.node_count()
    }
}


/// Distances from one source to *every* node, plus the shortest-path tree over
/// the original edges — the pair all-or-nothing loading needs.
///
/// The distances come from a PHAST-style sweep: walk the source's elimination
/// tree to the root relaxing up-arcs, then run one linear pass over every node
/// in decreasing rank pulling from its up-neighbours. No priority queue, no
/// random-order settling, and no shortcut unpacking.
///
/// The tree comes afterwards, from the distances alone: an arc `u -> v` lies on
/// a shortest path exactly when `dist[u] + w(u,v) == dist[v]`. Because the
/// weights are integers, that test is exact, so the tree is recovered by one
/// sweep over the original arcs and never needs the shortcut hierarchy unpacked
/// at all.
pub struct OneToAll {
    /// Distances in CCH rank order, straight out of the sweep.
    by_rank: Vec<u32>,
    /// The same distances permuted back to dense node indices.
    dist: Vec<u32>,
    /// `pred[v]`: the dense edge index v is reached by, or [`NO_EDGE`].
    pred: Vec<u32>,
    /// How many tree children a node still owes before its load is final.
    pending: Vec<u32>,
    load: Vec<f32>,
    stack: Vec<u32>,
}

/// `pred` sentinel: no predecessor (the source, or an unreachable node).
pub const NO_EDGE: u32 = u32::MAX;

impl OneToAll {
    pub fn new(node_count: usize) -> Self {
        Self {
            by_rank: vec![INF_WEIGHT; node_count],
            dist: vec![INF_WEIGHT; node_count],
            pred: vec![NO_EDGE; node_count],
            pending: vec![0; node_count],
            load: vec![0.0; node_count],
            stack: Vec::with_capacity(node_count),
        }
    }

    /// Distances from `source` (a dense node index) to every node, in dense
    /// node order, in hundredths of a second. [`INF_WEIGHT`] means unreachable.
    pub fn run(&mut self, skim: &Skim, source: u32) -> &[u32] {
        let (cch, metric) = skim.views();
        let n = cch.node_count() as usize;
        let dist = &mut self.by_rank;
        dist.fill(INF_WEIGHT);

        // Up: the source's elimination-tree ancestors, in strictly ascending
        // rank, so each node's up-distance is final when it is relaxed from.
        let mut x = cch.rank[source as usize];
        dist[x as usize] = 0;
        loop {
            let (from, to) = arc_range(&cch, x);
            let dx = dist[x as usize];
            if dx != INF_WEIGHT {
                for (&y, &w) in cch.up_head[from..to].iter().zip(&metric.forward[from..to]) {
                    let cand = dx.saturating_add(w);
                    let slot = &mut dist[y as usize];
                    *slot = (*slot).min(cand);
                }
            }
            match cch.elimination_tree_parent[x as usize] {
                INVALID_ID => break,
                parent => x = parent,
            }
        }

        // Down: every node, once, in decreasing rank. Up-arcs always point at a
        // higher rank, so each node's neighbours are already final.
        for v in (0..n).rev() {
            let (from, to) = arc_range(&cch, v as u32);
            let mut best = dist[v];
            for (&y, &w) in cch.up_head[from..to].iter().zip(&metric.backward[from..to]) {
                let dy = dist[y as usize];
                if dy != INF_WEIGHT {
                    best = best.min(dy.saturating_add(w));
                }
            }
            dist[v] = best;
        }

        for v in 0..n {
            self.dist[v] = dist[cch.rank[v] as usize];
        }
        &self.dist
    }

    /// Push `dests`' trips back up the shortest-path tree implied by the last
    /// [`Self::run`], adding each arc's carried volume into `out`.
    ///
    /// `tail`/`head`/`weight` are the original arcs in dense edge order;
    /// `weight` must be the same `u32` costs the metric was customized with.
    /// Peeling leaves first means every node is visited once, so the cost does
    /// not depend on how many destinations there are.
    pub fn load_tree(
        &mut self,
        source: u32,
        tail: &[u32],
        head: &[u32],
        weight: &[u32],
        dests: &[(u32, f32)],
        out: &mut [f32],
    ) {
        let n = self.dist.len();
        self.pred[..n].fill(NO_EDGE);
        self.pending[..n].fill(0);
        self.load[..n].fill(0.0);

        for e in 0..weight.len() {
            let u = tail[e] as usize;
            let v = head[e] as usize;
            let du = self.dist[u];
            let on_tree = du != INF_WEIGHT
                && v != source as usize
                && self.pred[v] == NO_EDGE
                && du.saturating_add(weight[e]) == self.dist[v];
            if on_tree {
                self.pred[v] = e as u32;
                self.pending[u] += 1;
            }
        }

        for &(d, trips) in dests {
            if self.dist[d as usize] != INF_WEIGHT {
                self.load[d as usize] += trips;
            }
        }

        // Leaves first: a node's load is final once every child has drained.
        // Weights are >= 1, so distances strictly increase along the tree and
        // it cannot contain a cycle that would stall the peel.
        self.stack.clear();
        self.stack
            .extend((0..n as u32).filter(|&v| self.pending[v as usize] == 0));
        while let Some(v) = self.stack.pop() {
            let e = self.pred[v as usize];
            if e == NO_EDGE {
                continue;
            }
            let u = tail[e as usize] as usize;
            let carried = self.load[v as usize];
            if carried > 0.0 {
                out[e as usize] += carried;
                self.load[u] += carried;
            }
            self.pending[u] -= 1;
            if self.pending[u] == 0 {
                self.stack.push(u as u32);
            }
        }
    }
}

#[inline]
fn arc_range(cch: &CchView<'_>, v: u32) -> (usize, usize) {
    (
        cch.up_first_out[v as usize] as usize,
        cch.up_first_out[v as usize + 1] as usize,
    )
}

/// Restrict a whole-county contraction order (global node ids, as
/// `cch_order.bin` stores it) to the dense node indices of `view`.
///
/// Nodes the order does not mention — there should be none for a study area cut
/// out of the county the order was built on — are contracted first, where a
/// wrong guess costs the least.
pub fn restrict_order(view: &ScenarioView<'_>, global_rank: &[u32]) -> Vec<u32> {
    let n = view.node_count();
    let mut seen = vec![false; n];
    let mut kept: Vec<u32> = Vec::with_capacity(n);
    for &g in global_rank {
        let Some(v) = crate::ids::NodeId::new(g).and_then(|id| view.index_of_node(id)) else {
            continue;
        };
        if !std::mem::replace(&mut seen[v as usize], true) {
            kept.push(v);
        }
    }
    let mut order: Vec<u32> = (0..n as u32).filter(|&v| !seen[v as usize]).collect();
    order.append(&mut kept);
    order
}
