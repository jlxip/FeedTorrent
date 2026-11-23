#define _GNU_SOURCE
/* Linux-only update fixture. Fail writes only inside private update stages,
 * while an explicitly supplied flag exists. Never used in normal invocation. */
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static ssize_t (*real_write)(int, const void *, size_t);
__attribute__((constructor)) static void initialize(void)
{
    real_write = dlsym(RTLD_NEXT, "write");
}
ssize_t write(int fd, const void *data, size_t count)
{
    const char *flag = getenv("FEEDTORRENT_UPDATE_TEST_FULL");
    if (count && flag && access(flag, F_OK) == 0) {
        char proc[64], path[4096];
        snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd);
        ssize_t n = readlink(proc, path, sizeof(path) - 1);
        if (n > 0) {
            path[n] = 0;
            if (strstr(path, "/.feedtorrent-update-")) {
                errno = ENOSPC;
                return -1;
            }
        }
    }
    if (!real_write) { errno = EIO; return -1; }
    return real_write(fd, data, count);
}
