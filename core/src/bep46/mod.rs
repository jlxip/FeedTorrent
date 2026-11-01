//! BEP 46 torrent pointers over signed BEP 44 records.
//!
//! The host owns keys, known versions, polling, republication and downloads.
//! These helpers never start background work or discard host-owned state.
//!
//! ```
//! use feedtorrent_core::bep44::{Bep44Signer, DhtOutcome};
//! use feedtorrent_core::bep46::{TorrentPointer, format_magnet, parse_magnet, resolve, Resolution};
//! let signer = Bep44Signer::from_seed(&[7; 32]);
//! let published = TorrentPointer::sign(&signer, [42; 20], 1, vec![])?;
//! let identity = parse_magnet(&format_magnet(published.key()))?;
//! let response = Ok(DhtOutcome::Mutable(Some(published.record().clone())));
//! let Resolution::Found { pointer, .. } = resolve(&identity, None, response)? else {
//!     panic!("This example supplied a record");
//! };
//! assert_eq!(pointer.infohash(), [42; 20]);
//! // The host may submit pointer.publication() to DhtBackend to republish it.
//! # Ok::<(), feedtorrent_core::bep46::Error>(())
//! ```
use crate::bep44::{
    select_mutable, BencodedValue, Bep44Signer, DhtError, DhtOutcome, DhtRequest, MutableKey,
    MutableRecord, ValidationError,
};
use bendy::{
    decoding::{Decoder, FromBencode},
    value::Value,
};
use std::fmt;

