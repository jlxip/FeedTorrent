use crate::{BackendError, Result};

pub fn normalize_magnet_input(input: &str) -> Result<String> {
    let input = input.trim();
    if input.starts_with("magnet:") {
        return Ok(input.to_owned());
    }
    if input.len() == 40 && input.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(format!(
            "magnet:?xt=urn:btih:{}",
            input.to_ascii_lowercase()
        ));
    }
    if input.len() == 32
        && input
            .bytes()
            .all(|b| b.is_ascii_alphabetic() || (b'2'..=b'7').contains(&b))
    {
        return Ok(format!(
            "magnet:?xt=urn:btih:{}",
            input.to_ascii_uppercase()
        ));
    }
    Err(BackendError::new(
        "Enter a magnet link or a v1 infohash: 40 hexadecimal or 32 Base32 characters",
    ))
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 40
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_preserves_magnet_parameters() {
        let uri = "magnet:?xt=urn:btih:56f31e2d486209003454e245d11561cd252be30f&dn=Sample&tr=https%3A%2F%2Fexample.org";
        assert_eq!(normalize_magnet_input(&format!("  {uri}\n")).unwrap(), uri);
        assert_eq!(
            normalize_magnet_input(" K3ZR4LKIMIEQANCU4JC5CFLBZUSSXYYP ").unwrap(),
            "magnet:?xt=urn:btih:K3ZR4LKIMIEQANCU4JC5CFLBZUSSXYYP"
        );
    }
    #[test]
    fn invalid_inputs_and_identifiers_are_rejected() {
        for invalid in [
            "",
            "123",
            "00000000000000000000000000000000",
            "56f31e2d486209003454e245d11561cd252be30z",
        ] {
            assert!(normalize_magnet_input(invalid).is_err());
        }
        assert!(valid_id("56f31e2d486209003454e245d11561cd252be30f"));
        assert!(!valid_id("../../x"));
    }
}
