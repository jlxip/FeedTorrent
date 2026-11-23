# Application updates

The application checks the published releases of `jlxip/FeedTorrent` at startup
and every six hours. Settings exposes the installed version and a manual check.
An installed prerelease accepts newer prereleases and stable releases; stable
installations accept stable releases only. Compact alpha/beta/rc numbers are
compared numerically. Draft releases, equal versions and downgrades are ignored.
Checks list all release pages, rather than GitHub's stable-only `/latest` endpoint.
Errors and rate limits remain visible in Settings and do not interrupt transfers.

A compatible release appears above the content. **Update and restart** saves the
initiating browser's drafts, then downloads the exact offered package and its
SHA-256 file over verified HTTPS. No client-supplied URL or executable path is
accepted. The archive, executable hash, build metadata, target and layout are
verified before a version check and a real HTTP/API startup with private scratch
data. Packages support macOS arm64 (15+), Linux amd64 (Ubuntu 24.04 ABI) and
OpenBSD 8.0 amd64. The startup probe checks the actual host's runtime compatibility.

The update waits for publications, creation, imports and backup downloads.
Prepared backup links count until consumed or their existing five-minute expiry.
New sensitive operations are rejected while waiting; existing operations can
finish or be cancelled, and transfers continue. Automatic publication renewals
pause while waiting. Cancelling the update resumes normal operation.

Immediately before restart, new mutations are blocked and accepted requests,
including streaming backup bodies, have drained. Existing shutdown code persists
state, joins workers and releases the data lock. The candidate is staged beside
the executable for a same-filesystem rename. The old executable remains in a
private `.feedtorrent-update-*/previous/feedtorrent` directory, with the new
package's licenses and build information retained alongside it. One previous
update directory is removed only after a subsequent verified boot succeeds.

Unix `exec` preserves PID, environment, working directory and original arguments.
The actual HTTP port is fixed for restart and `--no-open` avoids another browser
tab. The browser renews its session and reloads only after the expected operation
and version answer from a new instance. Immediate replacement/exec failures restore
and re-execute the previous binary. There is no supervisor: a crash after exec
requires manual recovery using the backup path shown by the update and recorded
in `<data-dir>/updates/install.json`. Stop the failed process and copy that backup
over the executable, then start FeedTorrent with the original arguments.
No privilege elevation is attempted. A writable executable inside a source
checkout is supported; Git and source files are never changed by installation.

`GET /api/updates` returns the separate application-update view.
`POST /api/updates` accepts `{"action":"check"}`,
`{"action":"install","offer":"<known offer id>"}` or
`{"action":"cancel","operation":"<active operation id>"}`.
The existing session cookie, Host and Origin rules apply. `/api/events` adds an
`application_update` event; the torrent Snapshot schema is unchanged.

## Isolated validation

`--isolated` disables automatic checks. Only isolated instances accept
`FEEDTORRENT_UPDATE_TEST_ORIGIN=https://127.0.0.1:<port>/` and
`FEEDTORRENT_UPDATE_TEST_CA=<PEM>` for a local HTTPS release fixture. Redirects
remain HTTPS and inside that fixture origin. Production ignores these variables
and fixes the GitHub authority. Certificate validation is never disabled.

`dev/tests/application-updates.mjs` installs only into private executable copies
and uses independent future/failing fixture programs. It checks pagination,
checksums, bad packages, probes, cancellation, sensitive-operation waiting,
PID/port/arguments/environment preservation and immediate exec recovery.
`FEEDTORRENT_TEST_BINARY` selects a private build for application test helpers.
The original build and running services are not installation targets.
