# Building and testing

Run commands from the repository root: `cd feedtorrent && make`.
The single `Makefile` works with the make supplied by macOS and OpenBSD.
Invoking a Makefile from another directory is not supported.
`make run ARGS="--no-open"` starts the server from the repository; the executable
can also be started directly from any directory, preserving its relative paths.

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

## Ubuntu 24.04 x86_64

Install Rust 1.95.0 through rustup, Node 24/npm, and the native tools:

```sh
sudo apt-get install build-essential cmake ninja-build pkg-config libboost-dev libssl-dev python3
make
```

For the full checks, install the WASM target and Rust clippy/rustfmt, and install
Playwright's Chrome, Firefox and WebKit browsers. `dev/ci/prepare.sh` installs
system packages on disposable CI machines; `dev/ci/run.sh` builds the application,
runs the full host-supported checks and packages the result. Linux's ENOSPC test
injects a write error into one private fixture inode, then verifies resumed exact bytes.

## OpenBSD

Use packages matching the installed OpenBSD release:

```sh
doas pkg_add node boost cmake ninja rust rust-clippy rust-rustfmt
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

OpenBSD's Clippy 1.98 adds the style-only `chunks_exact_to_as_chunks` suggestion
after the pinned Rust 1.95 baseline. The Clippy entry point excludes that one
lint specifically on OpenBSD/Clippy 1.98, preserving the frozen BEP sources.
All other warnings remain errors; other hosts/tool versions retain strict
defaults. This policy is shared by `make check`, CI and the commit hook.

The key-vault tests verify the current FTKV format independently with Node.
Python's standard library is used by build-tool tests and native addon preparation.
The native client itself does not require Python.

The first OpenBSD native test run builds the independent Node uTP and WebRTC
bindings from their published sources. It uses the installed Node headers,
Python, CMake and Ninja, and downloads node-addon-api 7.1.1 and the
libdatachannel sources pinned by node-datachannel. These are test tools only.
uTP uses the node-gyp included in npm to generate Ninja files, then Ninja builds
the binding. No gmake or extra node-gyp installation is required.
The OpenBSD Node package can pull in GNU Make transitively; these targets do
not invoke it.
No third-party sources are modified.
The key-vault reference uses the pinned test-only `@noble/hashes` 2.0.1
Argon2id implementation when Node lacks `crypto.argon2Sync` (including Node 22).

The disk-error test fills a private HFS+ image on macOS. After its clients stop,
cleanup allows up to five ordinary detach attempts, one second apart, only for
EBUSY (exit 16). Persistent or other detach errors still fail the suite; no test
assertion is retried and the volume is never forcibly detached. On OpenBSD it injects
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

Repeated builds retain the timestamps of identical generated web files. Changing
test recipes does not invalidate the web or libtorrent build.

`make clean` removes the Rust build and generated web assets. It preserves
native dependencies, Node packages, downloads and application state.

## CI packages and releases

GitHub Actions builds macOS ARM64 (`macos-15`), Linux x86_64 (`ubuntu-24.04`)
and OpenBSD 8.0 amd64 (a real VM hosted on Ubuntu). Each push to `main`, each
`v*` tag and each manual workflow run executes the full applicable checks.
The VM runs fixtures as an unprivileged user; its Python reference is built
against a separate OpenSSL and does not require a private prebuilt wheel.
Only download caches are reused; application/native outputs are built fresh.
The test-only node-datachannel prebuild download is verbose and gets at most
three attempts, five seconds apart. Exhaustion fails preparation; this does not
retry or replace any validation suite.

Successful jobs upload packages and SHA-256 checksums as Actions artifacts
for 14 days. Only a pushed `v*` tag publishes a Release, after all three targets
pass. Releases are assembled as drafts, uploaded completely, then published.
A hyphen in the tag marks a prerelease. A manual run never publishes a release,
even when launched on a tag. Published releases are not replaced by a rerun.

Each `feedtorrent-<tag-or-commit>-<platform>-<arch>.tar.gz` contains the executable,
licenses, `THIRD_PARTY.json` and `BUILD-INFO.json`. Platform names are `macos`,
`linux` and `openbsd-8.0`; architecture names are `arm64` and `amd64`.
The build info records source and executable hashes, dirty state, tag/commit,
tool versions and inspected runtime libraries. The executable's existing
internal development version is independent of the release tag.

```sh
# Linux; use `shasum -a 256 -c` on macOS or `sha256 -C` on OpenBSD.
sha256sum -c feedtorrent-<version>-linux-amd64.tar.gz.sha256
tar -xzf feedtorrent-<version>-linux-amd64.tar.gz
./feedtorrent-<version>-linux-amd64/feedtorrent --no-open
```

macOS packages require macOS 15 or later and contain no Homebrew runtime links.
They are not Developer ID signed or notarized. Linux is validated on Ubuntu
24.04 x86_64 and uses its standard C/C++ runtime; compatibility with older
glibc distributions is not claimed. Both incorporate libtorrent/OpenSSL
statically. OpenBSD packages require OpenBSD 8.0 amd64 and its base libraries,
including LibreSSL. No Node, Rust, Python, Boost or source checkout is needed
to run these packages. A browser is needed only on the machine viewing the UI;
`xdg-utils` remains optional for automatic desktop opening on Unix.

The packager audits dynamic libraries and starts an extracted executable from
a separate directory with isolated state, testing HTML, embedded assets, API
and orderly shutdown. No automatic deployment or user-data migration occurs.

Enable the versioned commit hook with `git config core.hooksPath .githooks`.
It refuses unstaged changes or untracked sources and runs `make check test`
against the sources to be committed. After checking the selected index, it clears
Git's repository-local environment so submodule and fixture Git commands discover
their own repositories. Install the documented test dependencies first. Commit,
push and release-tag creation remain manual user operations.


## Validation by impact

Choose tests by behavior and dependencies, not just filenames. State the included
suites and justify exclusions before running them. Use the union for mixed changes;
expand the selection when a dependency is uncertain. This is a manual matrix,
not an automatic source-change selector.

| Change | Closing validation |
|---|---|
| Documentation only | Affected documentation checks |
| Local presentation/interaction | `check-web`, build, affected UI in Chrome/Firefox/WebKit; mobile when relevant |
| Publishing, versions, own dates, backups/recovery | Rust checks/workspace, `publishing key-vault retention`, affected UI; same native block on OpenBSD |
| Keys/cryptography | Rust checks/workspace, `key-vault publishing`, independent Node interoperability, affected UI; native block on OpenBSD |
| Following/renewal | Rust checks/workspace, `posts`, affected UI; add `organization` for ordering and `retention` for ownership/removal; native block on OpenBSD |
| Organization | Rust checks/workspace, `organization`, affected UI; native block on OpenBSD |
| Removal/references | Rust checks/workspace, `retention publishing posts`, affected UI; native block on OpenBSD |
| Transport/native bridge/shared test infrastructure/build/dependencies/common contracts | Full validation on affected platforms |
| Distributable release or explicit request | Full validation |

A local selector change in shared CSS need not affect every component. A change to
shared routing, auth, event transport or fixtures generally affects multiple suites.
Restarting the local review server alone does not constitute a distributable release.
During implementation run focused tests; after a fix repeat the invalidated blocks.
Reserve an applicable full run for the stable result. Earlier results only support
unchanged areas with unchanged relevant inputs/environment; they are not a cached PASS.

Keyboard navigation, key shortcuts and focus assertions are deliberately excluded
from this project's UI tests. Mixed workflows use pointer or touch actions while
retaining their functional, persistence and error checks.

### Focused commands

```sh
make check-web
make check-rust
make test-unit                            # --workspace by default
make test-unit UNIT_ARGS='-p feedtorrent version'
make test-integration NATIVE_SUITES='publishing key-vault retention'
make test-ui UI_ARGS='publication-status.spec.ts version.spec.ts'
make test-ui UI_ARGS='version.spec.ts --project=chrome'
make test-ui UI_ARGS='version.spec.ts --list'
make check test                          # full host-supported validation
```

`test-integration` builds the application/examples but does not run Rust unit tests.
`test-native` remains the complete native aggregate: unit, integration, Make contract
and platform tests. Empty native selections and unknown/helper-only suite names fail.
A successful Rust filter that executes zero tests fails; explicit `--list` only lists.
Playwright filters selecting no tests fail. Its native filters/project names remain
available through `UI_ARGS`; workers, retries, config and artifact destinations are
managed centrally. Cross-run selectors (`--shard`, `--last-failed`, `--only-changed`)
and their worker/config shortcuts are rejected to prevent double filtering. `--list` collects without executing. Examples above are alternatives,
not a checklist to run repeatedly. One Make invocation shares preparation prerequisites.

`bep44` already includes BEP46/BEP49. `posts` includes follower renewal. `publishing`
includes the protocol/persistence publication flow. Do not invoke these nested suites
again in the same validation block. Safari remains an explicit separate target.

### Browser resource pools

The existing Playwright CLI remains the runner. A small adapter uses its collection
and test-list filters to partition the requested tests into two sequential pools:

* Isolated: `version.spec.ts`, controlled `publication-status.spec.ts`, `dates.spec.ts`;
  two workers, with parallel tests permitted. Each test owns its application/data/ports.
* Serial: every other test; one worker, including real network/exclusive-resource tests.

New files are serial until explicitly reviewed and exercised for isolation. The config
also restricts the isolated pool to that allowlist. Retries stay zero. The real publishing
browser journey runs in Chrome only; Firefox/WebKit still run all controlled presentation
checks. This is collection-time selection, not two silently skipped tests.

All runs use a unique `.runtime/tests/run-*` directory (or an explicitly supplied
`FEEDTORRENT_TEST_RUN_DIR`). It contains process timing/source/tool metadata, native
reports, Playwright JSON/traces/screenshots and per-process Firefox launch auxiliaries.
Fixtures allocate private data directories and ephemeral ports. Processes must exit
before their resources are removed. Keep a compact result, relevant requested artifacts
and failed-run diagnostics while diagnosing; remove owned run data/derivatives at closure.
Historical shared evidence is not swept. No project/application dependency is added.

### Publication coverage moved from the old browser scenario

| Behavior | Current coverage |
|---|---|
| Signed snapshot differs from later draft; zero only confirmed by ACK; retry preserves signature/operation; no plaintext password | Native `publication-flow`, existing `publishing`, Rust publishing tests |
| Next signature keeps confirmed version/dates; native follower verifies dates | Native `publication-flow` and `publishing` |
| Wrong password seeds nothing; nested Cancel; stale operation rejected; seeds stay active; restart preserves signed/confirmed state | Native `publication-flow`; Rust callback/backup tests |
| Labels/colors, exact sequences, unsigned/unknown/error/canceled states | Controlled publication/status/version UI in all three browsers |
| Password clearing, Publish→same page, queue/save/dialog/navigation failures | Controlled UI plus real Chrome publication journey |
| Same Retry/Cancel nodes/actions in editor/Public view, pending state in another tab, published draft remains dirty | Controlled UI; real SSE confirmation in both Chrome tabs |
| Published dates stay visible during edits/pending updates; own-draft warning; verified followed dates without warning | Controlled publication UI and common dates UI in all three browsers; native dates provenance |
| Library/catalog visibility and return to own Public view, no external requests | Real Chrome journey and existing library/publishing UI |
| Tooltip click/hover/focus/Escape, hidden status, 320px bounds, disconnect | Controlled publication UI, existing shared-help UI |

The existing CSP exceptions, key parameters, product timing and signing policy are
unchanged. Controlled responses apply only at test boundaries.

## Reusable OpenBSD validation environment

The optional controller manages `~/.cache/feedtorrent-validation` on an OpenBSD
validation host, separate from the user's clone and application data. It owns verified
package tools, a pinned pristine vendor checkout, a stable source mirror, Cargo/native/Node
caches, and disposable `runs/`. This is shared validation infrastructure,
not a per-task temporary environment to delete after each change.

The bootstrap supports OpenBSD 8.0 amd64 with a checked package manifest. It performs
no global package installation. Other OS releases/architectures fail explicitly until
the manifest is updated and verified. Python uses the installed interpreter and its
standard library; no private wheel or Python environment is required.

```sh
# Use a disposable test host. Feed the versioned script directly.
ssh openbsd-test python3 - prepare < dev/scripts/openbsd-validation.py
# Create .runtime/source.tar.gz from regular source files returned by:
# git ls-files --cached --others --exclude-standard -z
# Include current unstaged/untracked sources; exclude missing/deleted files,
# build/cache/data directories and the separately managed vendor checkout.
scp .runtime/source.tar.gz openbsd-test:.cache/feedtorrent-validation/incoming.tar.gz
ssh openbsd-test python3 - sync .cache/feedtorrent-validation/incoming.tar.gz < dev/scripts/openbsd-validation.py
ssh openbsd-test python3 - exec make build test-deps < dev/scripts/openbsd-validation.py
ssh openbsd-test python3 - exec cargo check --locked --workspace --all-targets < dev/scripts/openbsd-validation.py
ssh openbsd-test python3 - exec make test-native < dev/scripts/openbsd-validation.py
```

Use `test-integration NATIVE_SUITES=...` for a selected integration block instead of the
full native aggregate. Rust fmt/clippy require compatible installed tools; when absent,
record that limitation explicitly and use workspace/all-target checks on OpenBSD plus
fmt/clippy on the identical sources on macOS. Do not install incompatible current tools
against an older Rust compiler just to claim the check passed.

Every command checks the source manifest and relevant environment, records actual
versions, and takes an exclusive environment lease. Sync preserves unchanged source
bytes/timestamps and removes only files listed by the previous managed source manifest.
Native compiler/dependency/build-option changes invalidate native outputs and dependent
Rust artifacts; Node ABI/header/build-tool changes invalidate native test addons.
Cargo handles its Rust fingerprints and npm handles lockfile invalidation. A failed
build remains a failure; the environment never caches successful test results.

Measure preparation, compilation and execution separately with `time -p` and the run
metadata. Distinguish cold and warm runs. Compare equivalent behavior/environment;
ANS-345's 13.7-minute full UI run is historical context, not a controlled baseline.
No maximum time or minimum percentage improvement is imposed.

At closure, verify owned test processes have exited; remove disposable run fixtures,
traces/raw logs/source archives and retain a compact reproducible result. Keep the
verified tools/caches/source mirror as this project's shared validation dependency,
documenting their location and ownership. Run a clean build when environment changes,
distribution or the impact matrix requires it, rather than deleting caches every task.
