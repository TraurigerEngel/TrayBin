'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const hashes = {
  'empty.ico': '8c8856d7002cfef1212309024e1ac47ed97e040149171560534fb8a6fa011f00',
  '25.ico': '9cd33d42dffc4cbb7de88e123c78d77478de18e37af26106ad7fa4a0bda1aced',
  '50.ico': 'ebbb179f083e438019d31b85a285ad494c7eb6af636f9e858a8670a51aa93ace',
  '75.ico': '0fa74d89c74ae4d2c2174bd56372c10678935c3aed9ca03470adb604114f49b2',
  'full.ico': '02718e2572407bcdf90ceec31abd8a5cd1eff00ab6852b0d4b24dfb76609e29a',
};

test('Stable version is aligned across Tauri, Rust, and npm', () => {
  const npm = JSON.parse(read('package.json'));
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  const cargo = read('src-tauri/Cargo.toml');
  assert.equal(npm.version, '2.0.0');
  assert.equal(tauri.version, npm.version);
  assert.match(cargo, /^version\s*=\s*"2\.0\.0"/m);
  assert.equal(tauri.app.windows[0].width, 376);
  assert.equal(tauri.app.windows[0].height, 528);
});
test('Classic tray icon files remain unchanged from the confirmed Preview 1', () => {
  for (const [name, expected] of Object.entries(hashes)) {
    const bytes = fs.readFileSync(path.join(root, 'src-tauri/icons', name));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected, name);
  }
});
test('Every referenced DOM id exists and native actions remain bound', () => {
  const html = read('ui/index.html');
  const js = read('ui/app.js');
  const ids = [...js.matchAll(/\$\('([a-z-]+)'\)/g)].map(match => match[1]);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `Missing #${id}`);
  for (const name of ['open_bin', 'empty_bin', 'set_startup', 'hide_panel', 'exit_app']) {
    assert.ok(js.includes(`'${name}'`), `Missing Tauri action: ${name}`);
  }
});
test('Native Shell deletion still displays Windows confirmation', () => {
  const rust = read('src-tauri/src/windows.rs');
  assert.match(rust, /SHEmptyRecycleBinW\(ptr::null_mut\(\), ptr::null\(\), 0\)/);
  assert.match(rust, /quick_status\(\)/);
  const core = read('src-tauri/src/lib.rs');
  assert.match(core, /const POLL_INTERVAL: Duration = Duration::from_secs\(5\)/);
  assert.match(core, /const FULL_REFRESH_INTERVAL: Duration = Duration::from_secs\(60\)/);
  assert.match(core, /if changed \|\| expired \{ refresh_full\(app\); \}/);
});

