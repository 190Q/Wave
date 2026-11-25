use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};
use zbus::blocking::{Connection, Proxy};

#[derive(Default)]
pub(crate) struct ScreenBlanked(AtomicBool);

#[tauri::command]
pub fn screen_blanked(state: State<'_, ScreenBlanked>) -> bool {
    state.0.load(Ordering::Acquire)
}

pub fn start(app: &AppHandle) {
    app.manage(ScreenBlanked::default());
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = watch(&app);
        update(&app, false);
    });
}

fn watch(app: &AppHandle) -> zbus::Result<()> {
    let connection = Connection::session()?;
    let proxy = Proxy::new(
        &connection,
        "org.gnome.ScreenSaver",
        "/org/gnome/ScreenSaver",
        "org.gnome.ScreenSaver",
    )?;
    let signals = proxy.receive_signal("ActiveChanged")?;
    if let Ok(active) = proxy.call::<_, _, bool>("GetActive", &()) {
        update(app, active);
    }
    for signal in signals {
        if let Ok((active,)) = signal.body().deserialize::<(bool,)>() {
            update(app, active);
        }
    }
    Ok(())
}

fn update(app: &AppHandle, active: bool) {
    let state = app.state::<ScreenBlanked>();
    if state.0.swap(active, Ordering::AcqRel) != active {
        let _ = app.emit("screen-blanked", active);
    }
}
