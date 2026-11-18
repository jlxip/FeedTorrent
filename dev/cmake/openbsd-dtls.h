/* Initialize LibreSSL's DTLS MTU before libdatachannel registers its incoming
 * callback. A ClientHello may otherwise be processed before start() sets MTU,
 * which LibreSSL treats as a fatal assertion with SSL_OP_NO_QUERY_MTU.
 * The normal start() call still applies the connection's configured MTU.
 * LibreSSL 4.4 also queries the fallback MTU after retransmissions despite
 * NO_QUERY_MTU. Supply libdatachannel's conservative default instead of zero. */
#ifndef FEEDTORRENT_OPENBSD_DTLS_H
#define FEEDTORRENT_OPENBSD_DTLS_H
#include <openssl/ssl.h>
#include <rtc/rtc.h>
#ifdef LIBRESSL_VERSION_NUMBER
static inline void feedtorrent_dtls_connect_state(SSL *ssl)
{
    SSL_set_connect_state(ssl);
    SSL_set_mtu(ssl, RTC_DEFAULT_MTU - 8 - 40);
}
static inline void feedtorrent_dtls_accept_state(SSL *ssl)
{
    SSL_set_accept_state(ssl);
    SSL_set_mtu(ssl, RTC_DEFAULT_MTU - 8 - 40);
}
template <long (*Callback)(BIO *, int, long, void *)>
static long feedtorrent_dtls_bio_ctrl(BIO *bio, int command, long value, void *pointer)
{
    switch (command) {
    case BIO_CTRL_DGRAM_QUERY_MTU:
    case BIO_CTRL_DGRAM_GET_MTU:
    case BIO_CTRL_DGRAM_GET_FALLBACK_MTU:
        return RTC_DEFAULT_MTU - 8 - 40;
    default:
        return Callback(bio, command, value, pointer);
    }
}
#define BIO_meth_set_ctrl(method, callback) \
    BIO_meth_set_ctrl((method), feedtorrent_dtls_bio_ctrl<callback>)
#define SSL_set_connect_state feedtorrent_dtls_connect_state
#define SSL_set_accept_state feedtorrent_dtls_accept_state
#endif
#endif
