# Replica status over BitTorrent

`ft_replica` is a versioned BEP10 extension. It does not add an HTTP endpoint,
grant download permission, fetch payload, or change ephemeral peer IDs.

The provider stores a random 32-byte `replica-id.key` in the native data directory,
created atomically with mode 0600. Existing insecure or malformed keys disable
the extension with a warning; they are never silently replaced. Keep this file
across application updates and restarts.

Messages are bencoded dictionaries. `root` is a binary 20-byte v1 infohash.

- Identity request: `{v:1, root}`.
- Status subscription: `{v:1, root, watch:1}`. The same dictionary can be supplied
  in the extended handshake under `ft_replica` so the provider recognizes the
  control subscription before processing a seed-to-seed redundancy check.
- Identity response: `{v:1, root, node}`. `node` is a binary 32-byte
  HMAC-SHA256 over `FeedTorrent/ft_replica/v1\0` followed by `root`, keyed by
  the persistent local key. The key never leaves the provider.
- A measured response additionally includes `parts`, a list of
  `{id, size, have}` dictionaries: binary 20-byte component hash, total bytes
  including padding, and bytes in verified pieces, including the short last piece.

Identity requests must name the wire's own torrent or an authenticated flat
BEP49 catalog containing it. Arbitrary chosen scopes receive no identity: this
prevents a fixed query from becoming a global persistent fingerprint.

The post manager authorizes only fully indexed, authenticated flat manifests,
with at most 16 unique components including the root. The native backend reports
only those components to a peer attached to that scope. It never trusts a
peer-supplied list of hashes. Incomplete verification, approval or errors omit
measurements rather than claiming zero stored data. A confirmed absent handle
can be reported as zero.

Requests are bounded to 128 bytes and four per wire, with one root per wire.
Responses fit within 2 KiB. Unsupported versions and malformed messages are
ignored without granting payload access. Status updates use the native plugin
tick and are sent only when their contents change. An authenticated status
subscription may retain an otherwise redundant wire; an unconfirmed scope gets
at most two seconds for application validation. Network errors, host operations
and payload guards retain their normal behavior.

Send the identity request without `watch` to unsubscribe. Publishers should
unsubscribe once a full copy has been observed, retaining the confirmation while
freeing connection slots for more receivers. A receipt is an observation of
verified pieces at that time, not a promise of permanent retention or availability.

Regression: `node dev/tests/replica-identity.mjs`; manifest authorization is covered
by `cargo test -p feedtorrent-posts`. Browser publication acceptance covers complete
copies received from multiple sources and a receiver restart without double counting.
