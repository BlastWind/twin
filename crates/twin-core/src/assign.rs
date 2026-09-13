//! Static user-equilibrium traffic assignment: BPR volume-delay, all-or-nothing
//! loading on shortest-path trees, biconjugate Frank-Wolfe descent.
//!
//! Everything here is a pure function of `(view, demand, hour, warm)`. The only
//! mutable state is the solver's own working arrays, which are `f32[E]`.

use crate::demand::{return_share, DemandSchema};
use crate::ids::{EdgeId, Hour};
use crate::scenario::{EdgeAttrs, ScenarioView};
use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// A cost high enough that no route uses a closed edge, but finite, so a
/// cut-off zone still produces numbers instead of `inf`.
const CLOSED_S: f32 = 1.0e7;

const METRES_PER_MILE: f64 = 1609.344;

/// BPR parameters and the convergence budget. DESIGN.md section 6 fixes
/// alpha/beta and the stopping rule; they are a struct so a bench or a test can
/// tighten them.
#[derive(Copy, Clone, Debug)]
pub struct AssignParams {
    pub alpha: f32,
    pub beta: f32,
    pub max_iters: u32,
    pub gap_tol: f32,
}

impl Default for AssignParams {
    fn default() -> Self {
        Self {
            alpha: 0.15,
            beta: 4.0,
            max_iters: 20,
            gap_tol: 1.0e-3,
        }
    }
}

/// Aggregate numbers for the dashboard.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Kpis {
    /// Vehicle-miles travelled in this hour.
    pub vmt: f64,
    /// Vehicle-hours travelled in this hour.
    pub vht: f64,
    /// Volume-weighted mean delay over free flow, in seconds per vehicle.
    pub mean_delay_s: f32,
    /// Worst volume/capacity ratios, descending.
    pub top_edges: Vec<(EdgeId, f32)>,
}

/// One hour of assignment. The three arrays are parallel to the view's dense
/// edge order.
#[derive(Clone, Debug)]
pub struct HourResult {
    pub hour: Hour,
    pub volume: Vec<f32>,
    pub vc: Vec<f32>,
    pub delay_s: Vec<f32>,
    pub kpis: Kpis,
    pub iterations: u32,
    pub rel_gap: f32,
}

/// BPR travel time in seconds.
#[inline]
fn bpr(a: &EdgeAttrs, flow: f32, p: &AssignParams) -> f32 {
    match a.open {
        false => CLOSED_S,
        true => a.free_flow_s * (1.0 + p.alpha * (flow / a.capacity_vph).powf(p.beta)),
    }
}

/// d(BPR)/d(flow): the diagonal Hessian the conjugate directions use.
#[inline]
fn bpr_deriv(a: &EdgeAttrs, flow: f32, p: &AssignParams) -> f32 {
    match a.open {
        false => 0.0,
        true => {
            a.free_flow_s * p.alpha * p.beta * (flow / a.capacity_vph).powf(p.beta - 1.0)
                / a.capacity_vph
        }
    }
}

/// One origin's demand: the dense node it loads at, and where its trips go.
struct OriginDemand {
    node: u32,
    dests: Vec<(u32, f32)>,
}

/// Turn the hour's OD cells into per-origin lists over *dense* node indices,
/// dropping zones whose centroid node is not in the loaded study area.
///
/// The single home->work matrix becomes a two-directional hour by splitting
/// each cell between the outbound pair and the reversed pair, weighted by
/// [`return_share`]: mornings run to work, evenings run home.
fn origins_for(
    view: &ScenarioView<'_>,
    demand: &DemandSchema<'_>,
    hour: Hour,
) -> Vec<OriginDemand> {
    let dense_of_zone: Vec<Option<u32>> = (0..demand.zone_count())
        .map(|z| crate::ids::NodeId::new(demand.zone_node[z]).and_then(|n| view.index_of_node(n)))
        .collect();
    let back = return_share(hour);
    let mut by_origin: std::collections::HashMap<u32, Vec<(u32, f32)>> =
        std::collections::HashMap::new();
    for (o, d, trips) in demand.trips_at(hour) {
        let (Some(on), Some(dn)) = (dense_of_zone[o.index()], dense_of_zone[d.index()]) else {
            continue;
        };
        if on == dn {
            continue;
        }
        let out = trips * (1.0 - back);
        let ret = trips * back;
        if out > 0.0 {
            by_origin.entry(on).or_default().push((dn, out));
        }
        if ret > 0.0 {
            by_origin.entry(dn).or_default().push((on, ret));
        }
    }
    let mut origins: Vec<OriginDemand> = by_origin
        .into_iter()
        .map(|(node, dests)| OriginDemand { node, dests })
        .collect();
    // Deterministic order, so a run is reproducible and rayon's fold is stable.
    origins.sort_unstable_by_key(|o| o.node);
    origins
}

