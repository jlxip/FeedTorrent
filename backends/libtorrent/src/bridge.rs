#[cxx::bridge(namespace = "ft")]
pub mod ffi {
    struct NativeFile {
        name: String,
        length: u64,
        verified: u64,
    }
    struct NativeTransfer {
        id: String,
        name: String,
        state: String,
        error: String,
        warning: String,
        verified: u64,
        total: u64,
        down: u64,
        up: u64,
        peers: u32,
        files: Vec<NativeFile>,
        finished: bool,
    }
    struct NativeSnapshot {
        transfers: Vec<NativeTransfer>,
        dht_nodes: u32,
        listen_port: u16,
        warning: String,
    }
    struct NativeDhtRequest {
        id: u64,
        kind: u8,
        target: Vec<u8>,
        key: Vec<u8>,
        signature: Vec<u8>,
        salt: Vec<u8>,
        value: Vec<u8>,
        sequence: i64,
    }
    struct NativeDhtEvent {
        id: u64,
        terminal: bool,
        has_value: bool,
        value: Vec<u8>,
        key: Vec<u8>,
        signature: Vec<u8>,
        salt: Vec<u8>,
        sequence: i64,
        acknowledged_nodes: u32,
        conflict: bool,
    }
    unsafe extern "C++" {
        include!("src/native/engine.h");
        type Session;
        fn new_session(
            state_dir: &str,
            port: u16,
            bootstrap: &str,
            isolated: bool,
        ) -> Result<UniquePtr<Session>>;
        fn inspect_magnet(uri: &str) -> Result<String>;
        fn inspect_torrent(data: &[u8]) -> Result<String>;
        fn add(
            self: Pin<&mut Session>,
            id: &str,
            source: &[u8],
            magnet: bool,
            path: &str,
            active: bool,
            restore: bool,
        ) -> Result<()>;
        fn pause(self: Pin<&mut Session>, id: &str) -> Result<()>;
        fn resume(self: Pin<&mut Session>, id: &str) -> Result<()>;
        fn remove(self: Pin<&mut Session>, id: &str) -> Result<()>;
        fn snapshot(self: Pin<&mut Session>) -> Result<NativeSnapshot>;
        fn checkpoint(self: Pin<&mut Session>) -> Result<()>;
        fn shutdown(self: Pin<&mut Session>) -> Result<()>;
        fn info_bytes(self: &Session, id: &str) -> Result<Vec<u8>>;
        fn dht_ready(self: &Session) -> bool;
        fn dht_start(self: Pin<&mut Session>, request: &NativeDhtRequest) -> Result<()>;
        fn dht_poll(self: Pin<&mut Session>) -> Result<Vec<NativeDhtEvent>>;
        fn dht_release(self: Pin<&mut Session>, id: u64);
    }
}
