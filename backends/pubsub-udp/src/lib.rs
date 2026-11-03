//! Explicitly polled native UDP adapter for the portable BEP50 state machine.
//! Bind addresses come from the host; no interface discovery, NAT traversal,
//! implicit Mainline value publication, background threads or disk persistence.
use feedtorrent_bep::bep50::{Config, Datagram, DhtPeerDiscoveryBackend, PubSub, MAX_DATAGRAM};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::VecDeque,
    io,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket},
    time::Instant,
};

pub struct Bind {
    pub ipv4: Option<Ipv4Addr>,
    pub ipv6: Option<Ipv6Addr>,
    pub port: u16,
    /// External mapped port, if the host has independently established one.
    pub advertised_port: Option<u16>,
}
/// A single native identity, same port on both address families. The host owns
/// this driver's lifetime; closing it never shuts down the discovery backend.
pub struct UdpPubSub {
    protocol: PubSub,
    v4: Option<UdpSocket>,
    v6: Option<UdpSocket>,
    port: u16,
    advertised_port: u16,
    start: Instant,
    pending: VecDeque<Datagram>,
    batch: usize,
    limit: usize,
}
fn socket(address: SocketAddr) -> io::Result<UdpSocket> {
    let socket = Socket::new(
        if address.is_ipv4() {
            Domain::IPV4
        } else {
            Domain::IPV6
        },
        Type::DGRAM,
        Some(Protocol::UDP),
    )?;
    if address.is_ipv6() {
        socket.set_only_v6(true)?;
    }
    socket.set_nonblocking(true)?;
    socket.bind(&address.into())?;
    Ok(socket.into())
}
impl UdpPubSub {
    pub fn bind(bind: Bind, config: Config) -> io::Result<Self> {
        if bind.ipv4.is_none() && bind.ipv6.is_none() || bind.advertised_port == Some(0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "No bind address or invalid advertised port",
            ));
        }
        let mut port = bind.port;
        let v4 = bind
            .ipv4
            .map(|ip| socket(SocketAddr::from((ip, port))))
            .transpose()?;
        if let Some(s) = &v4 {
            port = s.local_addr()?.port();
        }
        let v6 = bind
            .ipv6
            .map(|ip| socket(SocketAddr::from((ip, port))))
            .transpose()?;
        if let Some(s) = &v6 {
            port = s.local_addr()?.port();
        }
        let mut id = [0; 20];
        let mut entropy = zeroize::Zeroizing::new([0; 32]);
        getrandom::fill(&mut id).map_err(|e| io::Error::other(e.to_string()))?;
        getrandom::fill(entropy.as_mut()).map_err(|e| io::Error::other(e.to_string()))?;
        let batch = config.batch;
        let limit = config.max_datagrams;
        let protocol = PubSub::new(id, *entropy, config).map_err(io::Error::other)?;
        // Both the native temporary and the core own zeroizing entropy holders.
        Ok(Self {
            protocol,
            v4,
            v6,
            port,
            advertised_port: bind.advertised_port.unwrap_or(port),
            start: Instant::now(),
            pending: VecDeque::new(),
            batch,
            limit,
        })
    }
    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn now(&self) -> u64 {
        self.start.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    pub fn protocol(&self) -> &PubSub {
        &self.protocol
    }
    /// Use the same clock returned by `now` for explicit host operations.
    pub fn protocol_mut(&mut self) -> &mut PubSub {
        &mut self.protocol
    }
    pub fn poll(&mut self, discovery: &mut impl DhtPeerDiscoveryBackend) {
        let now = self.now();
        for action in self.protocol.drain_discovery() {
            for result in [
                discovery.discover_peers(action.topic),
                discovery.announce_peer(action.topic, self.advertised_port),
            ] {
                if let Err(error) = result {
                    self.protocol
                        .transport_error(action.topic, None, error.to_string());
                }
            }
        }
        match discovery.poll_peer_hints() {
            Ok(hints) => {
                for mut hint in hints {
                    // A Mainline announce can return our own socket. It is not a
                    // remote participant and must not enter a self-ping loop.
                    hint.peers.retain(|peer| {
                        ![&self.v4, &self.v6].into_iter().flatten().any(|s| {
                            s.local_addr().is_ok_and(|local| {
                                local.port() == peer.port()
                                    && (local.ip() == peer.ip()
                                        || (local.ip().is_unspecified() && peer.ip().is_loopback()))
                            })
                        })
                    });
                    self.protocol.discovered(hint, now);
                }
            }
            Err(e) => {
                // Report once per subscribed topic through transport events.
                for topic in self.protocol.topics() {
                    self.protocol.transport_error(topic, None, e.to_string());
                }
            }
        }
        let mut buffer = [0; MAX_DATAGRAM + 1];
        for socket in [&self.v4, &self.v6].into_iter().flatten() {
            for _ in 0..self.batch {
                match socket.recv_from(&mut buffer) {
                    Ok((n, source)) if n <= MAX_DATAGRAM => {
                        self.protocol.receive(source, &buffer[..n], now)
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) => {
                        for topic in self.protocol.topics() {
                            self.protocol.transport_error(topic, None, e.to_string());
                        }
                        break;
                    }
                }
            }
        }
        // Keep transport and protocol queues bounded separately. Drain the
        // transport before advancing; a WouldBlock never loses a publication.
        for _ in 0..self.batch {
            let Some(d) = self.pending.pop_front() else {
                break;
            };
            if !self.protocol.is_subscribed(d.topic)
                || d.deadline_ms.is_some_and(|until| until <= now)
            {
                continue;
            }
            let socket = if d.destination.is_ipv4() {
                &self.v4
            } else {
                &self.v6
            };
            let result = socket
                .as_ref()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::AddrNotAvailable, "Address family not bound")
                })
                .and_then(|s| s.send_to(&d.bytes, d.destination));
            match result {
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    self.pending.push_front(d);
                    break;
                }
                Err(e) => {
                    self.protocol
                        .transport_error(d.topic, Some(d.destination), e.to_string())
                }
                _ => {}
            }
        }
        self.protocol.advance(now);
        if self.pending.is_empty() {
            self.pending
                .extend(self.protocol.drain_datagrams().into_iter().take(self.limit));
        }
    }
    pub fn close(&mut self) {
        self.protocol.close();
        self.pending.clear();
        self.v4 = None;
        self.v6 = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_ephemeral_port_and_explicit_close() {
        let mut node = UdpPubSub::bind(
            Bind {
                ipv4: Some(Ipv4Addr::LOCALHOST),
                ipv6: Some(Ipv6Addr::LOCALHOST),
                port: 0,
                advertised_port: None,
            },
            Config::default(),
        )
        .unwrap();
        assert_ne!(node.port(), 0);
        assert_eq!(
            node.v4.as_ref().unwrap().local_addr().unwrap().port(),
            node.v6.as_ref().unwrap().local_addr().unwrap().port()
        );
        node.close();
        assert!(node.v4.is_none() && node.v6.is_none());
    }
    #[test]
    fn missing_address_and_invalid_advertised_port_fail() {
        for bind in [
            Bind {
                ipv4: None,
                ipv6: None,
                port: 0,
                advertised_port: None,
            },
            Bind {
                ipv4: Some(Ipv4Addr::LOCALHOST),
                ipv6: None,
                port: 0,
                advertised_port: Some(0),
            },
        ] {
            assert!(UdpPubSub::bind(bind, Config::default()).is_err());
        }
    }
}
