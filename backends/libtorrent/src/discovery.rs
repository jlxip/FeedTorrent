use super::LibtorrentBackend;
use feedtorrent_bep::{
    bep44::Target,
    bep50::{DhtPeerDiscoveryBackend, DiscoveryError, PeerHints},
};
impl LibtorrentBackend {
    fn discovery_ready(&self) -> Result<(), DiscoveryError> {
        if self.session.is_closed() {
            Err(DiscoveryError::Closed)
        } else if !self.session.dht_ready() {
            Err(DiscoveryError::NotReady)
        } else {
            Ok(())
        }
    }
}
impl DhtPeerDiscoveryBackend for LibtorrentBackend {
    fn discover_peers(&mut self, topic: Target) -> Result<(), DiscoveryError> {
        self.discovery_ready()?;
        self.session
            .pin_mut()
            .peer_discover(&topic, 0)
            .map_err(|e| DiscoveryError::Backend(e.to_string()))
    }
    fn announce_peer(&mut self, topic: Target, udp_port: u16) -> Result<(), DiscoveryError> {
        if udp_port == 0 {
            return Err(DiscoveryError::InvalidInput);
        }
        self.discovery_ready()?;
        self.session
            .pin_mut()
            .peer_discover(&topic, udp_port)
            .map_err(|e| DiscoveryError::Backend(e.to_string()))
    }
    fn poll_peer_hints(&mut self) -> Result<Vec<PeerHints>, DiscoveryError> {
        if self.session.is_closed() {
            return Err(DiscoveryError::Closed);
        }
        self.session
            .pin_mut()
            .peer_hints()
            .map_err(|e| DiscoveryError::Backend(e.to_string()))?
            .into_iter()
            .map(|h| {
                Ok(PeerHints {
                    topic: h
                        .target
                        .as_slice()
                        .try_into()
                        .map_err(|_| DiscoveryError::Backend("Invalid native target".into()))?,
                    peers: h.peers.iter().filter_map(|p| p.parse().ok()).collect(),
                })
            })
            .collect()
    }
}
