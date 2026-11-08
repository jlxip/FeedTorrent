fn main() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let prefix = root.join("../../.tools/native/lib/pkgconfig");
    let extra = std::env::var("PKG_CONFIG_PATH").unwrap_or_default();
    std::env::set_var("PKG_CONFIG_PATH", format!("{}:{}", prefix.display(), extra));
    let linux = matches!(std::env::var("CARGO_CFG_TARGET_OS").as_deref(), Ok("linux"));
    let lib = pkg_config::Config::new()
        .atleast_version("2.1.2")
        .statik(true)
        .print_system_libs(true)
        .cargo_metadata(!linux)
        .probe("libtorrent-rasterbar")
        .expect("Run make to prepare the interface and libtorrent first");
    if linux {
        // pkg-config-rs deliberately avoids static archives under /usr. TLS
        // belongs in our executable even when provided by Ubuntu's packages.
        for path in &lib.link_paths {
            println!("cargo:rustc-link-search=native={}", path.display());
        }
        for name in &lib.libs {
            let kind = if matches!(name.as_str(), "torrent-rasterbar" | "ssl" | "crypto") {
                "static"
            } else {
                "dylib"
            };
            println!("cargo:rustc-link-lib={kind}={name}");
        }
        for path in &lib.link_files {
            println!("cargo:rustc-link-arg={}", path.display());
        }
        for args in &lib.ld_args {
            println!("cargo:rustc-link-arg=-Wl,{}", args.join(","));
        }
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
    println!("cargo:rerun-if-changed=src/bridge.rs");
    println!("cargo:rerun-if-changed=src/native/engine.h");
    println!("cargo:rerun-if-changed=src/native/engine.cc");
}
