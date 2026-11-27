#![cfg_attr(not(desktop), allow(dead_code))]

mod analytics;
mod analytics_transfer;
#[cfg(not(target_os = "android"))]
mod api;
#[cfg(target_os = "android")]
mod apk;
mod artwork;
#[cfg(any(windows, target_os = "android"))]
mod audio_outputs;
#[cfg(any(target_os = "android", target_os = "linux", test))]
mod audio_stream;
mod catalog;
#[cfg(desktop)]
mod cli;
mod cover_fetch;
mod deezer;
mod deezer_import;
#[cfg(desktop)]
mod dev_library;
mod download;
mod download_log;
mod genre_fetch;
mod identity;
mod import;
mod import_source;
mod library;
#[cfg(target_os = "android")]
mod library_work;
#[cfg(any(target_os = "linux", test))]
mod linux_playback;
mod loudness;
mod lyrics;
mod lyrics_fetch;
#[cfg(target_os = "android")]
mod media_session;
mod migrate;
#[cfg(target_os = "android")]
mod music_library;
mod playlist_download;
mod playlists;
mod presence;
mod progress;
mod recommend;
#[cfg(target_os = "linux")]
mod screen;
mod search;
#[cfg(desktop)]
mod song_editor;
mod source;
mod spotify;
mod spotify_import;
mod state;
mod tools;
mod transfer;
mod update;
#[cfg(desktop)]
mod window_frame;
mod youtube;
mod youtube_mix;
#[cfg(any(target_os = "android", test))]
mod youtube_phone;

use tauri::Manager;

struct FrontendHealth(std::sync::Arc<std::sync::atomic::AtomicBool>);

#[cfg(desktop)]
static MAIN_WINDOW_REVEALED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn report_frontend_startup(ready: bool, detail: String, health: tauri::State<'_, FrontendHealth>) {
    if ready {
        health.0.store(true, std::sync::atomic::Ordering::Relaxed);
        eprintln!("wave: frontend ready ({detail})");
    } else {
        eprintln!("wave: frontend startup error: {detail}");
    }
}

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

    let wide: Vec<u16> = identifier
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide.as_ptr())) };
}

