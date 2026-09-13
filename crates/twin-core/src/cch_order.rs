//! `cch_order.bin` — the metric-independent contraction order.
//!
//! The order is expensive (nested dissection over the whole county) and never
//! changes at runtime, so the pipeline computes it once and the browser only
//! ever reads it.

use crate::schema::*;
use bytemuck::{Pod, Zeroable};

#[derive(Copy, Clone, Debug, PartialEq, Eq, Zeroable, Pod)]
#[repr(C)]
pub struct CchOrderMetaSchema {
    /// Nodes the order covers: the whole county graph, not a study area.
    pub node_count: u32,
    /// 0 = inertial-flow nested dissection, 1 = degree order (fallback).
    pub kind: u32,
}

/// How the order was produced. An ADT rather than a bare byte so the two cases
/// cannot be confused at the call site.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum OrderKind {
    InertialFlow,
    Degree,
}

impl OrderKind {
    pub const fn as_u32(self) -> u32 {
        match self {
            Self::InertialFlow => 0,
            Self::Degree => 1,
        }
    }

    pub const fn from_u32(raw: u32) -> Option<Self> {
        match raw {
            0 => Some(Self::InertialFlow),
            1 => Some(Self::Degree),
            _ => None,
        }
    }
}

/// Decoded `cch_order.bin`, borrowed from the caller's bytes.
pub struct CchOrderSchema<'a> {
    pub meta: CchOrderMetaSchema,
    /// Contraction order: `rank[i]` is the global node id contracted `i`-th.
    pub rank: &'a [u32],
}

impl<'a> CchOrderSchema<'a> {
    pub fn decode(bytes: &'a [u8]) -> Result<Self, SchemaError> {
        let f = FileView::parse(bytes, MAGIC_CCH_ORDER, VERSION_CCH_ORDER)?;
        let out = Self {
            meta: f.one(SectionKind::CchOrderMeta)?,
            rank: f.section(SectionKind::CchOrderRank)?,
        };
        if out.rank.len() != out.meta.node_count as usize {
            return Err(SchemaError::InconsistentLength(SectionKind::CchOrderRank));
        }
        Ok(out)
    }

    pub fn encode(kind: OrderKind, rank: &[u32]) -> Vec<u8> {
        let meta = CchOrderMetaSchema {
            node_count: rank.len() as u32,
            kind: kind.as_u32(),
        };
        FileWriter::new()
            .push_one(SectionKind::CchOrderMeta, &meta)
            .push(SectionKind::CchOrderRank, rank)
            .finish(MAGIC_CCH_ORDER, VERSION_CCH_ORDER, 0)
    }

    pub fn kind(&self) -> Option<OrderKind> {
        OrderKind::from_u32(self.meta.kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_round_trips() {
        let rank = [3u32, 0, 2, 1];
        let bytes = AlignedBytes::adopt(CchOrderSchema::encode(OrderKind::InertialFlow, &rank));
        let d = CchOrderSchema::decode(&bytes).expect("decodes");
        assert_eq!(d.rank, rank.as_slice());
        assert_eq!(d.kind(), Some(OrderKind::InertialFlow));
    }
}
