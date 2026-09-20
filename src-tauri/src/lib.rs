use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};
use tauri_plugin_autostart::ManagerExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "create_notes_table",
        sql: "CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT,
            color_bg TEXT,
            color_accent TEXT,
            pinned INTEGER DEFAULT 0,
            created_at TEXT
        );",
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch attempt (e.g. manual double-click while the
            // autostart-launched instance is already running) ends up here
            // instead of spawning a second process. Just bring the existing
            // window into view instead of doing nothing silently.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:notes.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            #[cfg(desktop)]
            {
                #[cfg(not(debug_assertions))]
                {
                    let autostart_manager = app.autolaunch();
                    let _ = autostart_manager.disable();
                    let _ = autostart_manager.enable();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running bezel notes application");
}