# Gateway publication notifications

A successful opt-in signed BEP44 PUT also notifies the local post manager when
that exact key/salt is still followed. The original signed record remains in the
bounded native operation until its terminal event. Delivery requires the expected
target and at least one DHT acknowledgement, and happens once per native write,
even if its HTTP clients have departed. Coalesced clients share that delivery.

The manager applies the same signature, sequence, conflict, checkpoint and download
policy as other updates. It emits its existing BEP50 relay after persistence;
this path does not create subscriptions or follow posts. Unknown and unfollowed
keys retain ordinary BEP44 gateway behavior. Unsupported post values retain the
manager's existing handling.

HTTP responses remain DHT confirmations. They do not wait for payload, local
checkpoint or BEP50 acknowledgements. Overlay failure cannot undo the confirmed
write or prevent local adoption. The periodic 15-minute DHT check remains the
fallback after missed notifications or restarts; there is no new notification
journal or queue. Cancellation before dispatch does no work; after dispatch the
real native outcome determines notification, including after writes are disabled.

Validation: gateway/post Rust unit tests and `dev/tests/dht-gateway-notify.mjs`.
The integration uses private DHT, two real application instances and established
BEP50 contacts, and proves adoption without a new periodic DHT check. It also
checks verified catalog replication, idempotency and no automatic follows.
