use anyhow::{bail, Context, Result};
use std::{path::Path, process::Command};

pub fn open_browser(url: &str) -> Result<()> {
    let program = if cfg!(target_os = "macos") {
        "/usr/bin/open"
    } else {
        "xdg-open"
    };
    Command::new(program)
        .arg(url)
        .spawn()
        .context("Could not open browser")?;
    Ok(())
}

pub fn reveal(path: &Path) -> Result<()> {
    let mut command;
    if cfg!(target_os = "macos") {
        command = Command::new("/usr/bin/open");
        command.arg("-R").arg(path);
    } else {
        command = Command::new("xdg-open");
        command.arg(if path.is_dir() {
            path
        } else {
            path.parent().context("File has no parent folder")?
        });
    }
    if !command
        .status()
        .context("Could not open file manager on the server")?
        .success()
    {
        bail!("File manager could not open this folder on the server");
    }
    Ok(())
}