pub type InfoHash = [u8; 20];
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidMagnet(String),
    InvalidPayload,
    InvalidRecord(ValidationError),
    Dht(DhtError),
    UnexpectedOutcome,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BEP 46: {self:?}")
    }
}
impl std::error::Error for Error {}
impl From<ValidationError> for Error {
    fn from(error: ValidationError) -> Self {
        Self::InvalidRecord(error)
    }
}
impl From<DhtError> for Error {
    fn from(error: DhtError) -> Self {
        Self::Dht(error)
    }
}
type Result<T> = std::result::Result<T, Error>;
fn invalid(message: &str) -> Error {
    Error::InvalidMagnet(message.into())
}
fn digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
fn unhex(bytes: &[u8]) -> Result<Vec<u8>> {
    if !bytes.len().is_multiple_of(2) {
        return Err(invalid("Odd hexadecimal length"));
    }
    bytes
        .chunks_exact(2)
        .map(|pair| {
            let high = digit(pair[0]).ok_or_else(|| invalid("Invalid hexadecimal digit"))?;
            let low = digit(pair[1]).ok_or_else(|| invalid("Invalid hexadecimal digit"))?;
            Ok(high * 16 + low)
        })
        .collect()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn percent_decode(input: &str) -> Result<Vec<u8>> {
    let mut bytes = input.as_bytes().iter().copied();
    let mut out = Vec::with_capacity(input.len());
    while let Some(b) = bytes.next() {
        out.push(match b {
            b'%' => {
                let high = bytes
                    .next()
                    .and_then(digit)
                    .ok_or_else(|| invalid("Invalid percent encoding"))?;
                let low = bytes
                    .next()
                    .and_then(digit)
                    .ok_or_else(|| invalid("Invalid percent encoding"))?;
                high * 16 + low
            }
            b'+' => b' ',
            other => other,
        });
    }
    Ok(out)
}
/// Parse identity only. Additional parameters are validated but not retained or used.
pub fn parse_magnet(input: &str) -> Result<MutableKey> {
    let input = input.trim();
    if input.chars().any(|c| c.is_whitespace() || c.is_control()) || input.contains('#') {
        return Err(invalid(
            "Unexpected whitespace, control character or fragment",
        ));
    }
    let (scheme, query) = input
        .split_once('?')
        .ok_or_else(|| invalid("Missing magnet query"))?;
    if !scheme.eq_ignore_ascii_case("magnet:") {
        return Err(invalid("Expected magnet scheme"));
    }
    let mut public_key = None;
    let mut salt = None;
    for field in query.split('&').filter(|p| !p.is_empty()) {
        let (name, value) = field.split_once('=').unwrap_or((field, ""));
        let name = percent_decode(name)?;
        let value = percent_decode(value)?;
        match name.as_slice() {
            b"xs" => {
                if public_key.is_some() {
                    return Err(invalid("Duplicate xs"));
                }
                if !value
                    .get(..9)
                    .is_some_and(|p| p.eq_ignore_ascii_case(b"urn:btpk:"))
                    || value.len() != 73
                {
                    return Err(invalid(
                        "Expected urn:btpk and a 32-byte hexadecimal public key",
                    ));
                }
                public_key = Some(
                    unhex(&value[9..])?
                        .try_into()
                        .map_err(|_| invalid("Invalid public key size"))?,
                );
            }
            b"s" => {
                if salt.is_some() {
                    return Err(invalid("Duplicate s"));
                }
                if value.len() > 128 {
                    return Err(invalid("Salt exceeds 64 bytes"));
                }
                salt = Some(unhex(&value)?);
            }
            _ => {}
        }
    }
    MutableKey::new(
        public_key.ok_or_else(|| invalid("Missing xs=urn:btpk identity"))?,
        salt.unwrap_or_default(),
    )
    .map_err(|e| invalid(&e.to_string()))
}
/// Canonical BEP 46 magnet; a zero-length salt is omitted.
pub fn format_magnet(key: &MutableKey) -> String {
    let mut uri = format!("magnet:?xs=urn:btpk:{}", hex(&key.public_key()));
    if !key.salt().is_empty() {
        uri.push_str("&s=");
        uri.push_str(&hex(key.salt()));
    }
    uri
}
/// Minimal canonical payload. The infohash is binary, not hexadecimal text.
pub fn encode_payload(infohash: InfoHash) -> BencodedValue {
    let mut bytes = b"d2:ih20:".to_vec();
    bytes.extend_from_slice(&infohash);
    bytes.push(b'e');
    BencodedValue::parse(&bytes).expect("Fixed-size canonical BEP 46 payload")
}
pub fn decode_payload(value: &BencodedValue) -> Result<InfoHash> {
    // BencodedValue already enforces canonical form, size and depth limits.
    let Value::Dict(fields) = Value::decode_bencode_object(
        Decoder::new(value.as_bytes())
            .with_max_depth(64)
            .next_object()
            .map_err(|_| Error::InvalidPayload)?
            .ok_or(Error::InvalidPayload)?,
    )
    .map_err(|_| Error::InvalidPayload)?
    else {
        return Err(Error::InvalidPayload);
    };
    let Some(Value::Bytes(ih)) = fields.get(b"ih".as_slice()) else {
        return Err(Error::InvalidPayload);
    };
    ih.as_ref().try_into().map_err(|_| Error::InvalidPayload)
}
/// Verified public record, including all signed extension fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TorrentPointer {
    record: MutableRecord,
    infohash: InfoHash,
}
impl TorrentPointer {
    pub fn from_record(expected: &MutableKey, record: MutableRecord) -> Result<Self> {
        record.verify_for(expected)?;
        let infohash = decode_payload(record.value())?;
        Ok(Self { record, infohash })
    }
    pub fn sign(
        signer: &Bep44Signer,
        infohash: InfoHash,
        sequence: i64,
        salt: Vec<u8>,
    ) -> Result<Self> {
        let record = signer.sign(encode_payload(infohash), sequence, salt)?;
        Ok(Self { record, infohash })
    }
    pub fn record(&self) -> &MutableRecord {
        &self.record
    }
    pub fn key(&self) -> &MutableKey {
        self.record.key()
    }
    pub fn sequence(&self) -> i64 {
        self.record.sequence()
    }
    pub fn infohash(&self) -> InfoHash {
        self.infohash
    }
    /// Reuse exact signed content; no secret key or new sequence is needed.
    pub fn publication(&self) -> DhtRequest {
        DhtRequest::PutMutable(self.record.clone())
    }
}
pub fn lookup(key: &MutableKey) -> DhtRequest {
    DhtRequest::GetMutable(key.clone())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerChange {
    Initial,
    Unchanged,
    Advanced { infohash_changed: bool },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    NotFound,
    Found {
        pointer: TorrentPointer,
        change: PointerChange,
    },
}
/// Interpret the matching GetMutable result from the host's request-ID routing.
/// Known state is borrowed: no lookup outcome can erase or overwrite it.
/// A newer sequence with the same infohash does not require another download.
pub fn resolve(
    expected: &MutableKey,
    known: Option<&TorrentPointer>,
    result: std::result::Result<DhtOutcome, DhtError>,
) -> Result<Resolution> {
    if let Some(known) = known {
        known.record.verify_for(expected)?;
    }
    let DhtOutcome::Mutable(item) = result? else {
        return Err(Error::UnexpectedOutcome);
    };
    let Some(record) = item else {
        return Ok(Resolution::NotFound);
    };
    let pointer = TorrentPointer::from_record(expected, record)?;
    select_mutable(known.map(|p| p.record()), pointer.record.clone())?;
    let change = match known {
        None => PointerChange::Initial,
        Some(old) if old.sequence() == pointer.sequence() => PointerChange::Unchanged,
        Some(old) => PointerChange::Advanced {
            infohash_changed: old.infohash != pointer.infohash,
        },
    };
    Ok(Resolution::Found { pointer, change })
}
/// Validate the matching PutMutable receipt. Acknowledgements are not durability.
pub fn publication_result(
    pointer: &TorrentPointer,
    result: std::result::Result<DhtOutcome, DhtError>,
) -> Result<u32> {
    match result? {
        DhtOutcome::Stored {
            target,
            acknowledged_nodes,
        } => {
            if target != pointer.key().target() {
                return Err(ValidationError::IdentityMismatch.into());
            }
            if acknowledged_nodes == 0 {
                return Err(DhtError::NoAcknowledgements.into());
            }
            Ok(acknowledged_nodes)
        }
        _ => Err(Error::UnexpectedOutcome),
    }
}
#[cfg(test)]
mod tests;
