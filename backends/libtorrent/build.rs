fn main() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let prefix = root.join("../../.tools/native/lib/pkgconfig");
    let extra = std::env::var("PKG_CONFIG_PATH").unwrap_or_default();
    std::env::set_var("PKG_CONFIG_PATH", format!("{}:{}", prefix.display(), extra));
    let lib = pkg_config::Config::new()
        .atleast_version("2.1.2")
        .statik(true)
        .probe("libtorrent-rasterbar")
        .expect("Run make to prepare the interface and libtorrent first");
    let mut build = cxx_build::bridge("src/bridge.rs");
    build.file("src/native/engine.cc").include(".").std("c++17");
    for path in lib.include_paths {
        build.include(path);
    }
    for (name, value) in lib.defines {
        build.define(&name, value.as_deref());
    }
    build.compile("feedtorrent-bridge");
    println!("cargo:rerun-if-changed=src/bridge.rs");
    println!("cargo:rerun-if-changed=src/native/engine.h");
    println!("cargo:rerun-if-changed=src/native/engine.cc");
}
