#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
set -- cmake -S "$root/backends/libtorrent/vendor/libtorrent" \
  -B "$root/.tools/libtorrent-build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_STANDARD=17 -DCMAKE_INSTALL_PREFIX="$root/.tools/native" \
  -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF -Dwebtorrent=OFF \
  -Di2p=OFF -Dbuild_tests=OFF -Dbuild_examples=OFF -Dbuild_tools=OFF \
  -Dpython-bindings=OFF
# Honor explicit paths everywhere; Homebrew discovery is specific to macOS.
if [ "$(uname -s)" = Darwin ]; then
  : "${OPENSSL_ROOT_DIR:=$(brew --prefix openssl@3)}"
  : "${BOOST_ROOT:=$(brew --prefix boost)}"
fi
if [ -n "${OPENSSL_ROOT_DIR:-}" ]; then set -- "$@" "-DOPENSSL_ROOT_DIR=$OPENSSL_ROOT_DIR"; fi
if [ -n "${BOOST_ROOT:-}" ]; then set -- "$@" "-DBoost_ROOT=$BOOST_ROOT"; fi
if [ "$(uname -s)" = OpenBSD ]; then
  set -- "$@" "-DCMAKE_PROJECT_libtorrent_INCLUDE=$root/dev/cmake/openbsd.cmake"
fi
"$@"
cmake --build "$root/.tools/libtorrent-build" -j "${NATIVE_JOBS:-6}"
cmake --install "$root/.tools/libtorrent-build"
