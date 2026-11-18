use crate::{Result, Settings};
use anyhow::{bail, Context};
use axum::http::Uri;

pub fn default_trackers() -> Vec<String> {
    [
        "wss://tracker.btorrent.xyz",
        "wss://tracker.openwebtorrent.com",
        "wss://tracker.webtorrent.dev",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}
pub fn default_stun() -> String {
    "stun.l.google.com:19302".into()
}

pub fn validate(settings: &mut Settings) -> Result<()> {
    if settings.webtorrent_trackers.len() > 32 {
        bail!("Use at most 32 WebRTC trackers");
    }
    let mut trackers = Vec::new();
    for value in &settings.webtorrent_trackers {
        let value = value.trim();
        let uri: Uri = value.parse().context("Enter a valid wss:// tracker URL")?;
        if value.contains('#')
            || value.len() > 2048
            || uri.scheme_str() != Some("wss")
            || uri.host().is_none_or(str::is_empty)
            || uri.authority().is_some_and(|a| {
                a.as_str().contains('@')
                    || (a.as_str() != uri.host().unwrap_or_default() && uri.port_u16().is_none())
            })
            || value.chars().any(char::is_whitespace)
        {
            bail!("Enter a valid wss:// tracker URL");
        }
        if !trackers.iter().any(|t| t == value) {
            trackers.push(value.to_owned());
        }
    }
    let stun = settings.webtorrent_stun_server.trim();
    if !stun.is_empty() {
        let uri: Uri = format!("http://{stun}")
            .parse()
            .context("Enter a STUN server as host:port")?;
        if stun.len() > 253
            || uri.host().is_none_or(str::is_empty)
            || uri.port_u16().is_none_or(|p| p == 0)
            || uri.authority().is_some_and(|a| a.as_str().contains('@'))
            || uri.path() != "/"
            || uri.query().is_some()
            || stun.contains('/')
            || stun.contains('#')
            || stun.chars().any(char::is_whitespace)
        {
            bail!("Enter a STUN server as host:port");
        }
    }
    settings.webtorrent_trackers = trackers;
    settings.webtorrent_stun_server = stun.to_owned();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_settings_get_defaults_but_explicit_empty_stays_empty() {
        let old: Settings =
            serde_json::from_str(r#"{"download_dir":"downloads","peer_port":0}"#).unwrap();
        assert_eq!(old.webtorrent_trackers, default_trackers());
        assert_eq!(old.webtorrent_stun_server, default_stun());
        let mut empty = old.clone();
        empty.webtorrent_trackers.clear();
        empty.webtorrent_stun_server.clear();
        let roundtrip: Settings =
            serde_json::from_slice(&serde_json::to_vec(&empty).unwrap()).unwrap();
        assert!(roundtrip.webtorrent_trackers.is_empty());
        assert!(roundtrip.webtorrent_stun_server.is_empty());
    }
    #[test]
    fn signaling_validation_preserves_paths_queries_and_deduplicates() {
        let mut s = crate::default_store().settings;
        s.webtorrent_trackers = vec![
            " wss://localhost:8443/announce?token=x ".into(),
            "wss://localhost:8443/announce?token=x".into(),
        ];
        s.webtorrent_stun_server = " [::1]:3478 ".into();
        validate(&mut s).unwrap();
        assert_eq!(
            s.webtorrent_trackers,
            ["wss://localhost:8443/announce?token=x"]
        );
        assert_eq!(s.webtorrent_stun_server, "[::1]:3478");
        for bad in [
            "ws://localhost/announce",
            "https://tracker.test",
            "wss://user:secret@tracker.test",
            "wss://tracker.test/#fragment",
            "wss://:443",
            "wss://tracker.test:nope",
            "wss://tracker.test:65536",
        ] {
            s.webtorrent_trackers = vec![bad.into()];
            assert!(validate(&mut s).is_err(), "{bad}");
        }
        s.webtorrent_trackers.clear();
        for bad in [
            "host",
            "host:0",
            "stun://host:3478",
            "host:3478/path",
            "user@host:3478",
            "host:65536",
            ":19302",
        ] {
            s.webtorrent_stun_server = bad.into();
            assert!(validate(&mut s).is_err(), "{bad}");
        }
    }
}
