use super::*;
fn hex<const N: usize>(s: &str) -> [u8; N] {
    assert_eq!(s.len(), N * 2);
    std::array::from_fn(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
}
#[test]
fn official_vectors() {
    let value = BencodedValue::parse(b"12:Hello World!").unwrap();
    assert_eq!(
        ImmutableItem::new(value.clone()).target(),
        hex("e5f96f6f38320f0f33959cb4d3d656452117aadb")
    );
    let pk = hex("77ff84905a91936367c01360803104f92432fcd904a43511876df5cdf3e7e548");
    for (salt,target,signature) in [
        (b"".as_slice(),"4a533d47ec9c7d95b1ad75f576cffc641853b750","305ac8aeb6c9c151fa120f120ea2cfb923564e11552d06a5d856091e5e853cff1260d3f39e4999684aa92eb73ffd136e6f4f3ecbfda0ce53a1608ecd7ae21f01"),
        (b"foobar".as_slice(),"411eba73b6f087ca51a3795d9c8c938d365e32c1","6834284b6b24c3204eb2fea824d82f88883a3d95e8b4a21b8c0ded553d17d17ddf9a8a7104b1258f30bed3787e6cb896fca78c58f8e03b5f18f14951a87d9a08"),
    ] { let key=MutableKey::new(pk,salt.to_vec()).unwrap();assert_eq!(key.target(),hex(target));MutableRecord::verify(key,1,value.clone(),hex(signature)).unwrap(); }
    assert_eq!(
        signing_bytes(&value, 1, b"").unwrap(),
        b"3:seqi1e1:v12:Hello World!"
    );
    assert_eq!(
        signing_bytes(&value, 1, b"foobar").unwrap(),
        b"4:salt6:foobar3:seqi1e1:v12:Hello World!"
    );
}
#[test]
fn canonical_values_and_limits() {
    for v in [
        b"0:".as_slice(),
        b"i0e",
        b"i-9223372036854775808e",
        b"le",
        b"de",
        b"d1:ali1e0:ee",
        b"3:\0\xffa",
    ] {
        assert!(BencodedValue::parse(v).is_ok(), "{v:?}");
    }
    for v in [
        b"".as_slice(),
        b"i-0e",
        b"i01e",
        b"01:a",
        b"i9223372036854775808e",
        b"d1:bi1e1:ai2ee",
        b"d1:ai1e1:ai2ee",
        b"0:0:",
        b"li1e",
    ] {
        assert!(BencodedValue::parse(v).is_err(), "{v:?}");
    }
    assert_eq!(
        BencodedValue::bytestring(&vec![0; 996])
            .unwrap()
            .as_bytes()
            .len(),
        1000
    );
    assert!(BencodedValue::bytestring(&vec![0; 997]).is_err());
    let nested = |n| [vec![b'l'; n], b"i0e".to_vec(), vec![b'e'; n]].concat();
    assert!(BencodedValue::parse(&nested(64)).is_ok());
    assert!(BencodedValue::parse(&nested(65)).is_err());
}
#[test]
fn signatures_identity_versions_and_binary_salt() {
    let signer = Bep44Signer::from_seed(&[42; 32]);
    let value = BencodedValue::bytestring(b"\0\xff").unwrap();
    let first = signer.sign(value.clone(), 0, vec![0; 64]).unwrap();
    assert!(signer.sign(value.clone(), -1, vec![]).is_err());
    assert!(signer.sign(value.clone(), 0, vec![0; 65]).is_err());
    let last = signer.sign(value.clone(), i64::MAX, vec![0; 64]).unwrap();
    assert_eq!(
        select_mutable(Some(&last), first.clone()),
        Err(ValidationError::Rollback)
    );
    assert_eq!(select_mutable(Some(&first), first.clone()).unwrap(), first);
    let conflict = signer
        .sign(BencodedValue::bytestring(b"other").unwrap(), 0, vec![0; 64])
        .unwrap();
    assert_eq!(
        select_mutable(Some(&first), conflict),
        Err(ValidationError::Conflict)
    );
    let mut sig = first.signature();
    sig[0] ^= 1;
    assert!(MutableRecord::verify(first.key().clone(), 0, value.clone(), sig).is_err());
    assert!(first
        .verify_for(&MutableKey::new(signer.public_key(), vec![]).unwrap())
        .is_err());
    assert!(ImmutableItem::verify([0; 20], value).is_err());
    assert!(MutableKey::new([0; 32], vec![]).is_err());
}
