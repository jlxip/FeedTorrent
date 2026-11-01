//! Test-only UDP host, separate process from the independent Node wire peer.
use feedtorrent_bep::bep50::*;
use feedtorrent_pubsub_udp::{Bind, UdpPubSub};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead},
    sync::mpsc,
    time::Duration,
};
mod bep50_support;
struct Manual;
impl DhtPeerDiscoveryBackend for Manual {
    fn discover_peers(&mut self, _: [u8; 20]) -> Result<(), DiscoveryError> {
        Ok(())
    }
    fn announce_peer(&mut self, _: [u8; 20], _: u16) -> Result<(), DiscoveryError> {
        Ok(())
    }
    fn poll_peer_hints(&mut self) -> Result<Vec<PeerHints>, DiscoveryError> {
        Ok(vec![])
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut driver = UdpPubSub::bind(
        Bind {
            ipv4: Some(std::net::Ipv4Addr::LOCALHOST),
            ipv6: Some(std::net::Ipv6Addr::LOCALHOST),
            port: 0,
            advertised_port: None,
        },
        Config::default(),
    )?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            if let Ok(line) = line {
                if tx.send(line).is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    });
    loop {
        match rx.recv_timeout(Duration::from_millis(5)) {
            Ok(line) => {
                let q: Value = serde_json::from_str(&line)?;
                if q["op"] == "exit" {
                    driver.close();
                    break;
                }
                let out = match bep50_support::run(&mut driver, &q) {
                    Ok(result) => json!({"id":q["id"],"result":result}),
                    Err(error) => json!({"id":q["id"],"error":error.to_string()}),
                };
                println!("{out}");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(_) => {}
        }
        driver.poll(&mut Manual);
    }
    Ok(())
}
