#define _GNU_SOURCE
/* Linux/OpenBSD test fixture: fail positional writes to one explicitly selected
 * inode after two MiB. Never loaded by a normal application invocation. */
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>

static ssize_t (*next_pwrite)(int, const void *, size_t, off_t);
static ssize_t (*next_pwritev)(int, const struct iovec *, int, off_t);
static atomic_size_t written;

__attribute__((constructor)) static void initialize(void)
{
    next_pwrite = dlsym(RTLD_NEXT, "pwrite");
    next_pwritev = dlsym(RTLD_NEXT, "pwritev");
}

static int exhausted(int fd)
{
    const char *flag = getenv("FEEDTORRENT_TEST_ENOSPC_ACTIVE");
    const char *path = getenv("FEEDTORRENT_TEST_ENOSPC_FILE");
    struct stat actual, target;
    return flag && path && access(flag, F_OK) == 0
        && fstat(fd, &actual) == 0 && stat(path, &target) == 0
        && S_ISREG(actual.st_mode) && actual.st_dev == target.st_dev
        && actual.st_ino == target.st_ino
        && atomic_load(&written) >= 2 * 1024 * 1024;
}

static void account(int fd, ssize_t count)
{
    const char *path = getenv("FEEDTORRENT_TEST_ENOSPC_FILE");
    struct stat actual, target;
    if (count > 0 && path && fstat(fd, &actual) == 0 && stat(path, &target) == 0
        && actual.st_dev == target.st_dev && actual.st_ino == target.st_ino)
        atomic_fetch_add(&written, (size_t)count);
}

ssize_t pwrite(int fd, const void *data, size_t count, off_t offset)
{
    if (count && exhausted(fd)) { errno = ENOSPC; return -1; }
    if (!next_pwrite) { errno = EIO; return -1; }
    ssize_t result = next_pwrite(fd, data, count, offset);
    int error = errno;
    account(fd, result);
    errno = error;
    return result;
}

ssize_t pwritev(int fd, const struct iovec *data, int count, off_t offset)
{
    if (count > 0 && exhausted(fd)) { errno = ENOSPC; return -1; }
    if (!next_pwritev) { errno = EIO; return -1; }
    ssize_t result = next_pwritev(fd, data, count, offset);
    int error = errno;
    account(fd, result);
    errno = error;
    return result;
}

#if defined(__linux__)
/* libtorrent uses _FILE_OFFSET_BITS=64. Interpose those glibc entry points too;
 * the supported Linux package is amd64, where off_t already holds 64 bits. */
ssize_t pwrite64(int fd, const void *data, size_t count, off64_t offset)
{
    return pwrite(fd, data, count, (off_t)offset);
}

ssize_t pwritev64(int fd, const struct iovec *data, int count, off64_t offset)
{
    return pwritev(fd, data, count, (off_t)offset);
}
#endif
