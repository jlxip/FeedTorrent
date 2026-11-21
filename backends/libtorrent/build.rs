fn main() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let prefix = root.join("../../.tools/native/lib/pkgconfig");
    let extra = std::env::var("PKG_CONFIG_PATH").unwrap_or_default();
    std::env::set_var("PKG_CONFIG_PATH", format!("{}:{}", prefix.display(), extra));
    let mut lib = pkg_config::Config::new()
        .atleast_version("2.1.2")
        .statik(true)
        .print_system_libs(true)
        .cargo_metadata(false)
        .probe("libtorrent-rasterbar")
        .expect("Run make to prepare the interface and libtorrent first");
    // libtorrent's .pc omits the WebRTC static archives exported by its CMake
    // target. Include the pinned transport stack explicitly, ahead of TLS.
    let index = lib
        .libs
        .iter()
        .position(|n| n == "torrent-rasterbar")
        .unwrap()
        + 1;
    lib.libs.splice(
        index..index,
        ["datachannel-static", "juice-static", "usrsctp"].map(String::from),
    );
    for path in &lib.link_paths {
        println!("cargo:rustc-link-search=native={}", path.display());
    }
    for name in &lib.libs {
        let pinned = matches!(
            name.as_str(),
            "torrent-rasterbar" | "datachannel-static" | "juice-static" | "usrsctp"
        );
        let tls = matches!(name.as_str(), "ssl" | "crypto");
        let kind = if pinned || tls { "static" } else { "dylib" };
        println!("cargo:rustc-link-lib={kind}={name}");
    }
    for path in &lib.framework_paths {
        println!("cargo:rustc-link-search=framework={}", path.display());
    }
    for name in &lib.frameworks {
        println!("cargo:rustc-link-lib=framework={name}");
    }
    for path in &lib.link_files {
        println!("cargo:rustc-link-arg={}", path.display());
    }
    for args in &lib.ld_args {
        println!("cargo:rustc-link-arg=-Wl,{}", args.join(","));
    }
    let mut build = cxx_build::bridge("src/bridge.rs");
    build.file("src/native/engine.cc").include(".").std("c++17");
    for path in lib.include_paths {
        build.include(path);
    }
    for (name, value) in lib.defines {
        build.define(&name, value.as_deref());
    }
    build.compile("feedtorrent-bridge");
    // Relink when the separately built static library changes.
    println!(
        "cargo:rerun-if-changed={}",
        root.join("../../.tools/native/lib/libtorrent-rasterbar.a")
            .display()
    );
    println!("cargo:rerun-if-changed=src/bridge.rs");
    println!("cargo:rerun-if-changed=src/native/engine.h");
    println!("cargo:rerun-if-changed=src/native/engine.cc");
    println!("cargo:rerun-if-changed=src/native/ice_ports.h");
}
