mod artwork;
mod import;
mod library;
mod lyrics;
mod playlists;
mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(state::Store::load(app.handle()));
            // Filled in by every scan; playlist files store paths, not ids.
            app.manage(library::TrackPaths::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state::get_state,
            state::set_settings,
            state::toggle_like,
            library::scan_library,
            import::import_folder,
            playlists::create_playlist,
            playlists::rename_playlist,
            playlists::delete_playlist,
            playlists::add_to_playlist,
            playlists::remove_from_playlist,
            playlists::reorder_playlist,
            artwork::artwork_color,
            artwork::artwork_bytes,
            artwork::cover_bytes,
            lyrics::load_lyrics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
