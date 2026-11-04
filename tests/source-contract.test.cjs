'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const core = () => read('src-tauri/src/lib.rs');
const iconHashes = {
  'empty.ico': '8c8856d7002cfef1212309024e1ac47ed97e040149171560534fb8a6fa011f00',
  '25.ico': '9cd33d42dffc4cbb7de88e123c78d77478de18e37af26106ad7fa4a0bda1aced',
  '50.ico': 'ebbb179f083e438019d31b85a285ad494c7eb6af636f9e858a8670a51aa93ace',
  '75.ico': '0fa74d89c74ae4d2c2174bd56372c10678935c3aed9ca03470adb604114f49b2',
  'full.ico': '02718e2572407bcdf90ceec31abd8a5cd1eff00ab6852b0d4b24dfb76609e29a',
};

test('Version 2.1.5 is aligned across npm, Cargo, Cargo.lock and Tauri', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(pkg.version, '2.1.5');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(conf.version, pkg.version);
  assert.match(read('src-tauri/Cargo.toml'), /^version\s*=\s*"2\.1\.5"/m);
  assert.match(read('src-tauri/Cargo.lock'), /\[\[package\]\]\r?\nname = "traybin"\r?\nversion = "2\.1\.5"/);
});
test('Tauri launches with no WebView windows at all', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.deepEqual(conf.app.windows, []);
  assert.equal(conf.app.withGlobalTauri, false);
  assert.deepEqual(JSON.parse(read('src-tauri/capabilities/default.json')).windows, []);
  assert.doesNotMatch(core(), /get_webview_window|show_panel\(|\.invoke_handler\(|\.on_window_event\(/);
  assert.match(core(), /RunEvent::ExitRequested\s*\{\s*code, api/);
  assert.match(core(), /if code\.is_none\(\) \{ api\.prevent_exit\(\); \}/);
  assert.match(core(), /api\.prevent_exit\(\)/);
});
test('Native right-click menu contains three original commands plus native autostart toggle', () => {
  const c = core();
  const items = [...c.matchAll(/MenuItem::with_id\(app, "([^"]+)", "([^"]+)"/g)].map(x=>[x[1],x[2]]);
  assert.deepEqual(items, [
    ['tray_open','Открыть корзину'],
    ['tray_empty','Очистить корзину'],
    ['tray_startup','Автозапуск'],
    ['tray_exit','Выйти'],
  ]);
  assert.match(c, /CheckMenuItem::with_id\(app, "tray_startup", "Автозапуск", true,/);
  assert.match(c, /Menu::with_items\(app, &\[&open, &empty, &startup, &quit\]\)/);
  assert.match(c, /\.menu\(&menu\)/);
  assert.match(c, /\.show_menu_on_left_click\(false\)/);
  assert.match(c, /\.on_menu_event\(/);
  assert.doesNotMatch(c, /MouseButton::Right/);
});
test('Autostart checkbox uses the existing registry helper and always resynchronizes', () => {
  const c = core();
  const w = read('src-tauri/src/windows.rs');
  assert.match(c, /windows::startup_enabled\(\), None::<&str>\)\?/);
  assert.match(c, /"tray_startup"\s*=>\s*\{/);
  assert.match(c, /let outcome = windows::toggle_startup\(\)/);
  assert.match(c, /let actual = windows::startup_enabled\(\)/);
  assert.match(c, /startup_item\.set_checked\(actual\)/);
  assert.match(c, /set_tray_error\(app, "автозапуска", &error\)/);
  assert.match(w, /pub fn startup_enabled\(\) -> bool \{ startup_state\(\)\.0 \}/);
  assert.match(w, /pub fn toggle_startup\(\) -> Result<bool, String>/);
  assert.match(w, /const RUN: &str = r"Software\\Microsoft\\Windows\\CurrentVersion\\Run"/);
  assert.match(w, /const APPROVED: &str = /);
  assert.doesNotMatch(c, /get_webview_window|show_panel\(/);
});
test('Menu actions use existing Windows Shell functionality and real app exit', () => {
  const c = core();
  assert.match(c, /"tray_open"\s*=>\s*\{\s*let _ = windows::open_recycle_bin\(\)/);
  assert.match(c, /"tray_empty"\s*=>\s*start_empty\(app\)/);
  assert.match(c, /"tray_exit"\s*=>\s*\{[^}]*shutdown\.stop\(\);[^}]*app\.exit\(0\)/);
  assert.match(read('src-tauri/src/windows.rs'), /SHEmptyRecycleBinW\(ptr::null_mut\(\), ptr::null\(\), 0\)/);
  assert.match(c, /EMPTYING\.compare_exchange\(false, true/);
  assert.match(c, /tauri::async_runtime::spawn_blocking\(windows::empty_recycle_bin\)/);
  assert.doesNotMatch(c, /MessageBox|set_focus\(\)|\.show\(\)/);
});
test('Legacy left-click and double-click gestures are retained without opening app panel', () => {
  const c = core();
  assert.match(c, /TrayIconEvent::Click\s*\{\s*button: MouseButton::Left/);
  assert.match(c, /TrayIconEvent::DoubleClick\s*\{\s*button: MouseButton::Left/);
  assert.match(c, /GetDoubleClickTime\(\)/);
  assert.match(c, /start_empty\(app\)/);
  assert.match(c, /valid && !shutdown\.is_stopped\(\)/);
});
test('Polling remains incremental and worker stops cleanly', () => {
  const c = core();
  assert.match(c, /const POLL_INTERVAL: Duration = Duration::from_secs\(5\)/);
  assert.match(c, /const FULL_REFRESH_INTERVAL: Duration = Duration::from_secs\(60\)/);
  assert.match(c, /if changed \|\| expired \{ refresh_full\(app\); \}/);
  assert.match(c, /wait_timeout_while\(stopped, duration/);
  assert.match(c, /while !stop\.wait_for_stop\(POLL_INTERVAL\)/);
  assert.match(c, /tauri_plugin_single_instance::init\(\|_app, _, _\| \{\}\)/);
});
test('Lean Runtime caches scalars, not complete per-drive snapshots', () => {
  const c = core();
  assert.match(c, /struct Counters\s*\{\s*available: bool,\s*items: u64,\s*size: u64/);
  assert.match(c, /counters: Mutex<Option<Counters>>/);
  assert.match(c, /Counters::from\(&snapshot\)/);
  assert.match(c, /cache\.counters\.lock\(\)\.ok\(\)\.and_then\(\|x\| \*x\)/);
  assert.doesNotMatch(c, /Mutex<Option<windows::Snapshot>>|snapshot\.clone\(\)/);
});
test('Windows drive fix is preserved exactly (only fixed media in per-volume list)', () => {
  const w = read('src-tauri/src/windows.rs');
  assert.match(w, /if kind == 3 \{/);
  assert.doesNotMatch(w, /if kind == 2 \|\| kind == 3 \{/);
  assert.match(w, /quick_status\(\)/);
});
test('All five classic tray icon bytes remain unchanged', () => {
  for (const [name, sha] of Object.entries(iconHashes)) {
    const file = fs.readFileSync(path.join(root, 'src-tauri/icons', name));
    assert.equal(crypto.createHash('sha256').update(file).digest('hex'), sha, name);
  }
});
test('Historical UI assets remain available for rollback, but are not instantiated', () => {
  assert.ok(read('ui/app.js').includes("'empty_bin'"));
  assert.ok(read('ui/index.html').includes('details-panel'));
  assert.ok(read('src-tauri/tauri.conf.json').includes('"windows": []'));
});
test('Only project tests are selected; no dependency reinstall in build script', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:ui'], 'node --test tests/panel.test.cjs tests/source-contract.test.cjs');
  assert.doesNotMatch(read('BUILD-RELEASE.ps1'), /npm (?:ci|install)/);
  assert.match(read('BUILD-RELEASE.ps1'), /npm run build:release/);
});
test('Versioned source archive recipe is retained and hashes sources', () => {
  const make = read('CREATE-SOURCE-ARCHIVE.ps1');
  assert.match(make, /TrayBin_v2\.1\.5_Autostart_Menu_Source\.zip/);
  assert.match(make, /FILE_MANIFEST_SHA256\.txt/);
  assert.match(make, /SOURCE_ARCHIVE_SHA256\.txt/);
  assert.match(make, /scripts\\VERIFY-NPM-LOCK\.cjs/);
});
test('Standalone npm lock validator accepts exact version and rejects mutation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traybin-lock-'));
  const file = path.join(tmp, 'package-lock.json');
  const verifier = path.join(root, 'scripts', 'VERIFY-NPM-LOCK.cjs');
  const run = () => spawnSync(process.execPath, [verifier, file, '2.1.5', 'traybin-tauri'], {encoding: 'utf8'});
  try {
    const obj = {name:'traybin-tauri',version:'2.1.5',lockfileVersion:3,packages:{'':{name:'traybin-tauri',version:'2.1.5'}}};
    fs.writeFileSync(file, JSON.stringify(obj));
    assert.equal(run().status, 0);
    obj.packages[''].version = '2.1.2';
    fs.writeFileSync(file, JSON.stringify(obj));
    assert.notEqual(run().status, 0);
  } finally { fs.rmSync(tmp, {recursive:true,force:true}); }
});
test('Offline release checks and source packager target 2.1.5 only', () => {
  const verify = read('VERIFY-RELEASE.ps1');
  const pack = read('CREATE-SOURCE-ARCHIVE.ps1');
  assert.ok(verify.includes('2\.1\.5'));
  assert.ok(pack.includes('2\.1\.5'));
  assert.doesNotMatch(verify, /2\\\.1\\\.2/);
  assert.doesNotMatch(pack, /2\\\.1\\\.2/);
  assert.match(verify, /'--offline', '--locked'/);
  assert.match(verify, /"windows"\\s\*:\\s\*\\\[\\s\*\\\]/);
});

test('Clean source restoration includes first-build setup and correct Cargo version in packager', () => {
  const setup = read('FIRST-BUILD.ps1');
  assert.match(setup, /npm\.cmd ci/);
  assert.match(setup, /cargo fetch --locked --target x86_64-pc-windows-msvc/);
  assert.match(setup, /BUILD-RELEASE\.ps1/);
  const pack = read('CREATE-SOURCE-ARCHIVE.ps1');
  assert.match(pack, /2\\\.1\\\.5/); // literal regex-version in PowerShell
  assert.doesNotMatch(pack, /2\\\.1\\\.3/);
});
