use crate::organization::Organization;
use crate::{atomic, read_limited};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostState {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<serde_json::Value>,
    pub organization: Organization,
}

impl Default for PostState {
    fn default() -> Self {
        Self {
            version: 1,
            checkpoint: None,
            organization: Organization::default(),
        }
    }
}

pub fn load(dir: &Path) -> Result<PostState> {
    let path = dir.join("posts.json");
    if !path.exists() {
        return Ok(PostState::default());
    }
    let state: PostState = serde_json::from_slice(&read_limited(&path)?)?;
    if state.version != 1 {
        bail!("Unsupported post state version");
    }
    state.organization.validate()?;
    Ok(state)
}

impl PostState {
    pub fn save(&self, dir: &Path) -> Result<()> {
        atomic(&dir.join("posts.json"), &serde_json::to_vec_pretty(self)?)
    }
}
