//! TrayBin v2 Preview — Windows-only system tray application.
#![cfg_attr(not(windows), allow(unused))]
#[cfg(not(windows))]
compile_error!("TrayBin uses Windows Shell APIs and must be built on Windows.");

#[cfg(windows)]
mod windows;

#[cfg(windows)]
mod app {
    use super::windows;
    use std::{
        sync::{Arc, Condvar, Mutex, atomic::{AtomicBool, Ordering}},
        thread,
        time::{Duration, Instant},
    };
    use tauri::{
        AppHandle, Emitter, Manager, PhysicalPosition, Position, RunEvent, WindowEvent,
        image::Image,
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    static EMPTYING: AtomicBool = AtomicBool::new(false);
    const POLL_INTERVAL: Duration = Duration::from_secs(5);
    const FULL_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
    const ICONS: [&[u8]; 5] = [
        include_bytes!("../icons/empty.ico"), include_bytes!("../icons/25.ico"),
        include_bytes!("../icons/50.ico"), include_bytes!("../icons/75.ico"),
        include_bytes!("../icons/full.ico"),
    ];

    #[derive(Default)]
    struct Router { sequence: u64, last_double: Option<Instant> }

    // A blocking wait avoids waking the polling thread four times per second.
    // The condition variable also lets shutdown interrupt the full 5s interval.
    #[derive(Default)]
    struct StopSignal {
        stopped: Mutex<bool>,
        changed: Condvar,
    }
    impl StopSignal {
        fn stop(&self) {
            let mut stopped = self.stopped.lock().unwrap_or_else(|e| e.into_inner());
            *stopped = true;
            self.changed.notify_all();
        }
        fn is_stopped(&self) -> bool {
            *self.stopped.lock().unwrap_or_else(|e| e.into_inner())
        }
        fn wait_for_stop(&self, duration: Duration) -> bool {
            let stopped = self.stopped.lock().unwrap_or_else(|e| e.into_inner());
            let (stopped, _) = self.changed
                .wait_timeout_while(stopped, duration, |flag| !*flag)
                .unwrap_or_else(|e| e.into_inner());
            *stopped
        }
    }

    #[derive(Default)]
    struct Cache {
        snapshot: Mutex<Option<windows::Snapshot>>,
        last_full: Mutex<Option<Instant>>,
        icon_index: Mutex<Option<usize>>,
        tooltip: Mutex<Option<String>>,
        refresh_guard: Mutex<()>,
        shutdown: Arc<StopSignal>,
    }

    fn choose_icon(snapshot: &windows::Snapshot) -> usize {
        if !snapshot.available || snapshot.items == 0 { return 0; }
        if windows::two_states() || !snapshot.capacity_complete || snapshot.capacity == 0 { return 4; }
        let ratio = snapshot.size as f64 / snapshot.capacity as f64;
        if ratio <= 0.25 { 1 } else if ratio <= 0.50 { 2 } else if ratio <= 0.75 { 3 } else { 4 }
    }
    fn tooltip(s: &windows::Snapshot) -> String {
        if s.empty_busy { return "TrayBin · Очистка корзины…".into(); }
        if !s.available { return "TrayBin · Не удалось прочитать корзину".into(); }
        format!("TrayBin · {} объектов · {}", s.items, size_text(s.size))
    }
    fn size_text(size: u64) -> String {
        let mut bytes = size as f64;
        let mut unit = 0;
        while bytes >= 1024.0 && unit < 4 { bytes /= 1024.0; unit += 1; }
        format!("{:.1} {}", bytes, ["Б", "КБ", "МБ", "ГБ", "ТБ"][unit])
    }

    fn update_tray(app: &AppHandle, snapshot: &windows::Snapshot) {
        let Some(tray) = app.tray_by_id("main") else { return; };
        let cache = app.state::<Cache>();
        let index = choose_icon(snapshot);
        if let Ok(mut last) = cache.icon_index.lock() {
            if *last != Some(index) {
                if let Ok(icon) = Image::from_bytes(ICONS[index]) {
                    if tray.set_icon(Some(icon)).is_ok() { *last = Some(index); }
                }
            }
        }
        let next_tip = tooltip(snapshot);
        if let Ok(mut last) = cache.tooltip.lock() {
            if last.as_ref() != Some(&next_tip) {
                if tray.set_tooltip(Some(next_tip.as_str())).is_ok() { *last = Some(next_tip); }
            }
        };
    }

    /// Complete scan: Shell information, local volumes, storage policy and startup state.
    /// The guard prevents two commands / the background worker from scanning concurrently.
    fn refresh_full(app: &AppHandle) -> windows::Snapshot {
        let cache = app.state::<Cache>();
        let _scan = cache.refresh_guard.lock().unwrap_or_else(|e| e.into_inner());
        let snapshot = windows::snapshot(EMPTYING.load(Ordering::Acquire));
        if let Ok(mut last) = cache.snapshot.lock() { *last = Some(snapshot.clone()); }
        if let Ok(mut last) = cache.last_full.lock() { *last = Some(Instant::now()); }
        update_tray(app, &snapshot);
        let _ = app.emit("traybin://snapshot", snapshot.clone());
        snapshot
    }

    /// Normal polling performs one lightweight global Shell query. A full scan is
    /// triggered only after a change, a query failure or once per minute.
    fn poll(app: &AppHandle) {
        let cache = app.state::<Cache>();
        if cache.shutdown.is_stopped() || EMPTYING.load(Ordering::Acquire) { return; }
        let expired = cache.last_full.lock().map(|guard| match *guard {
            Some(previous) => previous.elapsed() >= FULL_REFRESH_INTERVAL,
            None => true,
        }).unwrap_or(true);
        let cached = cache.snapshot.lock().ok().and_then(|x| x.clone());
        let changed = match (windows::quick_status(), cached) {
            (Ok((items, size)), Some(old)) => !old.available || old.items != items || old.size != size,
            (Err(_), Some(old)) => old.available,
            _ => true,
        };
        if changed || expired { refresh_full(app); }
    }

    fn publish_cached(app: &AppHandle) {
        let snapshot = app.state::<Cache>().snapshot.lock().ok().and_then(|x| x.clone());
        if let Some(s) = snapshot { let _ = app.emit("traybin://snapshot", s); }
    }

    fn show_panel(app: &AppHandle, px: i32, py: i32) {
        let Some(window) = app.get_webview_window("panel") else { return; };
        let Ok(size) = window.outer_size() else { return; };
        let width = size.width as i32;
        let height = size.height as i32;
        let mut x = px - width + 24;
        let mut y = py - height - 12;
        if let Ok(monitors) = window.available_monitors() {
            if let Some(monitor) = monitors.iter().find(|m| {
                let origin = m.position(); let extent = m.size();
                px >= origin.x && px < origin.x + extent.width as i32 &&
                py >= origin.y && py < origin.y + extent.height as i32
            }) {
                let origin = monitor.position(); let extent = monitor.size();
                let right = origin.x + extent.width as i32;
                let bottom = origin.y + extent.height as i32;
                if y < origin.y { y = py + 16; }
                x = x.clamp(origin.x, (right - width).max(origin.x));
                y = y.clamp(origin.y, (bottom - height).max(origin.y));
            }
        }
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        let _ = window.show();
        let _ = window.set_focus();
        // Never enumerate drives on the UI/event thread when opening the menu.
        publish_cached(app);
    }

    struct EmptyGuard;
    impl Drop for EmptyGuard {
        fn drop(&mut self) { EMPTYING.store(false, Ordering::Release); }
    }
    async fn perform_empty(app: AppHandle) -> Result<(), String> {
        if EMPTYING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return Err("Очистка уже выполняется".into());
        }
        let busy_guard = EmptyGuard;
        refresh_full(&app);
        let result = tauri::async_runtime::spawn_blocking(windows::empty_recycle_bin)
            .await.map_err(|e| e.to_string());
        drop(busy_guard);
        refresh_full(&app);
        result?
    }

