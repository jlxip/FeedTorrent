# Building and testing

The portable `Makefile` forwards to GNU Make (`make` on macOS, `gmake` on
OpenBSD). It also supports `make -f /path/to/Makefile` from another directory;
`make run` preserves that directory for relative download paths.

## macOS

Install the Xcode command line tools, Rust through rustup, Node/npm, CMake,
Ninja, pkg-config, Boost and OpenSSL 3. Homebrew supplies the native dependencies:

```sh
brew install node cmake ninja pkg-config boost openssl@3
make
make check
make test
```

The development toolchain is pinned in `rust-toolchain.toml`.

## OpenBSD

Use packages matching the installed OpenBSD release:

```sh
doas pkg_add gmake node boost cmake ninja rust rust-clippy rust-rustfmt
make NATIVE_JOBS=2
make check NATIVE_JOBS=2
make test NATIVE_JOBS=2
./target/release/feedtorrent --no-open
```

The native executable uses the system Rust toolchain and does not require
rustup or the WASM target. `check-wasm` retains the independent WASM/consumer
checks; run it on a host with that target installed. `test-ui` runs Playwright's
Chrome, Firefox and WebKit projects on a supported browser host. The full
`check` and `test` targets include those checks on macOS; on OpenBSD they
select `check-native` and `test-native`, respectively.

Native key-migration tests also require Python 3 and a `cryptography` build
with working Argon2id and scrypt KDFs. The LibreSSL-backed OpenBSD package
does not supply those algorithms; use an isolated Python environment linked
to OpenSSL instead (validated with cryptography 50.0.0 and OpenSSL 3.5.6).
The native client itself does not require Python.

The first OpenBSD native test run builds the independent Node uTP and WebRTC
bindings from their published sources. It uses the installed Node headers,
Python, CMake, Ninja and GNU Make, and downloads node-addon-api 7.1.1 and the
libdatachannel sources pinned by node-datachannel. These are test tools only.
No third-party sources are modified.
The key-vault reference uses the pinned test-only `@noble/hashes` 2.0.1
Argon2id implementation when Node lacks `crypto.argon2Sync` (including Node 22).

The disk-error test fills a private HFS+ image on macOS. On OpenBSD it injects
`ENOSPC` into positional writes to one selected fixture inode after two MiB,
then removes the fault and verifies the exact resumed download. This needs no
privileged mount and never fills the server filesystem.

The HTTPS tracker regression uses a temporary private CA. OpenBSD LibreSSL
[loads its fixed default certificate path](https://github.com/openbsd/src/blob/master/lib/libcrypto/x509/by_file.c),
so a test-only TLS-context adapter adds that CA explicitly. It preserves system
trust and certificate verification; the application and system store are unchanged.

For a desktop session, install `xdg-utils` to open the browser and containing
folders. On a headless server, use `--no-open` and the printed URL. Folder
opening acts on the server running FeedTorrent.

## Dependency selection

macOS discovers OpenSSL and Boost through Homebrew. Other platforms use CMake's
normal package discovery, including the system LibreSSL on OpenBSD. Explicit
`OPENSSL_ROOT_DIR`, `BOOST_ROOT` and `CMAKE_PREFIX_PATH` settings are honored.
Build libtorrent again after changing native dependencies; `NATIVE_JOBS` controls
its parallel build.

License collection follows the TLS headers selected by CMake, rather than
calling Homebrew unconditionally. `TLS_LICENSE_FILE` can specify a license for a
custom OpenSSL installation. The bundled LibreSSL notice is the upstream
[COPYING file for 4.4.0](https://github.com/libressl/portable/blob/v4.4.0/COPYING).

`make clean` removes the Rust build and generated web assets. It preserves
native dependencies, Node packages, downloads and application state.
