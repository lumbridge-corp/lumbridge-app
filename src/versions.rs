//! Which app and core run here, for the settings screen. Builds are from
//! source and nothing updates itself: there is no update check, download or
//! release server (`lumbridge-app-update` rebuilds and reinstalls).

use std::sync::Mutex;

/// The core the app runs, from its `server.status`.
#[derive(Clone, Default, serde::Serialize)]
pub struct CoreInfo {
    pub version: Option<String>,
    /// Who installed it (homebrew, nix, mise, …), as the core says.
    pub managed: Option<String>,
}

static CORE: Mutex<CoreInfo> = Mutex::new(CoreInfo { version: None, managed: None });

pub fn core() -> CoreInfo {
    CORE.lock().unwrap().clone()
}

/// What the connected core says about itself (on connect and every reconnect).
pub fn set_core(version: Option<String>, managed: Option<String>) {
    *CORE.lock().unwrap() = CoreInfo { version, managed };
}

/// For the settings screen: both programs' versions.
pub fn status() -> serde_json::Value {
    serde_json::json!({
        "app": { "version": env!("CARGO_PKG_VERSION") },
        "core": core(),
    })
}