    #[tauri::command]
    fn get_snapshot(app: AppHandle) -> windows::Snapshot {
        let saved = app.state::<Cache>().snapshot.lock().ok().and_then(|x| x.clone());
        saved.unwrap_or_else(|| refresh_full(&app))
    }

    #[tauri::command]
    fn open_bin() -> Result<(), String> { windows::open_recycle_bin() }

    #[tauri::command]
    fn set_startup(app: AppHandle) -> Result<bool, String> {
        let result = windows::toggle_startup()?;
        refresh_full(&app);
        Ok(result)
    }

    #[tauri::command]
    async fn empty_bin(app: AppHandle) -> Result<(), String> { perform_empty(app).await }

    #[tauri::command]
    fn hide_panel(app: AppHandle) {
        if let Some(window) = app.get_webview_window("panel") { let _ = window.hide(); }
    }

    #[tauri::command]
    fn show_panel_error(app: AppHandle) {
        // The panel was hidden to let the native Windows confirmation take focus.
        // Restore it only on unexpected failures so that the error toast is visible.
        if let Some(window) = app.get_webview_window("panel") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    #[tauri::command]
    fn exit_app(app: AppHandle) {
        app.state::<Cache>().shutdown.stop();
        app.exit(0);
    }

    fn handle_tray(app: &AppHandle, event: TrayIconEvent, router: &Arc<Mutex<Router>>) {
        match event {
            TrayIconEvent::Click { button: MouseButton::Right, button_state: MouseButtonState::Up, position, .. } => {
                if let Ok(mut state) = router.lock() { state.sequence += 1; }
                show_panel(app, position.x.round() as i32, position.y.round() as i32);
            },
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                if EMPTYING.load(Ordering::Acquire) { return; }
                let sequence = {
                    let Ok(mut s) = router.lock() else { return; };
                    if s.last_double.is_some_and(|t| t.elapsed() < Duration::from_millis(650)) { return; }
                    s.sequence += 1;
                    s.sequence
                };
                let routing = Arc::clone(router);
                let shutdown = Arc::clone(&app.state::<Cache>().shutdown);
                let wait = unsafe { windows::GetDoubleClickTime() }.clamp(200, 900);
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(wait as u64 + 30));
                    let valid = routing.lock().map(|s| s.sequence == sequence &&
                        !s.last_double.is_some_and(|t| t.elapsed() < Duration::from_millis(650))).unwrap_or(false);
                    if valid && !shutdown.is_stopped() && !EMPTYING.load(Ordering::Acquire) {
                        let _ = windows::open_recycle_bin();
                    }
                });
            },
            TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                let Ok(mut state) = router.lock() else { return; };
                state.sequence += 1;
                state.last_double = Some(Instant::now());
                drop(state);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = perform_empty(app.clone()).await {
                        if error != "Очистка отменена пользователем" {
                            if let Some(window) = app.get_webview_window("panel") {
                                let _ = window.show(); let _ = window.set_focus();
                            }
                            let _ = app.emit("traybin://error", error);
                        }
                    }
                });
            },
            _ => {}
        }
    }

    pub fn run() {
        let router = Arc::new(Mutex::new(Router::default()));
        let callback_router = Arc::clone(&router);
        let cache = Cache::default();
        let shutdown = Arc::clone(&cache.shutdown);
        tauri::Builder::default()
            // A second launch reuses the running instance and reveals its panel.
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(panel) = app.get_webview_window("panel") {
                    let _ = panel.show();
                    let _ = panel.set_focus();
                }
            }))
            .manage(cache)
            .invoke_handler(tauri::generate_handler![get_snapshot, open_bin, set_startup, empty_bin, hide_panel, show_panel_error, exit_app])
            .setup(move |app| {
                let icon = Image::from_bytes(ICONS[0])?;
                TrayIconBuilder::with_id("main")
                    .icon(icon)
                    .tooltip("TrayBin · Загрузка…")
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(move |tray, event| handle_tray(tray.app_handle(), event, &callback_router))
                    .build(app)?;
                let app_handle = app.handle().clone();
                refresh_full(&app_handle);
                let stop = Arc::clone(&shutdown);
                thread::Builder::new().name("traybin-poll".into()).spawn(move || {
                    while !stop.wait_for_stop(POLL_INTERVAL) {
                        poll(&app_handle);
                    }
                })?;
                Ok(())
            })
            .on_window_event(|window, event| {
                if window.label() == "panel" {
                    match event {
                        WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close(); let _ = window.hide();
                        }
                        WindowEvent::Focused(false) => { let _ = window.hide(); }
                        _ => {}
                    }
                }
            })
            .build(tauri::generate_context!())
            .expect("TrayBin failed to initialize")
            .run(|app_handle, event| {
                if matches!(event, RunEvent::Exit) {
                    app_handle.state::<Cache>().shutdown.stop();
                }
            });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn mock_snapshot(items: u64, size: u64, capacity: u64, complete: bool) -> windows::Snapshot {
            windows::Snapshot {
                available: true, items, size, capacity, capacity_complete: complete,
                volumes: vec![], startup: false, startup_status: String::new(),
                empty_busy: false, checked_at: 0, error: None,
            }
        }
        #[test]
        fn shutdown_signal_wakes_waiting_worker() {
            let signal = Arc::new(StopSignal::default());
            let worker = Arc::clone(&signal);
            let join = thread::spawn(move || worker.wait_for_stop(Duration::from_secs(30)));
            signal.stop();
            assert!(join.join().expect("worker thread panicked"));
            assert!(signal.is_stopped());
        }
        #[test]
        fn original_classic_icon_thresholds() {
            if windows::two_states() { return; } // Legacy INI may explicitly request two icons.
            assert_eq!(choose_icon(&mock_snapshot(0, 0, 100, true)), 0);
            assert_eq!(choose_icon(&mock_snapshot(1, 25, 100, true)), 1);
            assert_eq!(choose_icon(&mock_snapshot(1, 26, 100, true)), 2);
            assert_eq!(choose_icon(&mock_snapshot(1, 50, 100, true)), 2);
            assert_eq!(choose_icon(&mock_snapshot(1, 51, 100, true)), 3);
            assert_eq!(choose_icon(&mock_snapshot(1, 76, 100, true)), 4);
            assert_eq!(choose_icon(&mock_snapshot(1, 30, 0, false)), 4);
        }
    }
}

#[cfg(windows)]
pub use app::run;
