//! BEP 44 values, signing and network contracts, independent of any host.
//!
//! The host owns seeds, known versions and republication schedules. Backends only
//! receive public records. Values retain their exact canonical bencoding.
//!
//! ```
//! use feedtorrent_bep::bep44::{Bep44Signer, BencodedValue, MutableRecord, select_mutable};
//! let signer = Bep44Signer::from_seed(&[7; 32]); // Supply a securely held host seed.
//! let record = signer.sign(BencodedValue::bytestring(b"hello")?, 1, vec![])?;
//! let received = MutableRecord::verify(record.key().clone(), record.sequence(),
//!     record.value().clone(), record.signature())?;
//! received.verify_for(record.key())?;
//! let known = select_mutable(Some(&record), received)?;
//! # Ok::<(), feedtorrent_bep::bep44::ValidationError>(())
//! ```
//!
//! Secret holders deliberately cannot be formatted with Debug:
//! ```compile_fail
//! use feedtorrent_bep::bep44::Bep44Signer;
//! format!("{:?}", Bep44Signer::from_seed(&[7; 32]));
//! ```
mod item;
mod transport;
pub use item::*;
pub use transport::*;
#[cfg(test)]
mod tests;
