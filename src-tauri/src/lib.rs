mod analytics;
mod artwork;
mod catalog;
mod cover_fetch;
mod deezer;
mod deezer_import;
mod download;
mod genre_fetch;
mod identity;
mod import;
mod import_source;
mod library;
mod loudness;
mod lyrics;
mod lyrics_fetch;
mod migrate;
mod playlists;
mod progress;
mod source;
mod spotify;
mod spotify_import;
mod state;
mod tools;
mod transfer;

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

fn open_catalog(app: &tauri::AppHandle) -> catalog::Catalog {
    let opened = library::library_root(app).and_then(|root| catalog::Catalog::open(&root));

    match opened {
        Ok(catalog) => {
            let store = app.state::<state::Store>();
            match migrate::run(app, &catalog, &store) {
                Ok(Some(report)) => eprintln!(
                    "the library was upgraded: {} songs, {} playlists, {} covers, {} lyrics. \
                     The old records are in {}",
                    report.songs, report.playlists, report.covers, report.lyrics, report.backup
                ),
                Ok(None) => {}
                Err(error) => eprintln!("the library could not be upgraded: {error}"),
            }
            catalog
        }
        Err(error) => {
            eprintln!("the library cannot be opened, so nothing will be kept: {error}");
            catalog::Catalog::in_memory().expect("an in-memory catalog always opens")
        }
    }
}

#[cfg(target_os = "linux")]
fn tune_webkit() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: this runs before the builder starts any thread, so nothing
        // else can be reading the environment at the same time.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    tune_webkit();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = state::Store::load(app.handle());
            app.manage(store);

            let analytics = match analytics::Analytics::open(app.handle()) {
                Ok(analytics) => analytics,
                Err(error) => {
                    eprintln!("the listening history will not be kept: {error}");
                    analytics::Analytics::in_memory()
                }
            };
            app.manage(analytics);

            // Last, because the upgrade renumbers both of the above.
            app.manage(open_catalog(app.handle()));
            if let Ok(root) = library::library_root(app.handle()) {
                if let Err(error) = app.asset_protocol_scope().allow_directory(&root, true) {
                    eprintln!("could not allow the library on the asset protocol: {error}");
                }
            }
            state::watch_window(app.handle());
            source::watch_config(app.handle());

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
            state::set_likes,
            library::scan_library,
            library::library_info,
            library::delete_tracks,
            loudness::analyse_loudness,
            import::import_folder,
            transfer::export_wavelist,
            transfer::import_wavelist,
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
            spotify::spotify_status,
            spotify::open_spotify_config,
            spotify_import::spotify_import,
            spotify_import::spotify_plan,
            deezer_import::deezer_import,
            deezer_import::deezer_plan,
            deezer_import::deezer_status,
            lyrics_fetch::fetch_lyrics,
            cover_fetch::fetch_covers,
            genre_fetch::fetch_genres,
            analytics::analytics_remember_tracks,
            analytics::analytics_record_play,
            analytics::analytics_record_events,
            analytics::analytics_swell,
            analytics::analytics_top_songs,
            analytics::analytics_recommendation_seeds,
            analytics::analytics_stats,
            analytics::analytics_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
