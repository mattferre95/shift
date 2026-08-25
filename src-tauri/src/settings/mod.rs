//! A small JSON file next to the app's config dir. No database (PRD §6).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Last folder the user exported into (EXP-01).
    pub output_dir: Option<String>,
}

pub struct SettingsStore {
    path: PathBuf,
    cache: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load() -> Self {
        let path = config_path();
        let cache = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default();
        Self { path, cache: Mutex::new(cache) }
    }

    pub fn get(&self) -> Settings {
        self.cache.lock().unwrap().clone()
    }

    /// The folder exports default to: last used, else ~/Downloads, else home.
    pub fn default_output_dir(&self) -> PathBuf {
        if let Some(dir) = self.get().output_dir {
            let p = PathBuf::from(dir);
            if p.is_dir() {
                return p;
            }
        }
        dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("/tmp"))
    }

    pub fn set_output_dir(&self, dir: &str) {
        {
            let mut c = self.cache.lock().unwrap();
            c.output_dir = Some(dir.to_string());
        }
        self.persist();
    }

    fn persist(&self) {
        let snapshot = self.get();
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&snapshot) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("SHIFT")
        .join("settings.json")
}
