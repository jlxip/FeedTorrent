use anyhow::{Context, Result};

/// Desktop launchers can inherit a 256-descriptor soft limit. WebRTC ICE
/// negotiations also use sockets, before peers enter libtorrent's peer limit.
/// Raise only this process's soft limit, leaving the administrator's hard cap.
pub fn prepare() -> Result<()> {
    #[cfg(unix)]
    {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: limit is a valid writable rlimit and RLIMIT_NOFILE is native.
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
            return Err(std::io::Error::last_os_error())
                .context("Cannot read the process file-descriptor limit");
        }
        let desired = limit.rlim_max.min(4096);
        if limit.rlim_cur < desired {
            limit.rlim_cur = desired;
            // SAFETY: getrlimit initialized both fields; the hard cap is unchanged.
            if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
                return Err(std::io::Error::last_os_error())
                    .context("Cannot raise the process file-descriptor limit");
            }
        }
    }
    Ok(())
}
