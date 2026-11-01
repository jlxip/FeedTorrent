use super::*;
use bendy::{
    decoding::{Decoder, FromBencode},
    encoding::Encoder,
    value::Value,
};
use std::{borrow::Cow, collections::BTreeMap};
pub(super) type V = Value<'static>;
pub(super) type Dict = BTreeMap<Cow<'static, [u8]>, V>;
pub(super) fn bytes(b: &[u8]) -> V {
    V::Bytes(Cow::Owned(b.to_vec()))
}
pub(super) fn dict(items: &[(&[u8], V)]) -> V {
    V::Dict(
        items
            .iter()
            .map(|(k, v)| (Cow::Owned(k.to_vec()), v.clone()))
            .collect(),
    )
}
pub(super) fn as_dict(v: &V) -> Result<&Dict, Error> {
    if let V::Dict(d) = v {
        Ok(d)
    } else {
        Err(Error::Malformed)
    }
}
pub(super) fn get<'a>(d: &'a Dict, k: &[u8]) -> Result<&'a V, Error> {
    d.get(k).ok_or(Error::Malformed)
}
pub(super) fn raw(v: &V) -> Result<&[u8], Error> {
    if let V::Bytes(b) = v {
        Ok(b)
    } else {
        Err(Error::Malformed)
    }
}
pub(super) fn int(v: &V) -> Result<i64, Error> {
    if let V::Integer(n) = v {
        Ok(*n)
    } else {
        Err(Error::Malformed)
    }
}
pub(super) fn array<const N: usize>(v: &V) -> Result<[u8; N], Error> {
    raw(v)?.try_into().map_err(|_| Error::Malformed)
}
pub(super) fn decode(b: &[u8]) -> Result<V, Error> {
    if b.len() > MAX_DATAGRAM {
        return Err(Error::Malformed);
    }
    // Envelope levels do not consume the BEP44 value's independent 64-level budget.
    let mut d = Decoder::new(b).with_max_depth(70);
    let o = d
        .next_object()
        .map_err(|_| Error::Malformed)?
        .ok_or(Error::Malformed)?;
    let v = V::decode_bencode_object(o)
        .map_err(|_| Error::Malformed)?
        .into_owned();
    if d.next_object().map_err(|_| Error::Malformed)?.is_some() {
        return Err(Error::Malformed);
    }
    Ok(v)
}
pub(super) fn encode(v: &V) -> Result<Vec<u8>, Error> {
    let mut e = Encoder::new().with_max_depth(70);
    e.emit(v).map_err(|_| Error::Malformed)?;
    let b = e.get_output().map_err(|_| Error::Malformed)?;
    if b.len() > MAX_DATAGRAM {
        Err(Error::Malformed)
    } else {
        Ok(b)
    }
}
pub(super) fn record(d: &Dict, key: &MutableKey, response: bool) -> Result<MutableRecord, Error> {
    let pk = array(get(d, b"k")?)?;
    let salt = if response {
        key.salt().to_vec()
    } else {
        d.get(b"salt".as_slice())
            .map(raw)
            .transpose()?
            .unwrap_or_default()
            .to_vec()
    };
    let received = MutableKey::new(pk, salt).map_err(Error::InvalidRecord)?;
    if &received != key {
        return Err(Error::InvalidRecord(ValidationError::IdentityMismatch));
    }
    let value = BencodedValue::parse(&encode(get(d, b"v")?)?).map_err(Error::InvalidRecord)?;
    MutableRecord::verify(
        received,
        int(get(d, b"seq")?)?,
        value,
        array(get(d, b"sig")?)?,
    )
    .map_err(Error::InvalidRecord)
}
pub(super) fn add_record(d: &mut Dict, r: &MutableRecord, include_salt: bool) {
    d.insert(Cow::Borrowed(b"k"), bytes(&r.key().public_key()));
    d.insert(Cow::Borrowed(b"seq"), V::Integer(r.sequence()));
    d.insert(Cow::Borrowed(b"sig"), bytes(&r.signature()));
    d.insert(
        Cow::Borrowed(b"v"),
        decode(r.value().as_bytes()).expect("validated value"),
    );
    if include_salt && !r.key().salt().is_empty() {
        d.insert(Cow::Borrowed(b"salt"), bytes(r.key().salt()));
    }
}
pub(super) fn compact(nodes: impl Iterator<Item = (Target, SocketAddr)>) -> Vec<u8> {
    let mut b = vec![];
    for (id, addr) in nodes {
        b.extend_from_slice(&id);
        match addr.ip() {
            std::net::IpAddr::V4(ip) => b.extend_from_slice(&ip.octets()),
            std::net::IpAddr::V6(ip) => b.extend_from_slice(&ip.octets()),
        }
        b.extend_from_slice(&addr.port().to_be_bytes());
    }
    b
}
pub(super) fn contacts(v: &V, v6: bool) -> Result<Vec<(Target, SocketAddr)>, Error> {
    let b = raw(v)?;
    let size = if v6 { 38 } else { 26 };
    if b.len() % size != 0 {
        return Err(Error::Malformed);
    }
    let mut out = vec![];
    for n in b.chunks_exact(size) {
        let id = n[..20].try_into().unwrap();
        let port = u16::from_be_bytes(n[size - 2..].try_into().unwrap());
        let ip = if v6 {
            std::net::IpAddr::V6(std::net::Ipv6Addr::from(
                <[u8; 16]>::try_from(&n[20..36]).unwrap(),
            ))
        } else {
            std::net::IpAddr::V4(std::net::Ipv4Addr::from(
                <[u8; 4]>::try_from(&n[20..24]).unwrap(),
            ))
        };
        let addr = SocketAddr::new(ip, port);
        if usable(addr) {
            out.push((id, addr))
        }
    }
    Ok(out)
}
