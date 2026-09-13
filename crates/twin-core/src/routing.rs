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

    /// Arcs the hierarchy was built over, in the caller's dense edge numbering.
    pub fn arc_count(&self) -> usize {
        self.edge_of_arc.len()
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
    /// `pred[v]`: the dense edge index v is reached by, or [`NO_EDGE`]. Valid
    /// only where `stamp[v]` is the current generation.
    pred: Vec<u32>,
    /// Which origin's walk last wrote `pred[v]`. A counter beats clearing a
    /// node-sized array once per origin.
    stamp: Vec<u32>,
    generation: u32,
}

/// `pred` sentinel: no predecessor (the source, or an unreachable node).
pub const NO_EDGE: u32 = u32::MAX;

impl OneToAll {
    pub fn new(node_count: usize) -> Self {
        Self {
            by_rank: vec![INF_WEIGHT; node_count],
            dist: vec![INF_WEIGHT; node_count],
            pred: vec![NO_EDGE; node_count],
            stamp: vec![0; node_count],
            generation: 0,
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
    /// The tree is never materialised. Each destination walks back to the
    /// source one arc at a time, and a node's predecessor is found on demand by
    /// scanning its incoming arcs for the one that closes `dist[u] + w ==
    /// dist[v]`. Predecessors are cached under a generation stamp, so the
    /// shared upstream trunk — which is most of the walking — is resolved once
    /// per origin however many destinations cross it.
    ///
    /// The alternative, deriving the whole tree with one pass over every arc
    /// and peeling it leaves-first, is independent of the destination count but
    /// costs `O(nodes + arcs)` whatever the demand looks like; measured on the
    /// county it was 2.6 ms against this walk's 0.3 ms.
    pub fn load_tree(
        &mut self,
        source: u32,
        arcs: &InArcs<'_>,
        weight: &[u32],
        dests: &[(u32, f32)],
        out: &mut [f32],
    ) {
        self.generation += 1;
        for &(dest, trips) in dests {
            if self.dist[dest as usize] == INF_WEIGHT {
                continue;
            }
            let mut v = dest;
            while v != source {
                let e = self.predecessor(v, arcs, weight);
                if e == NO_EDGE {
                    break;
                }
                out[e as usize] += trips;
                v = arcs.tail[e as usize];
            }
        }
    }

    /// The arc `v` is reached by on a shortest path from the current source.
    /// Weights are >= 1, so `dist` strictly decreases along the chain and the
    /// walk in [`Self::load_tree`] always terminates.
    #[inline]
    fn predecessor(&mut self, v: u32, arcs: &InArcs<'_>, weight: &[u32]) -> u32 {
        if self.stamp[v as usize] == self.generation {
            return self.pred[v as usize];
        }
        let dv = self.dist[v as usize];
        let from = arcs.offsets[v as usize] as usize;
        let to = arcs.offsets[v as usize + 1] as usize;
        let found = arcs.edges[from..to]
            .iter()
            .copied()
            .find(|&e| {
                let du = self.dist[arcs.tail[e as usize] as usize];
                du != INF_WEIGHT && du.saturating_add(weight[e as usize]) == dv
            })
            .unwrap_or(NO_EDGE);
        self.stamp[v as usize] = self.generation;
        self.pred[v as usize] = found;
        found
    }
}

/// The original arcs indexed by head: what tree recovery walks backwards.
/// `edges[offsets[v]..offsets[v + 1]]` are the arcs entering `v`.
pub struct InArcs<'a> {
    pub offsets: &'a [u32],
    pub edges: &'a [u32],
    pub tail: &'a [u32],
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
