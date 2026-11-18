/* libjuice uses a single dual-stack socket by default. OpenBSD forbids
 * IPv4-mapped IPv6 sockets, so select IPv4 for its implicit wildcard binding.
 * This header is included only when compiling libjuice on OpenBSD; explicit
 * bindings and libtorrent's TCP/uTP/DHT sockets retain their normal behavior. */
#ifndef FEEDTORRENT_OPENBSD_ICE_H
#define FEEDTORRENT_OPENBSD_ICE_H
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
static inline int feedtorrent_ice_getaddrinfo(const char *host, const char *service,
    const struct addrinfo *hints, struct addrinfo **result)
{
    if (!host && hints && hints->ai_family == AF_UNSPEC &&
        hints->ai_socktype == SOCK_DGRAM && (hints->ai_flags & AI_PASSIVE)) {
        struct addrinfo ipv4 = *hints;
        ipv4.ai_family = AF_INET;
        return getaddrinfo(host, service, &ipv4, result);
    }
    return getaddrinfo(host, service, hints, result);
}
#define getaddrinfo feedtorrent_ice_getaddrinfo
#endif
