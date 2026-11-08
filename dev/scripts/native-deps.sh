#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
source="$root/backends/libtorrent/vendor/libtorrent"
case "${1:-}" in ''|--verify-source) ;; *) echo 'Unexpected native-deps argument' >&2; exit 1;; esac
if [ ! -e "$source/.git" ]; then git -C "$root" submodule update --init backends/libtorrent/vendor/libtorrent; fi
test "$(git -C "$source" rev-parse HEAD)" = 6da363d2994f17c0b3c0450d124cf73a31a73847 || { echo 'Unexpected libtorrent revision' >&2; exit 1; }
git -C "$source" diff --exit-code HEAD
if [ ! -e "$source/deps/try_signal/.git" ]; then git -C "$source" submodule update --init deps/try_signal; fi
[ "${1:-}" != --verify-source ] || exit 0
jobs=${NATIVE_JOBS:-6}
if [ "$(uname -s)" = OpenBSD ]; then jobs=${NATIVE_JOBS:-2}; fi
set -- cmake -S "$root/backends/libtorrent/vendor/libtorrent" \
  -B "$root/.tools/libtorrent-build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_STANDARD=17 -DCMAKE_INSTALL_PREFIX="$root/.tools/native" \
  -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF -Dwebtorrent=OFF \
  -Di2p=OFF -Dbuild_tests=OFF -Dbuild_examples=OFF -Dbuild_tools=OFF \
  -Dpython-bindings=OFF
# Keep the distributable independent of package-manager TLS libraries.
if [ "$(uname -s)" != OpenBSD ]; then
  set -- "$@" -DOPENSSL_USE_STATIC_LIBS=TRUE
fi
# Honor explicit paths everywhere; Homebrew discovery is specific to macOS.
if [ "$(uname -s)" = Darwin ]; then
  : "${OPENSSL_ROOT_DIR:=$(brew --prefix openssl@3)}"
  : "${BOOST_ROOT:=$(brew --prefix boost)}"
  set -- "$@" "-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-15.0}"
fi
if [ -n "${OPENSSL_ROOT_DIR:-}" ]; then set -- "$@" "-DOPENSSL_ROOT_DIR=$OPENSSL_ROOT_DIR"; fi
if [ -n "${BOOST_ROOT:-}" ]; then set -- "$@" "-DBoost_ROOT=$BOOST_ROOT"; fi
if [ "$(uname -s)" = OpenBSD ]; then
  set -- "$@" "-DCMAKE_PROJECT_libtorrent_INCLUDE=$root/dev/cmake/openbsd.cmake"
fi
"$@"
cmake --build "$root/.tools/libtorrent-build" -j "$jobs"
cmake --install "$root/.tools/libtorrent-build"
