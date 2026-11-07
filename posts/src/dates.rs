//! Author-declared catalog dates, in Unix UTC seconds. No OS clock or I/O.
use crate::{err, Result};
use serde::{Deserialize, Serialize};
pub const MAX_BYTES: usize = 4096;
pub const MAX_TIMESTAMP: u64 = 253_402_300_799; // End of ISO year 9999.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Dates {
    pub created_at: Option<u64>,
    pub updated_at: u64,
}
impl Dates {
    pub fn new(created_at: Option<u64>, updated_at: u64) -> Result<Self> {
        if updated_at > MAX_TIMESTAMP || created_at.is_some_and(|t| t > updated_at) {
            return Err(err(
                "Invalid catalog dates: expected ordered Unix seconds through year 9999",
            ));
        }
        Ok(Self {
            created_at,
            updated_at,
        })
    }
    /// Invalid, absent, oversized or ambiguous metadata is optional, never content authority.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() > MAX_BYTES {
            return None;
        }
        serde_json::from_slice(bytes).ok()
    }
}
impl<'de> Deserialize<'de> for Dates {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            created_at: serde_json::Value,
            updated_at: u64,
        }
        let raw = Raw::deserialize(deserializer)?;
        let created_at = if raw.created_at.is_null() {
            None
        } else {
            Some(raw.created_at.as_u64().ok_or_else(|| {
                serde::de::Error::custom("created_at must be integer Unix seconds or null")
            })?)
        };
        Self::new(created_at, raw.updated_at).map_err(serde::de::Error::custom)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_metadata_has_strict_bounded_integer_dates() {
        for value in [
            r#"{}"#,
            r#"{"updated_at":1}"#,
            r#"{"created_at":null}"#,
            r#"{"created_at":-1,"updated_at":1}"#,
            r#"{"created_at":1.0,"updated_at":2}"#,
            r#"{"created_at":null,"updated_at":"1"}"#,
            r#"{"created_at":2,"updated_at":1}"#,
            r#"{"created_at":null,"updated_at":253402300800}"#,
            r#"{"created_at":null,"updated_at":1,"updated_at":2}"#,
            r#"{"created_at":null,"updated_at":1,"extra":true}"#,
        ] {
            assert!(Dates::parse(value.as_bytes()).is_none(), "{value}");
        }
        assert_eq!(
            Dates::parse(br#"{"created_at":0,"updated_at":0}"#),
            Some(Dates::new(Some(0), 0).unwrap())
        );
        assert_eq!(
            Dates::parse(br#"{"created_at":null,"updated_at":1}"#),
            Some(Dates::new(None, 1).unwrap())
        );
        let mut large = br#"{"created_at":0,"updated_at":1}"#.to_vec();
        large.resize(MAX_BYTES + 1, b' ');
        assert!(Dates::parse(&large).is_none());
    }
}