/// Min-heap entry. `f32` has no `Ord`, so the comparison is spelled out with
/// `total_cmp` rather than smuggled in through a wrapper crate.
#[derive(Copy, Clone, PartialEq)]
struct Visit {
    cost: f32,
    node: u32,
}

impl Eq for Visit {}

impl Ord for Visit {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .cost
            .total_cmp(&self.cost)
            .then(other.node.cmp(&self.node))
    }
}

impl PartialOrd for Visit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Reusable per-origin scratch. Allocating this once per worker rather than
/// once per origin is most of the difference between a 2 s hour and a 20 s one.
struct Tree {
    dist: Vec<f32>,
    pred_edge: Vec<u32>,
    settled: Vec<u32>,
    load: Vec<f32>,
    heap: BinaryHeap<Visit>,
}

const NO_EDGE: u32 = u32::MAX;

impl Tree {
    fn new(nodes: usize) -> Self {
        Self {
            dist: vec![f32::INFINITY; nodes],
            pred_edge: vec![NO_EDGE; nodes],
            settled: Vec::with_capacity(nodes),
            load: vec![0.0; nodes],
            heap: BinaryHeap::new(),
        }
    }

    /// Grow the shortest-path tree from `source`, then push each destination's
    /// trips back up it. Loading in reverse settle order visits every node
    /// once, so the cost is independent of how many destinations there are.
    fn load_origin(
        &mut self,
        view: &ScenarioView<'_>,
        cost: &[f32],
        origin: &OriginDemand,
        out: &mut [f32],
    ) {
        for &v in &self.settled {
            self.dist[v as usize] = f32::INFINITY;
            self.pred_edge[v as usize] = NO_EDGE;
            self.load[v as usize] = 0.0;
        }
        self.settled.clear();
        self.heap.clear();

        self.dist[origin.node as usize] = 0.0;
        self.heap.push(Visit {
            cost: 0.0,
            node: origin.node,
        });
        while let Some(Visit { cost: d, node }) = self.heap.pop() {
            if d > self.dist[node as usize] {
                continue;
            }
            self.settled.push(node);
            for &e in view.out_edges_of(node as usize) {
                let head = view.head_of(e as usize) as usize;
                let nd = d + cost[e as usize];
                if nd < self.dist[head] {
                    self.dist[head] = nd;
                    self.pred_edge[head] = e;
                    self.heap.push(Visit {
                        cost: nd,
                        node: head as u32,
                    });
                }
            }
        }

        for &(dest, trips) in &origin.dests {
            if self.dist[dest as usize].is_finite() {
                self.load[dest as usize] += trips;
            }
        }
        for i in (0..self.settled.len()).rev() {
            let v = self.settled[i] as usize;
            let carried = self.load[v];
            if carried <= 0.0 {
                continue;
            }
            let e = self.pred_edge[v];
            if e == NO_EDGE {
                continue;
            }
            out[e as usize] += carried;
            self.load[view.tail_of(e as usize) as usize] += carried;
        }
    }
}

/// All-or-nothing: every trip on its cheapest path under `cost`.
fn all_or_nothing(view: &ScenarioView<'_>, cost: &[f32], origins: &[OriginDemand]) -> Vec<f32> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        origins
            .par_iter()
            .fold(
                || (Tree::new(view.node_count()), vec![0.0f32; cost.len()]),
                |(mut tree, mut acc), o| {
                    tree.load_origin(view, cost, o, &mut acc);
                    (tree, acc)
                },
            )
            .map(|(_, acc)| acc)
            .reduce(
                || vec![0.0f32; cost.len()],
                |mut a, b| {
                    a.iter_mut().zip(b).for_each(|(x, y)| *x += y);
                    a
                },
            )
    }
    #[cfg(target_arch = "wasm32")]
    {
        let mut tree = Tree::new(view.node_count());
        let mut acc = vec![0.0f32; cost.len()];
        for o in origins {
            tree.load_origin(view, cost, o, &mut acc);
        }
        acc
    }
}

