//! Reusable torrent contracts and validation, independent of any backend or UI.
mod backend;
mod magnet;
pub use backend::*;
pub use magnet::{normalize_magnet_input, valid_id};

pub mod bep44;

pub mod bep46;
