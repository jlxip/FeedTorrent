use super::*;
use feedtorrent_bep::normalize_magnet_input;
#[test]
fn magnet_hash_normalization_and_identity() {
    let id = "56f31e2d486209003454e245d11561cd252be30f";
    let base32 = "K3ZR4LKIMIEQANCU4JC5CFLBZUSSXYYP";
    for input in [
        id.to_owned(),
        id.to_uppercase(),
        base32.to_owned(),
        base32.to_lowercase(),
        format!("  {id}\n"),
    ] {
        let normalized = normalize_magnet_input(&input).unwrap();
        assert_eq!(inspect(TorrentSource::Magnet(&normalized)).unwrap(), id);
    }
    let uri = format!("magnet:?xt=urn:btih:{id}&tr=https%3A%2F%2Fexample.org%2Fannounce&dn=Sample");
    assert_eq!(normalize_magnet_input(&format!(" {uri} ")).unwrap(), uri);
    for invalid in [
        "",
        "123",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "00000000000000000000000000000000",
        "56f31e2d486209003454e245d11561cd252be30z",
    ] {
        assert!(normalize_magnet_input(invalid).is_err());
    }
}

#[test]
fn unsupported_sources_are_rejected() {
    assert!(inspect(TorrentSource::Magnet("magnet:?xt=urn:btpk:abcd")).is_err());
    assert!(inspect(TorrentSource::Torrent(b"bad bencode")).is_err());
}

#[test]
fn outer_creation_dates_distinguish_epoch_missing_and_invalid_values() {
    let info = b"4:infod6:lengthi1e4:name1:x12:piece lengthi16384e6:pieces20:00000000000000000000e";
    for (field, expected) in [
        ("", None),
        ("13:creation datei0e", Some(0)),
        ("13:creation datei1793921539e", Some(1793921539)),
        ("13:creation datei-1e", None),
        ("13:creation datei253402300800e", None),
        ("13:creation date3:bad", None),
    ] {
        let mut torrent = b"d".to_vec();
        torrent.extend(field.as_bytes());
        torrent.extend(info);
        torrent.push(b'e');
        let d = LibtorrentBackend::describe_torrent(&torrent).unwrap();
        assert_eq!(d.creation_date, expected, "{field}");
    }
}
