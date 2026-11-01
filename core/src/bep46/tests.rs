use super::*;
const PK: &str = "8543d3e6115f0f98c944077a4493dcd543e49c739fd998550a1f614ab36ed63e";
fn hex20(s: &str) -> [u8; 20] {
    unhex(s.as_bytes()).unwrap().try_into().unwrap()
}
fn signer() -> Bep44Signer {
    Bep44Signer::from_seed(&[7; 32])
}
fn pointer(hash: u8, seq: i64) -> TorrentPointer {
    TorrentPointer::sign(&signer(), [hash; 20], seq, vec![]).unwrap()
}
fn outcome(p: &TorrentPointer) -> std::result::Result<DhtOutcome, DhtError> {
    Ok(DhtOutcome::Mutable(Some(p.record().clone())))
}
fn extra(hash: u8, seq: i64, n: u8) -> TorrentPointer {
    let mut raw = b"d2:ih20:".to_vec();
    raw.extend_from_slice(&[hash; 20]);
    raw.extend_from_slice(format!("1:xi{n}ee").as_bytes());
    let record = signer()
        .sign(BencodedValue::parse(&raw).unwrap(), seq, vec![])
        .unwrap();
    TorrentPointer::from_record(record.key(), record.clone()).unwrap()
}
#[test]
fn official_targets_and_magnet_normalization() {
    for (salt, target) in [
        ("", "cc3f9d90b572172053626f9980ce261a850d050b"),
        ("6e", "59ee7c2cb9b4f7eb1986ee2d18fd2fdb8a56554f"),
    ] {
        let suffix = if salt.is_empty() {
            String::new()
        } else {
            format!("&s={salt}")
        };
        let uri = format!("magnet:?xs=urn:btpk:{PK}{suffix}");
        let key = parse_magnet(&uri).unwrap();
        assert_eq!(key.target(), hex20(target));
        assert_eq!(format_magnet(&key), uri);
        assert_eq!(
            parse_magnet(&format!(
                " \nMAGNET:?xs=URN:BTPK:{}{} \t",
                PK.to_uppercase(),
                suffix.replace("6e", "6E")
            ))
            .unwrap(),
            key
        );
        assert_eq!(
            parse_magnet(&format!(
                "magnet:?dn=a+name&%78s=urn%3Abtpk%3A{PK}{suffix}&xt=urn:btih:ignored&tr=%FF"
            ))
            .unwrap(),
            key
        );
    }
    let plain = parse_magnet(&format!("magnet:?xs=urn:btpk:{PK}")).unwrap();
    assert_eq!(
        parse_magnet(&format!("magnet:?s=&xs=urn:btpk:{PK}")).unwrap(),
        plain
    );
    assert!(!format_magnet(&plain).contains("&s="));
    let max = format!("magnet:?s={}&xs=urn:btpk:{PK}", "FF".repeat(64));
    assert_eq!(parse_magnet(&max).unwrap().salt(), &[255; 64]);
}
#[test]
fn malformed_and_ambiguous_magnets_are_rejected() {
    let valid = format!("magnet:?xs=urn:btpk:{PK}");
    for uri in [
        "".into(),
        PK.into(),
        "magnet:?xt=urn:btih:56f31e2d486209003454e245d11561cd252be30f".into(),
        format!("https:?xs=urn:btpk:{PK}"),
        format!("magnet:?xs=urn:btih:{PK}"),
        format!("{valid}&xs=urn:btpk:{PK}"),
        format!("{valid}&%78s=urn:btpk:{PK}"),
        format!("{valid}&s=&s=01"),
        format!("{valid}&s=01&s=02"),
        format!("{valid}&s=0"),
        format!("{valid}&s=zz"),
        format!("{valid}&s={}", "aa".repeat(65)),
        format!("{valid}&dn=%"),
        format!("{valid}&dn=%ZZ"),
        format!("{valid}&dn=%0"),
        format!("{valid}#fragment"),
        format!("{valid}&s=00 00"),
        format!("{valid}&s=00+00"),
        format!("magnet:?xs=urn:btpk:{}", "00".repeat(32)),
        format!("magnet:?xs=urn:btpk:{}", "a".repeat(63)),
        format!("magnet:?xs=urn:btpk:{}", "a".repeat(65)),
        format!("magnet:?xs=urn:btpk:{}", "z".repeat(64)),
        format!("{valid}&s=%00"),
    ] {
        assert!(
            matches!(parse_magnet(&uri), Err(Error::InvalidMagnet(_))),
            "{uri}"
        );
    }
}
#[test]
fn binary_payload_extensions_and_incompatible_values() {
    let mut ih = [0; 20];
    ih[1] = 255;
    ih[2] = 128;
    assert_eq!(decode_payload(&encode_payload(ih)).unwrap(), ih);
    assert_eq!(encode_payload(ih).as_bytes().len(), 29);
    let extended = extra(255, 1, 2);
    assert_eq!(extended.infohash(), [255; 20]);
    assert_eq!(
        decode_payload(extended.record().value()).unwrap(),
        [255; 20]
    );
    for raw in [
        b"de".as_slice(),
        b"le",
        b"20:01234567890123456789",
        b"d2:ihi1ee",
        b"d2:ih0:e",
        b"d2:ih19:0123456789012345678e",
        b"d2:ih21:012345678901234567890e",
        b"d2:ih40:0123456789012345678901234567890123456789e",
    ] {
        assert_eq!(
            decode_payload(&BencodedValue::parse(raw).unwrap()),
            Err(Error::InvalidPayload)
        );
    }
    // Extension fields retain the same depth allowance as the BEP44 core.
    let mut raw = b"d2:ih20:".to_vec();
    raw.extend_from_slice(&ih);
    raw.extend_from_slice(b"1:x");
    raw.extend(vec![b'l'; 63]);
    raw.extend_from_slice(b"i0e");
    raw.extend(vec![b'e'; 64]);
    assert_eq!(
        decode_payload(&BencodedValue::parse(&raw).unwrap()).unwrap(),
        ih
    );
}
#[test]
fn signed_pointers_validate_identity_signature_sequence_and_salt() {
    let first = pointer(0, 0);
    let max = TorrentPointer::sign(&signer(), [255; 20], i64::MAX, vec![255; 64]).unwrap();
    assert_eq!(max.sequence(), i64::MAX);
    assert_eq!(max.key().salt().len(), 64);
    assert!(TorrentPointer::sign(&signer(), [0; 20], -1, vec![]).is_err());
    assert!(TorrentPointer::sign(&signer(), [0; 20], 0, vec![0; 65]).is_err());
    let foreign = MutableKey::new(Bep44Signer::from_seed(&[9; 32]).public_key(), vec![]).unwrap();
    assert_eq!(
        TorrentPointer::from_record(&foreign, first.record().clone()),
        Err(Error::InvalidRecord(ValidationError::IdentityMismatch))
    );
    let bad = signer()
        .sign(BencodedValue::parse(b"de").unwrap(), 1, vec![])
        .unwrap();
    assert_eq!(
        TorrentPointer::from_record(bad.key(), bad.clone()),
        Err(Error::InvalidPayload)
    );
    let mut sig = first.record().signature();
    sig[0] ^= 1;
    assert_eq!(
        MutableRecord::verify(
            first.key().clone(),
            first.sequence(),
            first.record().value().clone(),
            sig
        ),
        Err(ValidationError::InvalidSignature)
    );
    assert_eq!(lookup(first.key()).target(), first.key().target());
    assert_eq!(first.publication().target(), first.key().target());
}
#[test]
fn resolution_compares_entire_records_and_never_mutates_known_state() {
    let first = extra(1, 1, 1);
    let known = first.clone();
    assert!(matches!(
        resolve(first.key(), None, outcome(&first)).unwrap(),
        Resolution::Found {
            change: PointerChange::Initial,
            ..
        }
    ));
    assert!(matches!(
        resolve(first.key(), Some(&known), outcome(&first)).unwrap(),
        Resolution::Found {
            change: PointerChange::Unchanged,
            ..
        }
    ));
    for (next, changed) in [(extra(1, 2, 2), false), (extra(2, 2, 1), true)] {
        let Resolution::Found { pointer, change } =
            resolve(first.key(), Some(&known), outcome(&next)).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            change,
            PointerChange::Advanced {
                infohash_changed: changed
            }
        );
        assert_eq!(pointer, next);
    }
    assert_eq!(
        resolve(first.key(), Some(&known), outcome(&extra(1, 1, 2))),
        Err(Error::InvalidRecord(ValidationError::Conflict))
    );
    assert_eq!(
        resolve(first.key(), Some(&known), outcome(&pointer(1, 0))),
        Err(Error::InvalidRecord(ValidationError::Rollback))
    );
    assert_eq!(
        resolve(first.key(), Some(&known), Ok(DhtOutcome::Mutable(None))),
        Ok(Resolution::NotFound)
    );
    assert_eq!(
        resolve(first.key(), Some(&known), Err(DhtError::Timeout)),
        Err(Error::Dht(DhtError::Timeout))
    );
    assert_eq!(
        resolve(first.key(), Some(&known), Ok(DhtOutcome::Immutable(None))),
        Err(Error::UnexpectedOutcome)
    );
    let invalid = signer()
        .sign(BencodedValue::parse(b"de").unwrap(), 2, vec![])
        .unwrap();
    assert_eq!(
        resolve(
            first.key(),
            Some(&known),
            Ok(DhtOutcome::Mutable(Some(invalid)))
        ),
        Err(Error::InvalidPayload)
    );
    let foreign = TorrentPointer::sign(&signer(), [1; 20], 1, vec![1]).unwrap();
    assert_eq!(
        resolve(first.key(), Some(&foreign), Ok(DhtOutcome::Mutable(None))),
        Err(Error::InvalidRecord(ValidationError::IdentityMismatch))
    );
    assert_eq!(known, first);
}
#[test]
fn publication_receipts_are_checked_without_a_private_key() {
    let pointer = pointer(3, 1);
    let receipt = |target, n| {
        Ok(DhtOutcome::Stored {
            target,
            acknowledged_nodes: n,
        })
    };
    assert_eq!(
        publication_result(&pointer, receipt(pointer.key().target(), 3)),
        Ok(3)
    );
    assert_eq!(
        publication_result(&pointer, receipt(pointer.key().target(), 0)),
        Err(Error::Dht(DhtError::NoAcknowledgements))
    );
    assert_eq!(
        publication_result(&pointer, receipt([0; 20], 1)),
        Err(Error::InvalidRecord(ValidationError::IdentityMismatch))
    );
    assert_eq!(
        publication_result(&pointer, Err(DhtError::Conflict)),
        Err(Error::Dht(DhtError::Conflict))
    );
    assert_eq!(
        publication_result(&pointer, Ok(DhtOutcome::Mutable(None))),
        Err(Error::UnexpectedOutcome)
    );
    let DhtRequest::PutMutable(record) = pointer.publication() else {
        panic!()
    };
    assert_eq!(record, *pointer.record());
}
