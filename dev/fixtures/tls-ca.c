/* Test-only private CA adapter. LibreSSL on OpenBSD ignores SSL_CERT_FILE.
 * Add the selected fixture CA; keep system trust and certificate verification. */
#include <dlfcn.h>
#include <openssl/ssl.h>
#include <stdlib.h>

int SSL_CTX_set_default_verify_paths(SSL_CTX *context)
{
    int (*original)(SSL_CTX *) = dlsym(RTLD_NEXT, "SSL_CTX_set_default_verify_paths");
    if (!original || original(context) != 1)
        return 0;
    const char *ca = getenv("FEEDTORRENT_TEST_CA");
    return ca ? SSL_CTX_load_verify_locations(context, ca, NULL) : 1;
}
