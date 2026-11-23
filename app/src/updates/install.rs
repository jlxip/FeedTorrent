use super::*;
use anyhow::Context as _;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    io::{Read, Seek, SeekFrom},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    process::Stdio,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};
pub const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_UNPACKED: u64 = 1024 * 1024 * 1024;
const OWNER: &str = "FeedTorrent application update 1";
pub fn hash_bytes(bytes: &[u8]) -> String {
    feedtorrent_posts::hex(&Sha256::digest(bytes))
}
fn hash(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(feedtorrent_posts::hex(&digest.finalize()))
}
fn private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)?;
    Ok(())
}
fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
#[derive(Serialize, Deserialize)]
struct Owner {
    kind: String,
    operation: String,
    executable: PathBuf,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    operation: String,
    version: String,
    executable: PathBuf,
    stage: PathBuf,
    backup: PathBuf,
    hash: String,
    status: String,
    previous: Option<PathBuf>,
}
pub struct Context {
    executable: PathBuf,
    original: Arc<File>,
    identity: (u64, u64),
    args: Vec<OsString>,
    journal: PathBuf,
    port: u16,
}
pub struct Stage {
    path: PathBuf,
    keep: bool,
}
impl Drop for Stage {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
pub struct Package {
    stage: Stage,
    root: PathBuf,
    version: String,
    hash: String,
}
pub struct Prepared {
    package: Package,
    executable: PathBuf,
    backup: PathBuf,
    original_hash: String,
    args: Vec<OsString>,
    journal: PathBuf,
    record: Journal,
    _lock: File,
}
impl Context {
    pub fn new(dir: &Path, port: u16) -> Result<Self> {
        let executable = fs::canonicalize(std::env::current_exe()?)?;
        let original = File::open(&executable)?;
        let meta = original.metadata()?;
        if !meta.is_file() {
            bail!("The running executable is not a regular file");
        }
        let mut args = Vec::new();
        let mut skip = false;
        for a in std::env::args_os().skip(1) {
            if skip {
                skip = false;
                continue;
            }
            if a == "--http-port" {
                skip = true;
                continue;
            }
            if a.to_str().is_some_and(|s| s.starts_with("--http-port=")) || a == "--no-open" {
                continue;
            }
            args.push(a);
        }
        args.extend([
            "--http-port".into(),
            port.to_string().into(),
            "--no-open".into(),
        ]);
        let state = dir.join("updates");
        fs::create_dir_all(&state)?;
        Ok(Self {
            executable,
            original: Arc::new(original),
            identity: (meta.dev(), meta.ino()),
            args,
            journal: state.join("install.json"),
            port,
        })
    }
    pub fn completed(&self) -> Result<Option<Completed>> {
        if !self.journal.exists() {
            return Ok(None);
        }
        let mut j: Journal = serde_json::from_slice(&fs::read(&self.journal)?)?;
        if j.executable != self.executable {
            return Ok(None);
        }
        let installed = version(&j.version)? == version(env!("CARGO_PKG_VERSION"))?
            && hash(&self.executable)? == j.hash;
        if installed {
            j.status = "installed".into();
            if let Some(previous) = j.previous.take() {
                remove_owned(&previous, &self.executable)?;
            }
            crate::atomic(&self.journal, &serde_json::to_vec(&j)?)?;
        } else if j.status == "restarting" {
            j.status = "recovered".into();
            crate::atomic(&self.journal, &serde_json::to_vec(&j)?)?;
        }
        Ok(Some(Completed {
            operation: j.operation,
            version: j.version,
            status: j.status,
            recovery: j.backup.display().to_string(),
        }))
    }
    pub fn stage(&self) -> Result<Stage> {
        let path = self
            .executable
            .parent()
            .context("Executable has no parent")?
            .join(format!(".feedtorrent-update-{}", random_id()?));
        private_dir(&path).context(
            "The executable directory is not writable; no privilege escalation is attempted",
        )?;
        Ok(Stage { path, keep: false })
    }
    pub async fn prepare(&self, package: Package, op: &str) -> Result<Prepared> {
        let executable = self.executable.clone();
        let original = self.original.clone();
        let identity = self.identity;
        let journal = self.journal.clone();
        let args = self.args.clone();
        let op = op.to_owned();
        let port = self.port;
        tokio::task::spawn_blocking(move || {
            if hash(&package.root.join("feedtorrent"))? != package.hash {
                bail!("Candidate changed after verification");
            }
            let parent = executable.parent().unwrap();
            let lock_path = parent.join(format!(
                ".feedtorrent-update-{}.lock",
                &hash_bytes(executable.as_os_str().as_encoded_bytes())[..16]
            ));
            let lock = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(lock_path)?;
            lock.try_lock()
                .context("Another process is updating this executable")?;
            // Keep the original inode open from boot. Copy that inode, never an
            // executable another instance may have installed in the meantime.
            let mut input = original.try_clone()?;
            input.seek(SeekFrom::Start(0))?;
            let previous = package.stage.path.join("previous");
            private_dir(&previous)?;
            let backup = previous.join("feedtorrent");
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o755)
                .open(&backup)?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
            drop(output);
            let original_hash = hash(&backup)?;
            let meta = fs::metadata(&executable)?;
            let actual = hash(&executable)?;
            if ((meta.dev(), meta.ino()) != identity || actual != original_hash)
                && actual != package.hash
            {
                bail!("The executable changed since startup; restart before updating");
            }
            if fs::symlink_metadata(&executable)?.file_type().is_symlink() {
                bail!("Executable path became a symbolic link");
            }
            let prior = fs::read(&journal)
                .ok()
                .and_then(|b| serde_json::from_slice::<Journal>(&b).ok());
            let owner = Owner {
                kind: OWNER.into(),
                operation: op.clone(),
                executable: executable.clone(),
            };
            crate::atomic(
                &package.stage.path.join("owner.json"),
                &serde_json::to_vec(&owner)?,
            )?;
            let record = Journal {
                operation: op,
                version: package.version.clone(),
                executable: executable.clone(),
                stage: package.stage.path.clone(),
                backup: backup.clone(),
                hash: package.hash.clone(),
                status: "restarting".into(),
                previous: prior.map(|j| j.stage),
            };
            // A restart must reserve the same HTTP port, even when the original
            // process selected a free default port at startup.
            if port == 0 {
                bail!("Cannot restart without the actual HTTP port");
            }
            sync_dir(&previous)?;
            sync_dir(&package.root)?;
            sync_dir(&package.stage.path)?;

            Ok(Prepared {
                package,
                executable,
                backup,
                original_hash,
                args,
                journal,
                record,
                _lock: lock,
            })
        })
        .await?
    }
}
fn remove_owned(path: &Path, executable: &Path) -> Result<()> {
    let Some(parent) = executable.parent() else {
        return Ok(());
    };
    if path.parent() != Some(parent)
        || !path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with(".feedtorrent-update-"))
    {
        return Ok(());
    }
    let owner: Owner = match fs::read(path.join("owner.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(o) => o,
        None => return Ok(()),
    };
    if owner.kind == OWNER
        && owner.executable == executable
        && !fs::symlink_metadata(path)?.file_type().is_symlink()
    {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}
pub fn unpack(stage: Stage, archive: Vec<u8>, offer: &Offer) -> Result<Package> {
    let name = format!("feedtorrent-{}-{}", offer.version, offer.target);
    let root = stage.path.join(&name);
    let mut tar = tar::Archive::new(GzDecoder::new(&archive[..]));
    let mut total = 0u64;
    let mut names = BTreeSet::new();
    let mut files = 0;
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let text = path
            .to_str()
            .context("Non-UTF-8 package path")?
            .trim_end_matches('/');
        let parts: Vec<_> = text.split('/').collect();
        if parts.first() != Some(&name.as_str())
            || parts
                .iter()
                .any(|p| p.is_empty() || *p == "." || *p == "..")
            || path.is_absolute()
            || !names.insert(text.to_owned())
            || names.len() > 10000
        {
            bail!("Unsafe or duplicate package path");
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            bail!("Package links and special files are forbidden");
        }
        let size = entry.size();
        total = total.checked_add(size).context("Package size overflow")?;
        if total > MAX_UNPACKED {
            bail!("Unpacked package exceeds 1 GiB");
        }
        if parts.len() > 1
            && !matches!(
                parts[1],
                "feedtorrent" | "BUILD-INFO.json" | "THIRD_PARTY.json" | "licenses"
            )
        {
            bail!("Unexpected package entry");
        }
        if parts.len() > 2 && parts[1] != "licenses" {
            bail!("Invalid package layout");
        }
        let out = stage.path.join(&path);
        if kind.is_dir() {
            if !out.exists() {
                private_dir(&out)?;
            }
            continue;
        }
        if parts.len() == 1 {
            bail!("Package root must be a directory");
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&out)?;
        std::io::copy(&mut entry, &mut file)?;
        file.sync_all()?;
        files += 1;
    }
    if files < 4 || !root.join("licenses").is_dir() {
        bail!("Package licenses or metadata missing");
    }
    for file in ["BUILD-INFO.json", "THIRD_PARTY.json"] {
        if fs::metadata(root.join(file))?.len() > 8 * 1024 * 1024 {
            bail!("Package metadata too large");
        }
    }
    let info: serde_json::Value = serde_json::from_slice(&fs::read(root.join("BUILD-INFO.json"))?)?;
    let binary = root.join("feedtorrent");
    let digest = hash(&binary)?;
    if info["version"] != format!("v{}", offer.version.trim_start_matches('v'))
        || info["tag"] != offer.version
        || info["target"] != offer.target
        || info["binary_sha256"] != digest
        || info["dirty"] != false
    {
        bail!("Package build information does not match the release");
    }
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))?;
    Ok(Package {
        stage,
        root,
        version: offer.version.clone(),
        hash: digest,
    })
}
pub async fn probe(package: &Package, client: &Client) -> Result<()> {
    let binary = package.root.join("feedtorrent");
    let mut version_child = tokio::process::Command::new(&binary)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("Candidate cannot execute on this host")?;
    let mut stdout = version_child.stdout.take().unwrap().take(1025);
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), stdout.read_to_end(&mut bytes)).await??;
    let status = tokio::time::timeout(Duration::from_secs(10), version_child.wait()).await??;
    if bytes.len() > 1024
        || !status.success()
        || String::from_utf8(bytes)?.trim()
            != format!("feedtorrent v{}", package.version.trim_start_matches('v'))
    {
        bail!("Candidate --version does not match the selected release");
    }
    let scratch = package.stage.path.join("probe");
    private_dir(&scratch)?;
    let mut child = tokio::process::Command::new(&binary)
        .args([
            "--no-open",
            "--isolated",
            "--peer-port",
            "0",
            "--http-port",
            "0",
            "--data-dir",
        ])
        .arg(scratch.join("data"))
        .arg("--download-dir")
        .arg(scratch.join("downloads"))
        .current_dir(&scratch)
        .env_remove("FEEDTORRENT_UPDATE_TEST_ORIGIN")
        .env_remove("FEEDTORRENT_UPDATE_TEST_CA")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut output = tokio::io::BufReader::new(child.stdout.take().unwrap());
    let ready = async {
        let mut count = 0;
        let origin = loop {
            let mut bytes = Vec::new();
            let n = (&mut output)
                .take(8193)
                .read_until(b'\n', &mut bytes)
                .await?;
            if n == 0 || n > 8192 || count > 64 {
                bail!("Candidate did not report its local HTTP address");
            }
            count += 1;
            if let Some(raw) = std::str::from_utf8(&bytes)?
                .trim()
                .strip_prefix("FeedTorrent ")
            {
                let u = Url::parse(raw)?;
                if u.scheme() != "http"
                    || u.host_str() != Some("127.0.0.1")
                    || u.port().is_none()
                    || u.path() != "/"
                    || u.query().is_some()
                    || u.fragment().is_some()
                    || !u.username().is_empty()
                {
                    bail!("Invalid candidate HTTP address");
                }
                break u;
            }
        };
        let root = client
            .get(origin.clone())
            .send()
            .await?
            .error_for_status()?;
        let cookie = root
            .headers()
            .get(header::SET_COOKIE)
            .context("Candidate did not establish a session")?
            .to_str()?
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let response = client
            .get(origin.join("api/snapshot")?)
            .header(header::COOKIE, cookie)
            .send()
            .await?
            .error_for_status()?;
        let value: serde_json::Value =
            serde_json::from_slice(&bounded(response, 8 * 1024 * 1024, |_, _| {}).await?)?;
        if value["ready"] != true {
            bail!("Candidate API is not ready");
        }
        Ok::<_, anyhow::Error>(())
    };
    let result = tokio::time::timeout(Duration::from_secs(60), ready)
        .await
        .context("Candidate startup probe timed out")
        .and_then(|r| r);
    if let Some(id) = child.id() {
        unsafe {
            libc::kill(id as i32, libc::SIGTERM);
        }
    }
    let stopped = tokio::time::timeout(Duration::from_secs(30), child.wait()).await;
    match stopped {
        Ok(Ok(status)) if status.success() => {}
        _ => {
            let _ = child.kill().await;
            bail!("Candidate did not stop cleanly after its isolated probe");
        }
    }
    result?;
    fs::remove_dir_all(scratch)?;
    Ok(())
}
impl Prepared {
    pub fn recovery(&self) -> String {
        self.backup.display().to_string()
    }
    pub fn apply_and_exec(mut self) -> Result<()> {
        self.package.stage.keep = true;
        let candidate = self.package.root.join("feedtorrent");
        if hash(&candidate)? != self.package.hash {
            bail!(
                "Verified candidate changed before replacement. Previous copy: {}",
                self.backup.display()
            );
        }
        let actual = hash(&self.executable)?;
        if actual != self.original_hash && actual != self.package.hash {
            bail!(
                "Executable changed before replacement. Previous copy: {}",
                self.backup.display()
            );
        }
        crate::atomic(&self.journal, &serde_json::to_vec(&self.record)?)?;
        let replace = actual != self.package.hash;
        if replace {
            if let Err(error) = fs::rename(&candidate, &self.executable) {
                return self.recover(error.into());
            }
            if let Err(error) = sync_dir(self.executable.parent().unwrap()) {
                return self.recover(error);
            }
        }
        let error = std::process::Command::new(&self.executable)
            .args(&self.args)
            .exec();
        self.recover(error.into())
    }
    fn recover(mut self, error: anyhow::Error) -> Result<()> {
        // Copy, then rename: retain the verified previous copy for manual recovery.
        if hash(&self.backup)? != self.original_hash {
            bail!(
                "Previous executable changed; recovery copy: {}",
                self.backup.display()
            );
        }
        let restore = self.package.stage.path.join("restore");
        fs::copy(&self.backup, &restore).context("Cannot stage executable recovery")?;
        File::open(&restore)?.sync_all()?;
        fs::rename(&restore, &self.executable).context("Cannot restore previous executable")?;
        sync_dir(self.executable.parent().unwrap())?;
        self.record.status = "recovered".into();
        crate::atomic(&self.journal, &serde_json::to_vec(&self.record)?)?;
        eprintln!("Application update failed: {error:#}. Restored the previous executable.");
        let failed = std::process::Command::new(&self.executable)
            .args(&self.args)
            .exec();
        bail!(
            "Cannot restart recovered executable: {failed}. Previous copy: {}",
            self.backup.display()
        )
    }
}