/// Exact-enough line search: the Beckmann objective's derivative along the
/// direction is nondecreasing, so bisection on its sign is monotone and needs
/// no safeguards.
fn line_search(attrs: &[EdgeAttrs], x: &[f32], d: &[f32], p: &AssignParams) -> f32 {
    let phi = |lambda: f32| -> f32 {
        x.iter()
            .zip(d)
            .zip(attrs)
            .map(|((&xi, &di), a)| bpr(a, (xi + lambda * di).max(0.0), p) * di)
            .sum()
    };
    if phi(1.0) <= 0.0 {
        return 1.0;
    }
    if phi(0.0) >= 0.0 {
        return 0.0;
    }
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..30 {
        let mid = 0.5 * (lo + hi);
        if phi(mid) > 0.0 {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    0.5 * (lo + hi)
}

#[inline]
fn dot_h(h: &[f32], a: &[f32], b: &[f32]) -> f64 {
    h.iter()
        .zip(a)
        .zip(b)
        .map(|((&hi, &ai), &bi)| hi as f64 * ai as f64 * bi as f64)
        .sum()
}

/// The descent target: a feasible point the current flow moves toward.
///
/// Plain Frank-Wolfe uses the all-or-nothing point itself, which zig-zags.
/// Conjugating against the last one, and then against the last two
/// (biconjugate), makes each step count. Because every candidate is a convex
/// combination of feasible points, the result is feasible for any step in
/// `[0, 1]` — which is what lets the line search stay unconstrained.
fn descent_target(aon: &[f32], x: &[f32], prev: &[Vec<f32>], hess: &[f32]) -> Vec<f32> {
    let sub = |p: &[f32]| -> Vec<f32> { p.iter().zip(x).map(|(&a, &b)| a - b).collect() };
    let combine = |betas: &[f32], points: &[&[f32]]| -> Vec<f32> {
        (0..x.len())
            .map(|i| {
                betas
                    .iter()
                    .zip(points)
                    .map(|(&b, p)| b * p[i])
                    .sum::<f32>()
            })
            .collect()
    };
    let a = sub(aon);

    // Biconjugate: two conditions, two unknowns.
    if let [s1, s2, ..] = prev {
        let (b, c) = (sub(s1), sub(s2));
        let bma: Vec<f32> = b.iter().zip(&a).map(|(&p, &q)| p - q).collect();
        let cma: Vec<f32> = c.iter().zip(&a).map(|(&p, &q)| p - q).collect();
        let m11 = dot_h(hess, &b, &bma);
        let m12 = dot_h(hess, &b, &cma);
        let m21 = dot_h(hess, &c, &bma);
        let m22 = dot_h(hess, &c, &cma);
        let r1 = -dot_h(hess, &b, &a);
        let r2 = -dot_h(hess, &c, &a);
        let det = m11 * m22 - m12 * m21;
        if det.abs() > 1e-12 {
            let b1 = ((r1 * m22 - r2 * m12) / det) as f32;
            let b2 = ((m11 * r2 - m21 * r1) / det) as f32;
            let b0 = 1.0 - b1 - b2;
            let convex = b0 >= 0.0 && b1 >= 0.0 && b2 >= 0.0;
            if convex && b0.is_finite() {
                return combine(&[b0, b1, b2], &[aon, s1, s2]);
            }
        }
    }

    // Conjugate: one condition, one unknown.
    if let [s1, ..] = prev {
        let b = sub(s1);
        let bma: Vec<f32> = b.iter().zip(&a).map(|(&p, &q)| p - q).collect();
        let denom = dot_h(hess, &b, &bma);
        if denom.abs() > 1e-12 {
            let beta = (-dot_h(hess, &b, &a) / denom) as f32;
            if beta.is_finite() && (0.0..=0.99).contains(&beta) {
                return combine(&[1.0 - beta, beta], &[aon, s1]);
            }
        }
    }

    aon.to_vec()
}

/// One all-or-nothing loading at the given per-edge costs: every trip of the
/// hour on its cheapest path, nothing spread. This is the inner half of an
/// equilibrium iteration, and the thing worth benchmarking on its own.
pub fn all_or_nothing_pass(
    view: &ScenarioView<'_>,
    demand: &DemandSchema<'_>,
    hour: Hour,
    cost_s: &[f32],
) -> Vec<f32> {
    let origins = origins_for(view, demand, hour);
    all_or_nothing(view, cost_s, &origins)
}

/// Free-flow travel times, the natural starting costs.
pub fn free_flow_costs(view: &ScenarioView<'_>) -> Vec<f32> {
    (0..view.edge_count())
        .map(|e| {
            let a = view.attrs(e);
            match a.open {
                true => a.free_flow_s,
                false => CLOSED_S,
            }
        })
        .collect()
}

/// Static user-equilibrium assignment for one hour.
///
/// `warm` is the previous hour's volumes. It is used only to price the first
/// all-or-nothing pass: the iterate itself always starts from a feasible
/// loading, so a bad warm start costs an iteration and never correctness.
pub fn assign(
    view: &ScenarioView<'_>,
    demand: &DemandSchema<'_>,
    hour: Hour,
    warm: Option<&[f32]>,
    params: &AssignParams,
) -> HourResult {
    let e = view.edge_count();
    let attrs = view.attrs_all();
    let origins = origins_for(view, demand, hour);

    let priced =
        |flows: &[f32]| -> Vec<f32> { (0..e).map(|i| bpr(&attrs[i], flows[i], params)).collect() };

    let zero = vec![0.0f32; e];
    let seed = match warm {
        Some(w) if w.len() == e => w,
        _ => &zero,
    };
    let mut x = all_or_nothing(view, &priced(seed), &origins);
    // Most recent descent targets, newest first; two are enough for BFW.
    let mut prev: Vec<Vec<f32>> = Vec::new();
    let mut rel_gap = f32::INFINITY;
    let mut iterations = 0;

    for _ in 0..params.max_iters {
        iterations += 1;
        let cost = priced(&x);
        let aon = all_or_nothing(view, &cost, &origins);

        let total: f64 = cost
            .iter()
            .zip(&x)
            .map(|(&c, &f)| c as f64 * f as f64)
            .sum();
        let best: f64 = cost
            .iter()
            .zip(&aon)
            .map(|(&c, &f)| c as f64 * f as f64)
            .sum();
        rel_gap = match total > 0.0 {
            true => ((total - best) / total).abs() as f32,
            false => 0.0,
        };
        if rel_gap < params.gap_tol {
            break;
        }

        let hess: Vec<f32> = (0..e).map(|i| bpr_deriv(&attrs[i], x[i], params)).collect();
        let target = descent_target(&aon, &x, &prev, &hess);
        let dir: Vec<f32> = target.iter().zip(&x).map(|(&t, &xi)| t - xi).collect();
        let step = line_search(&attrs, &x, &dir, params);
        if step <= 0.0 {
            break;
        }
        x.iter_mut()
            .zip(&dir)
            .for_each(|(xi, &di)| *xi = (*xi + step * di).max(0.0));
        prev.insert(0, target);
        prev.truncate(2);
    }

    finish(view, &attrs, x, hour, params, iterations, rel_gap)
}

fn finish(
    view: &ScenarioView<'_>,
    attrs: &[EdgeAttrs],
    volume: Vec<f32>,
    hour: Hour,
    params: &AssignParams,
    iterations: u32,
    rel_gap: f32,
) -> HourResult {
    let vc: Vec<f32> = volume
        .iter()
        .zip(attrs)
        .map(|(&v, a)| v / a.capacity_vph)
        .collect();
    let delay_s: Vec<f32> = volume
        .iter()
        .zip(attrs)
        .map(|(&v, a)| (bpr(a, v, params) - a.free_flow_s).max(0.0))
        .collect();

    let vmt: f64 = volume
        .iter()
        .zip(attrs)
        .map(|(&v, a)| v as f64 * a.len_m as f64 / METRES_PER_MILE)
        .sum();
    let vht: f64 = volume
        .iter()
        .zip(attrs)
        .map(|(&v, a)| v as f64 * bpr(a, v, params) as f64 / 3600.0)
        .sum();
    let total_v: f64 = volume.iter().map(|&v| v as f64).sum();
    let weighted_delay: f64 = volume
        .iter()
        .zip(&delay_s)
        .map(|(&v, &d)| v as f64 * d as f64)
        .sum();
    let mean_delay_s = match total_v > 0.0 {
        true => (weighted_delay / total_v) as f32,
        false => 0.0,
    };

    let mut ranked: Vec<(EdgeId, f32)> = vc
        .iter()
        .enumerate()
        .filter(|(_, &r)| r > 0.0)
        .map(|(i, &r)| (view.edge_id(i), r))
        .collect();
    ranked.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));
    ranked.truncate(20);

    HourResult {
        hour,
        volume,
        vc,
        delay_s,
        kpis: Kpis {
            vmt,
            vht,
            mean_delay_s,
            top_edges: ranked,
        },
        iterations,
        rel_gap,
    }
}