fn reveal_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    #[cfg(desktop)]
    if MAIN_WINDOW_REVEALED.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    if window.is_visible().unwrap_or(false) {
        return;
    }

    // A phone's window is the whole screen, so there is no frame to put back
    // and no mini player to sit in a corner.
    #[cfg(desktop)]
    {
        let store = app.state::<state::Store>();
        state::restore_window_geometry(app, &store);
        state::apply_window_settings(app, &store, store.snapshot().settings.mini_player);
    }

    if window.show().is_err() {
        #[cfg(desktop)]
        MAIN_WINDOW_REVEALED.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// The store, the listening record and the catalog, which the window and the
/// command line both work from.
fn prepare(app: &tauri::AppHandle) -> Result<(), String> {
    app.manage(state::Store::load(app)?);

    app.manage(open_analytics(app)?);

    // Last, because the upgrade renumbers both of the above.
    app.manage(open_catalog(app)?);
    Ok(())
}

fn open_analytics(app: &tauri::AppHandle) -> Result<analytics::Analytics, String> {
    #[cfg(desktop)]
    if dev_library::shared() {
        let dir = dev_library::installed_data_dir(app)?;
        return analytics::Analytics::open_shared(&dir)
            .map_err(|error| format!("the shared listening record cannot be opened: {error}; use npm run tauri dev isolated for a separate library"));
    }

    Ok(match analytics::Analytics::open(app) {
        Ok(analytics) => analytics,
        Err(error) => {
            eprintln!("the listening history will not be kept: {error}");
            analytics::Analytics::in_memory()
        }
    })
}

fn open_catalog(app: &tauri::AppHandle) -> Result<catalog::Catalog, String> {
    let root = library::library_root(app)?;
    #[cfg(desktop)]
    if dev_library::shared() {
        eprintln!("wave: using the installed library at {}", root.display());
        return catalog::Catalog::open_shared(&root)
            .map_err(|error| format!("the shared library cannot be opened: {error}"));
    }

    let catalog = catalog::Catalog::open(&root)
        .map_err(|error| format!("the library cannot be opened: {error}"))?;
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
    library::recover_metadata_edits(&root, &catalog);
    Ok(catalog)
}

#[cfg(target_os = "android")]
fn install_tls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Desktop development builds use their own WebView and settings, whether the
/// library is shared with an installed copy or kept separate.
#[cfg(desktop)]
fn configure_desktop_identity(
    config: &mut tauri::utils::config::Config,
    development: bool,
    shared: bool,
) {
    if !development {
        return;
    }

    config
        .identifier
        .push_str(if shared { ".dev.shared" } else { ".dev" });
    if let Some(window) = config
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
    {
        window
            .title
            .push_str(if shared { " Dev (Shared)" } else { " Dev" });
    }
}

#[cfg(all(test, desktop))]
mod desktop_identity_tests {
    use super::configure_desktop_identity;

    fn config() -> tauri::utils::config::Config {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    #[test]
    fn development_has_its_own_identity_and_window_title() {
        let mut config = config();
        configure_desktop_identity(&mut config, true, false);

        assert_eq!(config.identifier, "com.wave.app.dev");
        assert_eq!(config.app.windows[0].title, "Wave Dev");
    }

    #[test]
    fn release_keeps_its_existing_identity_and_window_title() {
        let mut config = config();
        configure_desktop_identity(&mut config, false, false);

        assert_eq!(config.identifier, "com.wave.app");
        assert_eq!(config.app.windows[0].title, "Wave");
    }

    #[test]
    fn current_build_uses_the_corresponding_identity() {
        let mut config = config();
        configure_desktop_identity(&mut config, cfg!(dev), false);

        let expected = if cfg!(dev) {
            "com.wave.app.dev"
        } else {
            "com.wave.app"
        };
        assert_eq!(config.identifier, expected);
    }

    #[test]
    fn shared_development_has_its_own_identity_and_window_title() {
        let mut config = config();
        configure_desktop_identity(&mut config, true, true);

        assert_eq!(config.identifier, "com.wave.app.dev.shared");
        assert_eq!(config.app.windows[0].title, "Wave Dev (Shared)");
    }

    #[test]
    fn release_ignores_the_shared_development_option() {
        let mut config = config();
        configure_desktop_identity(&mut config, false, true);

        assert_eq!(config.identifier, "com.wave.app");
        assert_eq!(config.app.windows[0].title, "Wave");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    install_tls_provider();

    let context: tauri::Context = tauri::generate_context!();

    #[cfg(desktop)]
    let context = {
        let mut context = context;
        configure_desktop_identity(context.config_mut(), cfg!(dev), dev_library::shared());
        context
    };

    // A phone is started by the system, from an icon rather than a terminal, so
    // there is no command line to read and no console to read it from.
    #[cfg(desktop)]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if !args.is_empty() {
            std::process::exit(cli::run(context, &args));
        }
    }

    #[cfg(windows)]
    name_the_process(&context.config().identifier);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(media_session::init())
        .plugin(library_work::init())
        .plugin(music_library::init())
        .plugin(apk::init());

    let app = builder
        .setup(|app| {
            prepare(app.handle()).map_err(std::io::Error::other)?;

            #[cfg(target_os = "linux")]
            screen::start(app.handle());

            let frontend_ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            app.manage(FrontendHealth(frontend_ready.clone()));
            #[cfg(target_os = "linux")]
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(30));
                if !frontend_ready.load(std::sync::atomic::Ordering::Relaxed) {
                    eprintln!("wave: frontend did not report ready; check WebKit processes and the session logs");
                }
            });

            #[cfg(any(target_os = "android", target_os = "linux"))]
            match audio_stream::AudioStream::start(app.handle()) {
                Ok(stream) => {
                    app.manage(stream);
                }
                Err(error) => eprintln!("the audio stream could not start: {error}"),
            }

            #[cfg(target_os = "linux")]
            app.manage(linux_playback::NativePlayback::start(app.handle()));

            #[cfg(target_os = "android")]
            app.manage(loudness::PlaybackActivity::default());

            #[cfg(not(target_os = "android"))]
            {
                app.manage(api::player::Bridge::default());
                let server = api::Api::default();
                if app.state::<state::Store>().snapshot().settings.local_api_enabled {
                    if let Err(error) = server.set_enabled(app.handle(), true) {
                        eprintln!("{error}");
                    }
                }
                app.manage(server);
            }

            if let Ok(root) = library::library_root(app.handle()) {
                if let Err(error) = app.asset_protocol_scope().allow_directory(&root, true) {
                    eprintln!("could not allow the library on the asset protocol: {error}");
                }
            }
            #[cfg(desktop)]
            state::watch_window(app.handle());
            source::watch_config(app.handle());
            app.manage(presence::Presence::start(app.handle()));
            #[cfg(desktop)]
            presence::watch_config(app.handle());
            #[cfg(target_os = "linux")]
            {
                let player = app.state::<linux_playback::NativePlayback>().inner().clone();
                let handle = app.handle().clone();
                std::thread::spawn(move || player.restore_session(&handle));
            }

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
            report_frontend_startup,
            #[cfg(target_os = "linux")]
            screen::screen_blanked,
            #[cfg(any(windows, target_os = "android"))]
            audio_outputs::get_audio_outputs,
            state::get_state,
            state::set_settings,
            state::patch_settings,
            state::set_session,
            state::save_window_geometry,
            state::reset_window_geometry,
            state::save_window_slot,
            state::apply_window_slot,
            state::place_mini_player,
            state::toggle_like,
            state::set_likes,
            presence::set_now_playing,
            presence::set_queue,
            #[cfg(any(target_os = "android", target_os = "linux"))]
            audio_stream::audio_stream_base,
            #[cfg(target_os = "linux")]
            linux_playback::runtime::linux_native_playback_sync,
            #[cfg(target_os = "linux")]
            linux_playback::runtime::linux_native_playback_command,
            #[cfg(target_os = "linux")]
            linux_playback::runtime::linux_native_playback_state,
            #[cfg(not(target_os = "android"))]
            api::player::api_report,
            #[cfg(target_os = "android")]
            loudness::report_playback_activity,
            update::check_update,
            update::update_status,
            update::install_update,
            library::scan_library,
            library::reread_tags,
            library::edit_track,
            library::cleanup_track_edit,
            #[cfg(desktop)]
            song_editor::stage_editor_audio,
            #[cfg(desktop)]
            song_editor::discard_editor_audio,
            #[cfg(desktop)]
            song_editor::save_song_edit,
            #[cfg(desktop)]
            song_editor::cleanup_edited_audio,
            #[cfg(desktop)]
            song_editor::editor_waveform,
            #[cfg(desktop)]
            song_editor::render_editor_cuts,
            library::library_info,
            library::open_library_folder,
            library::delete_tracks,
            loudness::analyse_loudness,
            import::import_folder,
            import::import_picked_files,
            #[cfg(target_os = "android")]
            music_library::pick_phone_audio_files,
            #[cfg(target_os = "android")]
            import::scan_phone_music,
            #[cfg(target_os = "android")]
            import::import_phone_folder,
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
            artwork::replace_cover,
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
            analytics_transfer::export_analytics,
            analytics_transfer::import_analytics,
        ])
        .build(context)
        .expect("error while running tauri application");

    app.run(|handle, event| {
        // The media controls have to be let go of while the app is still here,
        // or the song stays in the system's own controls after it has closed.
        if let tauri::RunEvent::Exit = event {
            #[cfg(any(target_os = "android", target_os = "linux"))]
            if let Some(stream) = handle.try_state::<audio_stream::AudioStream>() {
                stream.shutdown();
            }
            #[cfg(target_os = "linux")]
            if let Some(player) = handle.try_state::<linux_playback::NativePlayback>() {
                player.shutdown();
            }
            if let Some(presence) = handle.try_state::<presence::Presence>() {
                presence.shutdown();
            }
            #[cfg(not(target_os = "android"))]
            if let Some(server) = handle.try_state::<api::Api>() {
                server.shutdown();
            }
        }
    });
}
