//! Portable host-driven post coordination. Protocols live in `feedtorrent-bep`.
//! This crate has no network, filesystem, browser, OS clock or native backend.
//! Drain actions only after durably storing and acknowledging a dirty checkpoint.
//! Persisted references are replay hints: after restoration they cannot authorize
//! downloads until their signed root and parent catalog have been revalidated.
//! Runtime work IDs are session-local. In-flight work is rebuilt from these hints,
//! verified local metadata and the host's durable transfer registry. The host
//! must report an absent/failed result or cancel accepted work; a paused transfer
//! must never be resumed merely to satisfy an automatic action.
//! The optional event queue is advisory and bounded; snapshots are authoritative.
//! The host must stage torrents without piece requests and acknowledge approvals
//! durably before releasing their payload. Inputs use the same monotonic clock.
//!
//! ```
//! use feedtorrent_posts::{PostManager,Config};
//! let mut posts=PostManager::new();
//! let uri="magnet:?xs=urn:btpk:d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
//! let id=posts.follow(uri,Config::default(),0)?;
//! let bytes=posts.checkpoint()?; // The host writes these atomically.
//! posts.acknowledge_checkpoint();
//! assert!(!posts.drain_actions().is_empty());
//! let mut restored=PostManager::restore(&bytes)?;
//! restored.start(0);
//! assert_eq!(restored.views()[0].id,id);
//! # Ok::<(),feedtorrent_posts::Error>(())
//! ```
mod manager;
mod model;
pub use manager::PostManager;
pub use model::*;

#[cfg(test)]
mod tests;

pub mod markdown;
pub mod publishing;
