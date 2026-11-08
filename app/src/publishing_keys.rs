//! Private material is confined to this host module and short-lived signing jobs.
use super::*;
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{aead::AeadInPlace, ChaCha20Poly1305, KeyInit, Nonce, Tag};
use feedtorrent_posts::unhex;
use zeroize::{Zeroize, Zeroizing};

const MAGIC: &[u8; 5] = b"FTKV\x01";
const HEADER: usize = 5 + 16 + 12;
const SIZE: usize = HEADER + 32 + 16;

#[derive(Deserialize)]
#[serde(transparent)]
pub struct Password(pub String);
impl Drop for Password {
    fn drop(&mut self) {
        self.0.zeroize()
    }
}
impl std::fmt::Debug for Password {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Vault {
    pub public_key: String,
    pub ciphertext: Vec<u8>,
}
fn check_password(password: &Password) -> Result<()> {
    if password.0.is_empty() || password.0.len() > 4096 {
        bail!("Enter a password between 1 and 4096 bytes")
    }
    Ok(())
}
fn derive(password: &Password, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    check_password(password)?;
    let params = Params::new(65536, 3, 4, Some(32))
        .map_err(|e| anyhow!("Invalid key derivation parameters: {e}"))?;
    let mut key = Zeroizing::new([0; 32]);
    let mut memory = Zeroizing::new(vec![argon2::Block::default(); params.block_count()]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into_with_memory(password.0.as_bytes(), salt, &mut *key, &mut memory[..])
        .map_err(|e| anyhow!("Key derivation failed: {e}"))?;
    Ok(key)
}
impl Vault {
    pub fn create(password: &Password) -> Result<Self> {
        check_password(password)?;
        let mut seed = Zeroizing::new([0u8; 32]);
        getrandom::fill(seed.as_mut()).map_err(|_| anyhow!("Cannot obtain key entropy"))?;
        let public_key = feedtorrent_posts::hex(
            &feedtorrent_bep::bep44::Bep44Signer::from_seed(&seed).public_key(),
        );
        let ciphertext = encrypt(&seed, password, &public_key)?;
        Ok(Self {
            public_key,
            ciphertext,
        })
    }
    pub fn validate(&self) -> Result<()> {
        if self.ciphertext.len() != SIZE || !self.ciphertext.starts_with(MAGIC) {
            bail!("Unsupported or invalid publishing key encryption; expected FTKV v1")
        }
        if unhex(&self.public_key)?.len() != 32 {
            bail!("Invalid publishing public key")
        }
        Ok(())
    }
    pub fn unlock(&self, password: &Password) -> Result<Zeroizing<[u8; 32]>> {
        self.validate()?;
        let key = derive(password, &self.ciphertext[5..21])?;
        let cipher = ChaCha20Poly1305::new_from_slice(&key[..])
            .map_err(|_| anyhow!("Invalid encryption key"))?;
        let mut aad = self.ciphertext[..HEADER].to_vec();
        aad.extend(unhex(&self.public_key)?);
        let mut seed = Zeroizing::new([0u8; 32]);
        seed.copy_from_slice(&self.ciphertext[HEADER..HEADER + 32]);
        cipher
            .decrypt_in_place_detached(
                Nonce::from_slice(&self.ciphertext[21..HEADER]),
                &aad,
                &mut seed[..],
                Tag::from_slice(&self.ciphertext[HEADER + 32..]),
            )
            .map_err(|_| anyhow!("Incorrect password or damaged key"))?;
        if feedtorrent_posts::hex(
            &feedtorrent_bep::bep44::Bep44Signer::from_seed(&seed).public_key(),
        ) != self.public_key
        {
            bail!("Encrypted key identity mismatch")
        }
        Ok(seed)
    }
    pub fn change(&self, old: &Password, new: &Password) -> Result<Self> {
        check_password(new)?;
        let seed = self.unlock(old)?;
        Ok(Self {
            public_key: self.public_key.clone(),
            ciphertext: encrypt(&seed, new, &self.public_key)?,
        })
    }
}
fn encrypt(seed: &[u8; 32], password: &Password, public_key: &str) -> Result<Vec<u8>> {
    let mut out = vec![0; HEADER];
    out[..5].copy_from_slice(MAGIC);
    getrandom::fill(&mut out[5..]).map_err(|_| anyhow!("Cannot obtain encryption entropy"))?;
    let key = derive(password, &out[5..21])?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| anyhow!("Invalid encryption key"))?;
    let mut aad = out.clone();
    aad.extend(unhex(public_key)?);
    let mut payload = Zeroizing::new(*seed);
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&out[21..]), &aad, &mut payload[..])
        .map_err(|_| anyhow!("Could not encrypt publishing key"))?;
    out.extend_from_slice(&payload[..]);
    out.extend_from_slice(&tag);
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_roundtrip_change_damage_and_redaction() {
        let old = Password("a long test passphrase".into());
        let new = Password("a different test passphrase".into());
        let vault = Vault::create(&old).unwrap();
        assert_eq!(vault.ciphertext.len(), SIZE);
        let seed = vault.unlock(&old).unwrap();
        assert!(vault.unlock(&new).is_err());
        let changed = vault.change(&old, &new).unwrap();
        assert_eq!(&*seed, &*changed.unlock(&new).unwrap());
        assert_eq!(changed.public_key, vault.public_key);
        assert!(changed.unlock(&old).is_err());
        let refreshed = changed.change(&new, &new).unwrap();
        assert_ne!(refreshed.ciphertext, changed.ciphertext);
        assert_eq!(&*seed, &*refreshed.unlock(&new).unwrap());
        for index in [0, 4, 5, 21, 33, 65, 80] {
            let mut broken = changed.clone();
            broken.ciphertext[index] ^= 1;
            assert!(broken.unlock(&new).is_err(), "tamper at {index}");
        }
        let mut wrong_identity = changed.clone();
        wrong_identity.public_key = "00".repeat(32);
        assert!(wrong_identity.unlock(&new).is_err());
        assert_eq!(format!("{old:?}"), "[REDACTED]");
    }
    #[test]
    fn rejects_malformed_envelopes_without_derivation() {
        for data in [
            b"unsupported key format".to_vec(),
            vec![],
            vec![0; SIZE],
            [MAGIC.as_slice(), &[0; 3]].concat(),
        ] {
            assert!(Vault {
                public_key: "00".repeat(32),
                ciphertext: data
            }
            .validate()
            .is_err());
        }
        assert!(Vault::create(&Password(String::new())).is_err());
        assert!(Vault::create(&Password("x".repeat(4097))).is_err());
    }
}
