pub mod commands;
pub mod errors;
pub mod filesystem;
pub mod jobs;
pub mod media;
pub mod process;
pub mod providers;
pub mod settings;
pub mod validation;

use jobs::JobRegistry;
use settings::SettingsStore;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(JobRegistry::default())
        .manage(media::playback::PlaybackRegistry::default())
        .manage(SettingsStore::load())
        .setup(|app| {
            // PRD §7: prune anything a crashed run left behind.
            std::thread::spawn(filesystem::prune_stale_temp_dirs);
            let _ = app;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                commands::shutdown(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::analyze_url,
            commands::analyze_file,
            commands::validate_clip,
            commands::aspect_preview,
            commands::preview_source,
            commands::create_playback,
            commands::prepare_playback,
            commands::release_playback,
            commands::release_url_media,
            commands::start_export,
            commands::save_prompt,
            commands::cancel_job,
            commands::default_output_dir,
            commands::set_output_dir,
            commands::reveal_in_finder,
            commands::prune_temp,
            commands::health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SHIFT");
}
