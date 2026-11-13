use anyhow::{bail, Context, Result};
use std::{io::ErrorKind, net::Ipv4Addr};
use tokio::net::TcpListener;

const PORTS: [u16; 3] = [8790, 8791, 8792];

pub fn ports(requested: Option<u16>, isolated: bool) -> Result<Vec<u16>> {
    match requested {
        Some(port) if isolated || PORTS.contains(&port) => Ok(vec![port]),
        Some(_) => bail!("--http-port must be 8790, 8791 or 8792"),
        None => Ok(PORTS.to_vec()),
    }
}

pub async fn bind(ports: &[u16]) -> Result<TcpListener> {
    for &port in ports {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == ErrorKind::AddrInUse => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Cannot bind web port 127.0.0.1:{port}"));
            }
        }
    }
    let ports = ports
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    bail!("Web ports already in use: {ports}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_ports_require_the_normal_range_unless_isolated() {
        assert_eq!(ports(None, false).unwrap(), PORTS);
        assert_eq!(ports(None, true).unwrap(), PORTS);
        for port in [0, 8789, 8790, 8791, 8792, 8793, u16::MAX] {
            assert_eq!(ports(Some(port), false).is_ok(), PORTS.contains(&port));
            assert_eq!(ports(Some(port), true).unwrap(), [port]);
        }
    }

    #[tokio::test]
    async fn occupied_ports_are_skipped_but_an_explicit_port_never_falls_back() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = occupied.local_addr().unwrap().port();
        let next = bind(&[port, 0]).await.unwrap();
        assert_ne!(next.local_addr().unwrap().port(), port);
        let error = bind(&[port]).await.unwrap_err().to_string();
        assert!(error.contains(&port.to_string()), "{error}");
    }
}
