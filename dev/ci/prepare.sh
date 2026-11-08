#!/bin/sh
# System packages are installed only on disposable CI runners/VMs.
set -eu
case "$(uname -s)" in
  Darwin)
    brew install cmake ninja pkg-config boost openssl@3 python
    ;;
  Linux)
    if [ "$(id -u)" = 0 ]; then sudo_cmd=; else sudo_cmd=sudo; fi
    $sudo_cmd apt-get update
    $sudo_cmd apt-get install -y build-essential cmake ninja-build pkg-config libboost-dev libssl-dev python3 curl ca-certificates git
    ;;
  OpenBSD)
    test "$(id -u)" = 0
    pkg_add -I node boost cmake ninja rust rust-clippy rust-rustfmt python curl git
    # OpenBSD installs the versioned interpreter; keep the alias inside the VM.
    if ! command -v python3 >/dev/null 2>&1; then
      python=$(find /usr/local/bin -maxdepth 1 -name 'python3.[0-9]*' ! -name '*config' | sort | tail -n 1)
      test -n "$python"
      ln -s "$python" /usr/local/bin/python3
    fi
    exit 0
    ;;
  *) echo 'Unsupported CI host' >&2; exit 1;;
esac
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o .tools-rustup-init.sh
  sh .tools-rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain 1.95.0
  rm .tools-rustup-init.sh
  export PATH="$HOME/.cargo/bin:$PATH"
fi
rustup toolchain install 1.95.0 --profile minimal --component clippy --component rustfmt --target wasm32-unknown-unknown
