use anyhow::{bail, Result};
use feedtorrent_libtorrent::LibtorrentBackend;
use maxminddb::{path, Reader};
use std::{net::IpAddr, sync::OnceLock};

const DATABASE: &[u8] = include_bytes!("../data/dbip-country-lite-2026-11.mmdb");
static COUNTRIES: OnceLock<Option<Reader<&[u8]>>> = OnceLock::new();

fn country(address: &str) -> Option<String> {
    let ip = address.parse::<IpAddr>().ok()?.to_canonical();
    let public = match ip {
        IpAddr::V4(v) => {
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && !v.is_multicast()
                && !v.is_broadcast()
                && !v.is_documentation()
                && v.octets()[0] != 0
                && v.octets()[0] < 240
                && !(v.octets()[0] == 100 && (64..128).contains(&v.octets()[1]))
        }
        IpAddr::V6(v) => {
            !v.is_loopback()
                && !v.is_unspecified()
                && !v.is_unique_local()
                && !v.is_unicast_link_local()
                && !v.is_multicast()
                && v.segments()[..2] != [0x2001, 0xdb8]
        }
    };
    if !public {
        return None;
    }
    let reader = COUNTRIES
        .get_or_init(|| Reader::from_source(DATABASE).ok())
        .as_ref()?;
    let code: Option<String> = reader
        .lookup(ip)
        .ok()?
        .decode_path(&path!["country", "iso_code"])
        .ok()?;
    code.filter(|c| c.len() == 2 && c != "ZZ" && c.bytes().all(|b| b.is_ascii_uppercase()))
}

pub fn read(native: &LibtorrentBackend, id: &str) -> Result<serde_json::Value> {
    if !feedtorrent_bep::valid_id(id) {
        bail!("Invalid torrent ID");
    }
    let peers = native
        .read_peers(id)?
        .into_iter()
        .map(|p| {
            serde_json::json!({"country": country(&p.address), "address":p.address,
            "port":p.port,"connected":p.connected,"down":p.down,"up":p.up})
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({"id":id,"peers":peers}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_country_database_works_without_network_or_files() {
        assert_eq!(country("8.8.8.8").as_deref(), Some("US"));
        assert_eq!(country("2001:4860:4860::8888").as_deref(), Some("CA"));
        assert_eq!(country("::ffff:8.8.8.8"), country("8.8.8.8"));
    }

    #[test]
    fn local_reserved_and_invalid_addresses_have_no_country() {
        for ip in [
            "",
            "invalid",
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.1.1",
            "0.0.0.0",
            "100.64.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:192.168.1.1",
        ] {
            assert_eq!(country(ip), None, "{ip}");
        }
    }
}
