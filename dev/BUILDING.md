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

Native key-migration tests also require Python 3 and a `cryptography` build
with working Argon2id and scrypt KDFs. The LibreSSL-backed OpenBSD package
does not supply those algorithms; use an isolated Python environment linked
to OpenSSL instead (validated with cryptography 50.0.0 and OpenSSL 3.5.6).
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

Repeated builds retain the timestamps of identical generated web files. Changing
test recipes does not invalidate the web or libtorrent build.

`make clean` removes the Rust build and generated web assets. It preserves
native dependencies, Node packages, downloads and application state.


## Validation by impact

Choose tests by behavior and dependencies, not just filenames. State the included
suites and justify exclusions before running them. Use the union for mixed changes;
expand the selection when a dependency is uncertain. This is a manual matrix,
not an automatic source-change selector.

| Change | Closing validation |
|---|---|
| Documentation only | Affected documentation checks |
| Local presentation/interaction | `check-web`, build, affected UI in Chrome/Firefox/WebKit; mobile/keyboard when relevant |
| Publishing, versions, own dates, backups/recovery | Rust checks/workspace, `publishing key-vault retention`, affected UI; same native block on OpenBSD |
| Keys/cryptography | Rust checks/workspace, `key-vault publishing`, Python interoperability, affected UI; native block on OpenBSD |
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

Piensa uses a managed `~/.cache/feedtorrent-validation` directory, separate from the
user's clone and real application data. It owns verified private package tools, a Python
reference environment, a pinned pristine vendor checkout, a stable source mirror,
Cargo/native/Node caches, and disposable `runs/`. This is shared validation infrastructure,
not a per-task temporary environment to delete after each change.

The bootstrap supports OpenBSD 8.0 amd64 with a checked package manifest. It performs
no global package installation. Other OS releases/architectures fail explicitly until
the manifest is updated and verified. The existing cryptography wheel is a shared input.

```sh
# Feed the versioned script directly; no stale installed controller is needed.
ssh piensa python3 - prepare < dev/scripts/openbsd-validation.py
# Create .runtime/source.tar.gz from regular source files returned by:
# git ls-files --cached --others --exclude-standard -z
# Include current unstaged/untracked sources; exclude missing/deleted files,
# build/cache/data directories and the separately managed vendor checkout.
scp .runtime/source.tar.gz piensa:.cache/feedtorrent-validation/incoming.tar.gz
ssh piensa python3 - sync .cache/feedtorrent-validation/incoming.tar.gz < dev/scripts/openbsd-validation.py
ssh piensa python3 - exec make build test-deps < dev/scripts/openbsd-validation.py
ssh piensa python3 - exec cargo check --locked --workspace --all-targets < dev/scripts/openbsd-validation.py
ssh piensa python3 - exec make test-native < dev/scripts/openbsd-validation.py
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
