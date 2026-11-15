use serde::Serialize;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

#[derive(Serialize)]
struct Task<'a> {
    id: &'a str,
    label: &'a str,
}

#[derive(Clone)]
struct LibraryWork(PluginHandle<Wry>);

pub struct Guard {
    plugin: Option<LibraryWork>,
    id: String,
}

impl Guard {
    pub fn start(app: &AppHandle, label: &str) -> Self {
        let guard = Self {
            plugin: app
                .try_state::<LibraryWork>()
                .map(|plugin| plugin.inner().clone()),
            id: uuid::Uuid::new_v4().to_string(),
        };
        guard.label(label);
        guard
    }

    pub fn label(&self, label: &str) {
        if let Some(plugin) = &self.plugin {
            if let Err(error) = plugin.0.run_mobile_plugin::<serde_json::Value>(
                "begin",
                Task {
                    id: &self.id,
                    label,
                },
            ) {
                eprintln!("library work could not enter the background: {error}");
            }
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(plugin) = &self.plugin {
            if let Err(error) = plugin.0.run_mobile_plugin::<serde_json::Value>(
                "end",
                Task {
                    id: &self.id,
                    label: "",
                },
            ) {
                eprintln!("library work could not release the background service: {error}");
            }
        }
    }
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("wave-library-work")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.wave.app", "LibraryWorkPlugin")?;
            app.manage(LibraryWork(handle));
            Ok(())
        })
        .build()
}
