mod analytics;
mod api;
mod artwork;
mod catalog;
mod cli;
mod cover_fetch;
mod deezer;
mod deezer_import;
mod download;
mod download_log;
mod genre_fetch;
mod identity;
mod import;
mod import_source;
mod library;
mod loudness;
mod lyrics;
mod lyrics_fetch;
mod migrate;
mod playlist_download;
mod playlists;
mod presence;
mod progress;
mod recommend;
mod source;
mod spotify;
mod youtube;
mod spotify_import;
mod state;
mod tools;
mod transfer;
mod update;
mod window_frame;

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

/// Gives the process an AppUserModelID, which is the bundle id the installer
/// stamps onto the Start Menu shortcut.
///
/// Windows names a media session by matching the id the process reports to a
/// shortcut, so without this the media flyout says "Unknown app" and shows no
/// icon. It has to be set before the window exists.
#[cfg(windows)]
fn name_the_process(identifier: &str) {
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    use windows::core::PCWSTR;

    let wide: Vec<u16> = identifier.encode_utf16().chain(std::iter::once(0)).collect();
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide.as_ptr())) };
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

/// The store, the listening record and the catalog, which the window and the
/// command line both work from.
fn prepare(app: &tauri::AppHandle) {
    app.manage(state::Store::load(app));

    let analytics = match analytics::Analytics::open(app) {
        Ok(analytics) => analytics,
        Err(error) => {
            eprintln!("the listening history will not be kept: {error}");
            analytics::Analytics::in_memory()
        }
    };
    app.manage(analytics);

    // Last, because the upgrade renumbers both of the above.
    app.manage(open_catalog(app));
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

    let context: tauri::Context = tauri::generate_context!();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        std::process::exit(cli::run(context, &args));
    }

    #[cfg(windows)]
    name_the_process(&context.config().identifier);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            prepare(app.handle());

            // The bridge is managed whether or not the port can be taken, so
            // the report command has somewhere to put what the window sends.
            app.manage(api::player::Bridge::default());
            if let Some(server) = api::start(app.handle()) {
                app.manage(server);
            }

            if let Ok(root) = library::library_root(app.handle()) {
                if let Err(error) = app.asset_protocol_scope().allow_directory(&root, true) {
                    eprintln!("could not allow the library on the asset protocol: {error}");
                }
            }
            state::watch_window(app.handle());
            source::watch_config(app.handle());
            app.manage(presence::Presence::start(app.handle()));
            presence::watch_config(app.handle());

            #[cfg(windows)]
            disable_browser_shortcuts(app.handle());

            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window_frame::fill_maximized_window(&window);
            }

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
            presence::set_now_playing,
            api::player::api_report,
            update::check_update,
            update::update_status,
            update::install_update,
            library::scan_library,
            library::library_info,
            library::open_library_folder,
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
            recommend::recommend_status,
            recommend::generate_playlist,
            playlist_download::download_playlist,
            download_log::import_log_path,
            download_log::open_import_log,
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
            youtube::youtube_import,
            youtube::youtube_plan,
            youtube::youtube_status,
            lyrics_fetch::fetch_lyrics,
            cover_fetch::fetch_covers,
            genre_fetch::fetch_genres,
            analytics::analytics_remember_tracks,
            analytics::analytics_record_play,
            analytics::analytics_record_events,
            analytics::analytics_swell,
            analytics::analytics_top_songs,
            analytics::analytics_play_counts,
            analytics::analytics_recommendation_seeds,
            analytics::analytics_stats,
            analytics::analytics_clear,
        ])
        .build(context)
        .expect("error while running tauri application");

    app.run(|handle, event| {
        // The media controls have to be let go of while the app is still here,
        // or the song stays in the system's own controls after it has closed.
        if let tauri::RunEvent::Exit = event {
            if let Some(presence) = handle.try_state::<presence::Presence>() {
                presence.shutdown();
            }
            if let Some(server) = handle.try_state::<api::Api>() {
                server.shutdown();
            }
        }
    });
}