test('Preview 3 worker waits efficiently, wakes on exit, and cancels delayed clicks', () => {
  const core = read('src-tauri/src/lib.rs');
  assert.match(core, /wait_timeout_while\(stopped, duration/);
  assert.match(core, /while !stop\.wait_for_stop\(POLL_INTERVAL\)/);
  assert.doesNotMatch(core, /thread::sleep\(Duration::from_millis\(250\)\)/);
  assert.match(core, /shutdown\.stop\(\)/);
  assert.match(core, /valid && !shutdown\.is_stopped\(\)/);
  assert.match(core, /EMPTYING\.load\(Ordering::Acquire\)/);
});
test('Preview 3 second launch reveals existing panel instead of starting another', () => {
  const core = read('src-tauri/src/lib.rs');
  assert.match(core, /tauri_plugin_single_instance::init\(\|app, _, _\|/);
  assert.match(core, /if let Some\(panel\) = app\.get_webview_window\("panel"\)/);
  assert.match(core, /let _ = panel\.show\(\)/);
});

// Prevent patch payloads/backups from being included in the Node.js test run.
test('Preview 3 test commands select only project tests', () => {
  const pkg = JSON.parse(read('package.json'));
  const verify = read('VERIFY-RELEASE.ps1');
  assert.equal(pkg.scripts['test:ui'], 'node --test tests/panel.test.cjs tests/source-contract.test.cjs');
  assert.equal(pkg.scripts['verify:static'], 'node --check ui/app.js && npm run test:ui');
  assert.ok(verify.includes("Invoke-Checked 'node' @('--test', '.\\tests\\panel.test.cjs', '.\\tests\\source-contract.test.cjs')"));
  assert.doesNotMatch(verify, /Invoke-Checked 'node' @\('--test'\)/);
});

// Stable must not silently re-enable borders, modify tray behaviour, or ship a console window.
test('Stable keeps the approved visual and runtime policies', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const window = config.app.windows[0];
  assert.equal(window.decorations, false);
  assert.equal(window.shadow, false);
  assert.equal(window.width, 376);
  assert.equal(window.height, 528);
  const css = read('ui/style.css');
  assert.match(css, /font-family:\s*"Inter"/);
  assert.match(css, /\.bar-right \.status-dot \{ display: none; \}/);
  const main = read('src-tauri/src/main.rs');
  assert.match(main, /windows_subsystem = "windows"/);
});

test('Stable portable packaging is explicit, checksums included', () => {
  const script = read('BUILD-RELEASE.ps1');
  assert.match(script, /VERIFY-RELEASE\.ps1/);
  assert.match(script, /npm run build:release/);
  assert.match(script, /target\\release\\traybin\.exe/);
  assert.match(script, /Get-FileHash/);
  assert.match(script, /Compress-Archive/);
  assert.doesNotMatch(script, /npm run build:dev/);
  const verify = read('VERIFY-RELEASE.ps1');
  assert.match(verify, /FILE_MANIFEST_SHA256\.txt/);
  assert.match(verify, /cargo/);
});

// The Stable archive must not overwrite the already accepted Release Candidate.
test('Stable portable outputs are distinct from RC1 and use the verified Release build', () => {
  const build = read('BUILD-RELEASE.ps1');
  assert.ok(build.includes('Artifacts\\TrayBin_v2.0.0_Stable'));
  assert.ok(build.includes('TrayBin_v2.0.0_Stable_Portable.zip'));
  assert.doesNotMatch(build, /TrayBin_v2\.0\.0_RC1_Portable\.zip/);
  assert.ok(build.includes('VERIFY-RELEASE.ps1'));
  assert.ok(build.includes('src-tauri\\target\\release\\traybin.exe'));
  assert.doesNotMatch(build, /build:dev/);
  assert.ok(build.includes('RELEASE_ARTIFACTS_SHA256.txt'));
});

// Release source must be reproducible without the original working directory or patch history.
test('Stable source packager includes dependency locks and only approved sources', () => {
  const pack = read('CREATE-SOURCE-ARCHIVE.ps1');
  assert.match(pack, /FILE_MANIFEST_SHA256\.txt/);
  assert.match(pack, /package-lock\.json/);
  assert.match(pack, /src-tauri\\Cargo\.lock/);
  assert.match(pack, /SOURCE_ARCHIVE_SHA256\.txt/);
  assert.match(pack, /CreateFromDirectory/);
  assert.match(pack, /Expand-Archive/);
  assert.match(pack, /Unexpected archive file count/);
  assert.doesNotMatch(pack, /Copy-Item\s+[^\n]*-Recurse/);
});
test('Stable release script creates and hashes portable and source ZIPs', () => {
  const build = read('BUILD-RELEASE.ps1');
  assert.match(build, /CREATE-SOURCE-ARCHIVE\.ps1/);
  assert.match(build, /sourceHash/);
  assert.match(build, /TrayBin_v2\.0\.0_Stable_Source\.zip/);
  assert.match(build, /RELEASE_ARTIFACTS_SHA256\.txt/);
  assert.match(build, /Portable\/TrayBin\.exe/);
});
test('Stable source packaging supports clean rebuild and keeps code unchanged', () => {
  const doc = read('README_RU.md');
  assert.match(doc, /TrayBin_v2\.0\.0_Stable_Source\.zip/);
  assert.match(doc, /npm ci/);
  const verify = read('VERIFY-RELEASE.ps1');
  assert.match(verify, /22 regression tests/);
  assert.equal(JSON.parse(read('package.json')).version, '2.0.0');
});

// Windows PowerShell 5.1 mangles nested quotes passed via `node -e`.
test('Source packager runs npm lock validation via standalone JS rather than node -e', () => {
  const pack = read('CREATE-SOURCE-ARCHIVE.ps1');
  assert.match(pack, /scripts\\VERIFY-NPM-LOCK\.cjs/);
  assert.match(pack, /& node \$lockValidator \$pkgLockFile \$pkg\.version \$pkg\.name/);
  assert.doesNotMatch(pack, /& node -e /);
  assert.match(read('FILE_MANIFEST_SHA256.txt'), /  scripts\/VERIFY-NPM-LOCK\.cjs/);
});

test('Npm lockfile verifier accepts valid locks and rejects altered version or malformed JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traybin-lock-'));
  const verifier = path.join(root, 'scripts', 'VERIFY-NPM-LOCK.cjs');
  const file = path.join(tmp, 'package-lock.json');
  const run = () => spawnSync(process.execPath, [verifier, file, '2.0.0', 'traybin-tauri'], {encoding:'utf8'});
  try {
    const correct = {name:'traybin-tauri',version:'2.0.0',lockfileVersion:3,packages:{'':{name:'traybin-tauri',version:'2.0.0'}}};
    fs.writeFileSync(file, JSON.stringify(correct));
    assert.equal(run().status, 0, 'Expected valid lock accepted');
    correct.packages[''].version = '2.0.0-rc.1';
    fs.writeFileSync(file, JSON.stringify(correct));
    assert.equal(run().status, 2, 'Expected incorrect root version rejected');
    fs.writeFileSync(file, '{not-json');
    assert.equal(run().status, 2, 'Expected malformed JSON rejected');
  } finally {
    fs.rmSync(tmp, {recursive:true,force:true});
  }
});
