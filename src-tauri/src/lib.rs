//! TrayBin v2.1.4 Lean Runtime Preview — Windows-native context menu, no WebView windows.
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
        AppHandle, Manager, RunEvent,
        image::Image,
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    const POLL_INTERVAL: Duration = Duration::from_secs(5);
    const FULL_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
    static EMPTYING: AtomicBool = AtomicBool::new(false);
    const ICONS: [&[u8]; 5] = [
        include_bytes!("../icons/empty.ico"), include_bytes!("../icons/25.ico"),
        include_bytes!("../icons/50.ico"), include_bytes!("../icons/75.ico"),
        include_bytes!("../icons/full.ico"),
    ];

    #[derive(Default)]
    struct Router { sequence: u64, last_double: Option<Instant> }

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

    // The poller compares only these three scalars. Keeping the full Snapshot
    // would clone the per-volume Vec<String> every five seconds for no benefit.
    #[derive(Clone, Copy)]
    struct Counters {
        available: bool,
        items: u64,
        size: u64,
    }
    impl From<&windows::Snapshot> for Counters {
        fn from(snapshot: &windows::Snapshot) -> Self {
            Self { available: snapshot.available, items: snapshot.items, size: snapshot.size }
        }
    }

    #[derive(Default)]
    struct Cache {
        counters: Mutex<Option<Counters>>,
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
    fn size_text(size: u64) -> String {
        let mut bytes = size as f64;
        let mut unit = 0;
        while bytes >= 1024.0 && unit < 4 { bytes /= 1024.0; unit += 1; }
        format!("{:.1} {}", bytes, ["Б", "КБ", "МБ", "ГБ", "ТБ"][unit])
    }
    fn tooltip(s: &windows::Snapshot) -> String {
        if s.empty_busy { return "TrayBin · Очистка корзины…".into(); }
        if !s.available { return "TrayBin · Не удалось прочитать корзину".into(); }
        format!("TrayBin · {} объектов · {}", s.items, size_text(s.size))
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

    fn set_tray_error(app: &AppHandle, error: &str) {
        // No extra application windows: failures are visible through the tray tooltip.
        let message = format!("TrayBin · Ошибка очистки: {}", error);
        if let Some(tray) = app.tray_by_id("main") {
            if tray.set_tooltip(Some(message.as_str())).is_ok() {
                if let Ok(mut last) = app.state::<Cache>().tooltip.lock() { *last = Some(message); }
            }
        }
    }

    fn refresh_full(app: &AppHandle) {
        let cache = app.state::<Cache>();
        let _scan = cache.refresh_guard.lock().unwrap_or_else(|e| e.into_inner());
        let snapshot = windows::snapshot(EMPTYING.load(Ordering::Acquire));
        if let Ok(mut last) = cache.counters.lock() { *last = Some(Counters::from(&snapshot)); }
        if let Ok(mut last) = cache.last_full.lock() { *last = Some(Instant::now()); }
        update_tray(app, &snapshot);
    }

    fn poll(app: &AppHandle) {
        let cache = app.state::<Cache>();
        if cache.shutdown.is_stopped() || EMPTYING.load(Ordering::Acquire) { return; }
        let expired = cache.last_full.lock().map(|guard| match *guard {
            Some(previous) => previous.elapsed() >= FULL_REFRESH_INTERVAL,
            None => true,
        }).unwrap_or(true);
        let cached = cache.counters.lock().ok().and_then(|x| *x);
        let changed = match (windows::quick_status(), cached) {
            (Ok((items, size)), Some(old)) => !old.available || old.items != items || old.size != size,
            (Err(_), Some(old)) => old.available,
            _ => true,
        };
        if changed || expired { refresh_full(app); }
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
    fn start_empty(app: &AppHandle) {
        if EMPTYING.load(Ordering::Acquire) { return; }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = perform_empty(app.clone()).await {
                if error != "Очистка отменена пользователем" && error != "Очистка уже выполняется" {
                    set_tray_error(&app, &error);
                }
            }
        });
    }

    fn handle_left_click(app: &AppHandle, event: TrayIconEvent, router: &Arc<Mutex<Router>>) {
        match event {
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                if EMPTYING.load(Ordering::Acquire) { return; }
                let sequence = {
                    let Ok(mut state) = router.lock() else { return; };
                    if state.last_double.is_some_and(|t| t.elapsed() < Duration::from_millis(650)) { return; }
                    state.sequence += 1;
                    state.sequence
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
                start_empty(app);
            },
            _ => {} // Right click belongs exclusively to the native context menu.
        }
    }

    pub fn run() {
        let router = Arc::new(Mutex::new(Router::default()));
        let callback_router = Arc::clone(&router);
        let cache = Cache::default();
        let shutdown = Arc::clone(&cache.shutdown);
        tauri::Builder::default()
            // A second launch does not create or reveal any window.
            .plugin(tauri_plugin_single_instance::init(|_app, _, _| {}))
            .manage(cache)
            .setup(move |app| {
                let open = MenuItem::with_id(app, "tray_open", "Открыть корзину", true, None::<&str>)?;
                let empty = MenuItem::with_id(app, "tray_empty", "Очистить корзину", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "tray_exit", "Выйти", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &empty, &quit])?;
                let icon = Image::from_bytes(ICONS[0])?;
                TrayIconBuilder::with_id("main")
                    .icon(icon)
                    .tooltip("TrayBin · Загрузка…")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "tray_open" => { let _ = windows::open_recycle_bin(); },
                        "tray_empty" => start_empty(app),
                        "tray_exit" => {
                            app.state::<Cache>().shutdown.stop();
                            app.exit(0);
                        },
                        _ => {},
                    })
                    .on_tray_icon_event(move |tray, event| {
                        handle_left_click(tray.app_handle(), event, &callback_router)
                    })
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
            .build(tauri::generate_context!())
            .expect("TrayBin failed to initialize")
            .run(|app_handle, event| match event {
                RunEvent::ExitRequested { code, api, .. } => {
                    // Keep zero-window tray mode alive, but honor explicit "Выйти".
                    if code.is_none() { api.prevent_exit(); }
                },
                RunEvent::Exit => app_handle.state::<Cache>().shutdown.stop(),
                _ => {},
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
        fn counters_keep_only_polling_fields() {
            let snapshot = mock_snapshot(123, 4_096, 10_000, true);
            let counters = Counters::from(&snapshot);
            assert!(counters.available);
            assert_eq!(counters.items, 123);
            assert_eq!(counters.size, 4_096);
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
            if windows::two_states() { return; }
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
