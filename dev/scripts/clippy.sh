#!/bin/sh
set -eu
set -- -D warnings
case "$(uname -s):$(cargo clippy --version)" in
  'OpenBSD:clippy 0.1.98'|'OpenBSD:clippy 0.1.98 '*)
    # Clippy 1.98 introduced this style-only suggestion after our Rust 1.95
    # baseline. Preserve the frozen BEP sources and all other warning checks.
    set -- "$@" -A clippy::chunks_exact_to_as_chunks
    ;;
esac
exec cargo clippy --locked --workspace --all-targets -- "$@"
