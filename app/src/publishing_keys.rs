//! Private material is confined to this host module and short-lived signing jobs.
use super::*;
use age::secrecy::SecretString;
use std::io::Read;
use zeroize::{Zeroize, Zeroizing};
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
impl Vault {
    pub fn create(password: &Password) -> Result<Self> {
        if password.0.is_empty() || password.0.len() > 4096 {
            bail!("Enter a password between 1 and 4096 bytes")
        }
        let mut seed = Zeroizing::new([0u8; 32]);
        getrandom::fill(seed.as_mut()).map_err(|_| anyhow!("Cannot obtain key entropy"))?;
        let public_key = feedtorrent_feeds::hex(
            &feedtorrent_bep::bep44::Bep44Signer::from_seed(&seed).public_key(),
        );
        Ok(Self {
            public_key,
            ciphertext: encrypt(&seed[..], password)?,
        })
    }
    pub fn unlock(&self, password: &Password) -> Result<Zeroizing<[u8; 32]>> {
        if password.0.len() > 4096 {
            bail!("Password exceeds 4096 bytes")
        }
        if self.ciphertext.len() > 4096 {
            bail!("Invalid encrypted key size")
        }
        let decryptor = age::Decryptor::new(&self.ciphertext[..])
            .map_err(|_| anyhow!("Invalid encrypted key"))?;
        let mut identity = age::scrypt::Identity::new(SecretString::from(password.0.clone()));
        identity.set_max_work_factor(20);
        let mut reader = decryptor
            .decrypt(std::iter::once(&identity as &dyn age::Identity))
            .map_err(|_| anyhow!("Incorrect password or damaged key"))?;
        let mut bytes = Zeroizing::new(Vec::new());
        reader
            .by_ref()
            .take(33)
            .read_to_end(&mut bytes)
            .map_err(|_| anyhow!("Incorrect password or damaged key"))?;
        if bytes.len() != 32 {
            bail!("Invalid signing seed")
        }
        let mut seed = Zeroizing::new([0; 32]);
        seed.copy_from_slice(&bytes);
        if feedtorrent_feeds::hex(
            &feedtorrent_bep::bep44::Bep44Signer::from_seed(&seed).public_key(),
        ) != self.public_key
        {
            bail!("Encrypted key identity mismatch")
        }
        Ok(seed)
    }
    pub fn change(&self, old: &Password, new: &Password) -> Result<Self> {
        if new.0.is_empty() || new.0.len() > 4096 {
            bail!("Enter a password between 1 and 4096 bytes")
        }
        let seed = self.unlock(old)?;
        Ok(Self {
            public_key: self.public_key.clone(),
            ciphertext: encrypt(&seed[..], new)?,
        })
    }
}
fn encrypt(seed: &[u8], password: &Password) -> Result<Vec<u8>> {
    let encryptor = age::Encryptor::with_user_passphrase(SecretString::from(password.0.clone()));
    let mut out = vec![];
    let mut writer = encryptor.wrap_output(&mut out)?;
    writer.write_all(seed)?;
    writer.finish()?;
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
        let seed = vault.unlock(&old).unwrap();
        assert!(vault.unlock(&new).is_err());
        let changed = vault.change(&old, &new).unwrap();
        assert_eq!(&*seed, &*changed.unlock(&new).unwrap());
        assert!(changed.unlock(&old).is_err());
        let mut broken = changed;
        let last = broken.ciphertext.len() - 1;
        broken.ciphertext[last] ^= 1;
        assert!(broken.unlock(&new).is_err());
        assert_eq!(format!("{old:?}"), "[REDACTED]");
    }
}
