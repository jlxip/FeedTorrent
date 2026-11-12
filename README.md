# FeedTorrent

FeedTorrent is a post-driven Torrent client. You can follow posts which update automatically when the creator publishes a new version, so you can:

1. Follow someone's blog and get updated when there's a new version.
2. Automatically mirror large amounts of organized files.

This project is special precisely because it doesn't invent anything. It follows official BitTorrent Enhancement Proposal (BEP) drafts.

- [BEP 44](https://www.bittorrent.org/beps/bep_0044.html) allows to store signed arbitrary data in the DHT.
- [BEP 46](https://www.bittorrent.org/beps/bep_0046.html) uses that to provide mutable pubkey-indexed torrents, so new versions can be published on the same key.
- [BEP 49](https://www.bittorrent.org/beps/bep_0049.html) implements _feeds_: torrents that include other torrents inside.
- [BEP 50](https://www.bittorrent.org/beps/bep_0050.html) provides a publish/subscribe protocol for fast updates.

So, if FeedTorrent ceases to be updated, the torrents will still be there as long as someone is seeding, ready to use with a different client. The only thing "new" about FeedTorrent is the UX.

## Quickstart: web

This doesn't exist yet!

## Quickstart: native

Download the latest release for your platform [here](https://github.com/jlxip/FeedTorrent/releases/latest), and run the executable.

All your instance files, including downloaded posts, published ones and encrypted private keys will be created under the `user` subdirectory, so it's easy to back up.
