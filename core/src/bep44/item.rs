use bendy::decoding::{Decoder, FromBencode};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use sha1::{Digest, Sha1};
use std::fmt;

pub type Target = [u8; 20];
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValidationError {
    InvalidValue(String),
    ValueTooLarge,
    InvalidSalt,
    InvalidSequence,
    InvalidKey,
    InvalidSignature,
    IdentityMismatch,
    Rollback,
    Conflict,
}
impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidValue(message) => write!(f, "Invalid bencoded value: {message}"),
            other => write!(f, "BEP 44: {other:?}"),
        }
    }
}
impl std::error::Error for ValidationError {}
type Result<T> = std::result::Result<T, ValidationError>;

/// Canonical bencoded value, at most 1000 encoded bytes and 64 container levels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BencodedValue(Vec<u8>);
impl BencodedValue {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 1000 {
            return Err(ValidationError::ValueTooLarge);
        }
        let invalid = |e: bendy::decoding::Error| ValidationError::InvalidValue(e.to_string());
        let mut decoder = Decoder::new(bytes).with_max_depth(64);
        let object = decoder
            .next_object()
            .map_err(invalid)?
            .ok_or_else(|| ValidationError::InvalidValue("Missing value".into()))?;
        bendy::value::Value::decode_bencode_object(object).map_err(invalid)?;
        if decoder.next_object().map_err(invalid)?.is_some() {
            return Err(ValidationError::InvalidValue("Trailing data".into()));
        }
        Ok(Self(bytes.to_vec()))
    }
    pub fn bytestring(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 1000 {
            return Err(ValidationError::ValueTooLarge);
        }
        let mut encoded = format!("{}:", bytes.len()).into_bytes();
        encoded.extend_from_slice(bytes);
        Self::parse(&encoded)
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImmutableItem {
    target: Target,
    value: BencodedValue,
}
impl ImmutableItem {
    pub fn new(value: BencodedValue) -> Self {
        Self {
            target: Sha1::digest(value.as_bytes()).into(),
            value,
        }
    }
    pub fn verify(target: Target, value: BencodedValue) -> Result<Self> {
        let item = Self::new(value);
        if item.target != target {
            return Err(ValidationError::IdentityMismatch);
        }
        Ok(item)
    }
    pub fn target(&self) -> Target {
        self.target
    }
    pub fn value(&self) -> &BencodedValue {
        &self.value
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MutableKey {
    public_key: [u8; 32],
    salt: Vec<u8>,
}
impl MutableKey {
    pub fn new(public_key: [u8; 32], salt: Vec<u8>) -> Result<Self> {
        if salt.len() > 64 {
            return Err(ValidationError::InvalidSalt);
        }
        let key = VerifyingKey::from_bytes(&public_key).map_err(|_| ValidationError::InvalidKey)?;
        if key.is_weak() {
            return Err(ValidationError::InvalidKey);
        }
        Ok(Self { public_key, salt })
    }
    pub fn public_key(&self) -> [u8; 32] {
        self.public_key
    }
    pub fn salt(&self) -> &[u8] {
        &self.salt
    }
    pub fn target(&self) -> Target {
        let mut hash = Sha1::new();
        hash.update(self.public_key);
        hash.update(&self.salt);
        hash.finalize().into()
    }
}
/// Contains no secret material and may be retained/reannounced by another host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MutableRecord {
    key: MutableKey,
    sequence: i64,
    value: BencodedValue,
    signature: [u8; 64],
}
impl MutableRecord {
    pub fn verify(
        key: MutableKey,
        sequence: i64,
        value: BencodedValue,
        signature: [u8; 64],
    ) -> Result<Self> {
        let bytes = signing_bytes(&value, sequence, key.salt())?;
        VerifyingKey::from_bytes(&key.public_key)
            .map_err(|_| ValidationError::InvalidKey)?
            .verify_strict(&bytes, &Signature::from_bytes(&signature))
            .map_err(|_| ValidationError::InvalidSignature)?;
        Ok(Self {
            key,
            sequence,
            value,
            signature,
        })
    }
    pub fn verify_for(&self, expected: &MutableKey) -> Result<()> {
        if &self.key != expected {
            return Err(ValidationError::IdentityMismatch);
        }
        Ok(())
    }
    pub fn key(&self) -> &MutableKey {
        &self.key
    }
    pub fn sequence(&self) -> i64 {
        self.sequence
    }
    pub fn value(&self) -> &BencodedValue {
        &self.value
    }
    pub fn signature(&self) -> [u8; 64] {
        self.signature
    }
}
/// Host-provided 32-byte seed. No Debug/serialization or OS randomness.
/// Dalek zeroizes its owned signing key when this object is dropped.
pub struct Bep44Signer(SigningKey);
impl Bep44Signer {
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self(SigningKey::from_bytes(seed))
    }
    pub fn public_key(&self) -> [u8; 32] {
        self.0.verifying_key().to_bytes()
    }
    pub fn sign(
        &self,
        value: BencodedValue,
        sequence: i64,
        salt: Vec<u8>,
    ) -> Result<MutableRecord> {
        let key = MutableKey::new(self.public_key(), salt)?;
        let signature = self
            .0
            .sign(&signing_bytes(&value, sequence, key.salt())?)
            .to_bytes();
        MutableRecord::verify(key, sequence, value, signature)
    }
}
pub fn signing_bytes(value: &BencodedValue, sequence: i64, salt: &[u8]) -> Result<Vec<u8>> {
    if sequence < 0 {
        return Err(ValidationError::InvalidSequence);
    }
    if salt.len() > 64 {
        return Err(ValidationError::InvalidSalt);
    }
    let mut bytes = Vec::new();
    if !salt.is_empty() {
        bytes.extend_from_slice(format!("4:salt{}:", salt.len()).as_bytes());
        bytes.extend_from_slice(salt);
    }
    bytes.extend_from_slice(format!("3:seqi{sequence}e1:v").as_bytes());
    bytes.extend_from_slice(value.as_bytes());
    Ok(bytes)
}
/// Compare against host-owned knowledge; no claim of global latest DHT state.
pub fn select_mutable(
    previous: Option<&MutableRecord>,
    incoming: MutableRecord,
) -> Result<MutableRecord> {
    if let Some(old) = previous {
        incoming.verify_for(old.key())?;
        if incoming.sequence < old.sequence {
            return Err(ValidationError::Rollback);
        }
        if incoming.sequence == old.sequence && incoming.value != old.value {
            return Err(ValidationError::Conflict);
        }
    }
    Ok(incoming)
}
