mod artwork;
mod import;
mod library;
mod lyrics;
mod playlists;
mod state;

use tauri::Manager;

/// Reveals the main window once the UI has applied the saved theme and song.
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    reveal_main_window(&app);
}

#[cfg(windows)]
fn disable_browser_shortcuts(app: &tauri::AppHandle) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.with_webview(|webview| {
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
            return;
        };
        let Ok(settings) = (unsafe { core.Settings() }) else {
            return;
        };
        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
            return;
        };

        let _ = unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) };
    });
}

fn reveal_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        return;
    }

    let store = app.state::<state::Store>();
    state::restore_window_geometry(app, &store);
    state::apply_window_settings(app, &store, store.snapshot().settings.mini_player);
    let _ = window.show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = state::Store::load(app.handle());
            app.manage(store);
            // Filled in by every scan; playlist files store paths, not ids.
            app.manage(library::TrackPaths::default());
            state::watch_window(app.handle());

            #[cfg(windows)]
            disable_browser_shortcuts(app.handle());

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(6));
                reveal_main_window(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_main_window,
            state::get_state,
            state::set_settings,
            state::set_session,
            state::save_window_geometry,
            state::reset_window_geometry,
            state::save_window_slot,
            state::apply_window_slot,
            state::place_mini_player,
            state::toggle_like,
            library::scan_library,
            import::import_folder,
            playlists::create_playlist,
            playlists::rename_playlist,
            playlists::delete_playlist,
            playlists::add_to_playlist,
            playlists::remove_from_playlist,
            playlists::reorder_playlist,
            artwork::artwork_colour,
            artwork::artwork_bytes,
            artwork::cover_bytes,
            lyrics::load_lyrics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
