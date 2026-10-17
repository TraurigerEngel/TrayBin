//! Windows Shell backend. No PowerShell, shell scripts, elevated privileges or network access.
use serde::Serialize;
use std::{env, ffi::c_void, ptr, process::Command, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const BUCKET: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket";
const POLICY: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer";
const VALUE: &str = "TrayBin";

#[repr(C)]
#[derive(Default)]
struct RecycleInfo { cb_size: u32, size: i64, items: i64 }

#[link(name = "shell32")]
unsafe extern "system" {
    fn SHQueryRecycleBinW(root: *const u16, info: *mut RecycleInfo) -> i32;
    fn SHEmptyRecycleBinW(hwnd: *mut c_void, root: *const u16, flags: u32) -> i32;
}
#[link(name = "ole32")]
unsafe extern "system" {
    fn OleInitialize(reserved: *mut c_void) -> i32;
    fn OleUninitialize();
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn FindFirstVolumeW(name: *mut u16, len: u32) -> *mut c_void;
    fn FindNextVolumeW(handle: *mut c_void, name: *mut u16, len: u32) -> i32;
    fn FindVolumeClose(handle: *mut c_void) -> i32;
    fn GetVolumePathNamesForVolumeNameW(name: *const u16, paths: *mut u16, len: u32, required: *mut u32) -> i32;
    fn GetDriveTypeW(root: *const u16) -> u32;
    fn GetDiskFreeSpaceExW(root: *const u16, available: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    fn GetLastError() -> u32;
}
#[link(name = "user32")]
unsafe extern "system" { pub fn GetDoubleClickTime() -> u32; }

fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
fn unwiden(b: &[u16]) -> String { String::from_utf16_lossy(&b[..b.iter().position(|x| *x == 0).unwrap_or(b.len())]) }
fn query(root: Option<&str>) -> Result<(u64, u64), String> {
    let buffer = root.map(wide);
    let pointer = buffer.as_ref().map_or(ptr::null(), |x| x.as_ptr());
    let mut info = RecycleInfo { cb_size: std::mem::size_of::<RecycleInfo>() as u32, ..Default::default() };
    let hr = unsafe { SHQueryRecycleBinW(pointer, &mut info) };
    if hr < 0 { Err(format!("SHQueryRecycleBinW: 0x{:08X}", hr as u32)) }
    else { Ok((info.items.max(0) as u64, info.size.max(0) as u64)) }
}

/// Lightweight global Shell read, used for change detection between full scans.
pub fn quick_status() -> Result<(u64, u64), String> { query(None) }

#[derive(Clone, Serialize)]
pub struct Volume { pub name: String, pub used: Option<u64>, pub limit: Option<u64>, pub note: String }
#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub available: bool, pub items: u64, pub size: u64, pub capacity: u64,
    pub capacity_complete: bool, pub volumes: Vec<Volume>,
    pub startup: bool, pub startup_status: String, pub empty_busy: bool,
    pub checked_at: u64, pub error: Option<String>,
}

fn dword(key: Option<&RegKey>, name: &str) -> Option<u32> { key.and_then(|k| k.get_value::<u32, _>(name).ok()) }
fn enum_volumes() -> (Vec<Volume>, bool, u64, u64, u64) {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let policy = hkcu.open_subkey(POLICY).ok();
    let global_bucket = hkcu.open_subkey(BUCKET).ok();
    let mut result = Vec::new();
    let mut complete = true;
    let mut known_limit = 0u64;
    let mut local_items = 0u64;
    let mut local_size = 0u64;
    let mut buffer = vec![0u16; 4096];
    let handle = unsafe { FindFirstVolumeW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if handle as isize == -1 { return (result, false, 0, 0, 0); }
    loop {
        let guid_path = unwiden(&buffer);
        if guid_path.is_empty() { complete = false; break; }
        let kind = unsafe { GetDriveTypeW(wide(&guid_path).as_ptr()) };
        if kind == 2 || kind == 3 {
            let mut mount_buf = vec![0u16; 4096];
            let mut needed = 0u32;
            let mut ok = unsafe { GetVolumePathNamesForVolumeNameW(
                wide(&guid_path).as_ptr(), mount_buf.as_mut_ptr(), mount_buf.len() as u32, &mut needed) } != 0;
            if !ok && needed > 0 && needed <= 65_536 {
                mount_buf.resize(needed as usize, 0);
                ok = unsafe { GetVolumePathNamesForVolumeNameW(
                    wide(&guid_path).as_ptr(), mount_buf.as_mut_ptr(), mount_buf.len() as u32, &mut needed) } != 0;
            }
            if !ok { complete = false; }
            else {
                let paths: Vec<String> = mount_buf.split(|x| *x == 0)
                    .filter(|p| !p.is_empty()).map(|p| String::from_utf16_lossy(p)).collect();
                if !paths.is_empty() {
                    let mut volume = Volume { name: paths.join(", "), used: None, limit: None, note: String::new() };
                    if let Some(id_start) = guid_path.find('{') {
                        if let Some(relative_end) = guid_path[id_start..].find('}') {
                            let guid = &guid_path[id_start..id_start + relative_end + 1];
                            let entry = hkcu.open_subkey(format!(r"{}\Volume\{}", BUCKET, guid)).ok();
                            let policy_no = dword(policy.as_ref(), "NoRecycleFiles") == Some(1);
                            let nuke = dword(entry.as_ref(), "NukeOnDelete")
                                .or_else(|| dword(global_bucket.as_ref(), "NukeOnDelete")) == Some(1);
                            if policy_no || nuke { volume.limit = Some(0); volume.note = "Хранение отключено".into(); }
                            else if let Some(percent) = dword(policy.as_ref(), "RecycleBinSize") {
                                if percent <= 100 {
                                    let mut avail = 0u64; let mut total = 0u64; let mut free = 0u64;
                                    if unsafe { GetDiskFreeSpaceExW(wide(&guid_path).as_ptr(), &mut avail, &mut total, &mut free) } != 0 {
                                        volume.limit = Some((total / 1_048_576) * percent as u64 / 100 * 1_048_576);
                                        volume.note = "Политика Windows".into();
                                    }
                                }
                            } else if let Some(mb) = dword(entry.as_ref(), "MaxCapacity") {
                                if mb != u32::MAX { volume.limit = Some(mb as u64 * 1_048_576); }
                            }
                        }
                    }
                    if volume.limit.is_none() {
                        volume.note = "Явный лимит Windows не найден".into();
                        complete = false;
                    } else if let Some(limit) = volume.limit {
                        known_limit = known_limit.saturating_add(limit);
                    }
                    match query(Some(&guid_path)) {
                        Ok((items, used)) => { volume.used = Some(used); local_size = local_size.saturating_add(used); local_items = local_items.saturating_add(items); }
                        Err(_) => { complete = false; volume.note = "Не удалось прочитать содержимое тома".into(); }
                    }
                    result.push(volume);
                }
            }
        }
        if unsafe { FindNextVolumeW(handle, buffer.as_mut_ptr(), buffer.len() as u32) } == 0 { break; }
    }
    let enumerating_error = unsafe { GetLastError() };
    unsafe { FindVolumeClose(handle); }
    if enumerating_error != 18 { complete = false; }
    if result.is_empty() { complete = false; }
    (result, complete, known_limit, local_items, local_size)
}

pub fn snapshot(busy: bool) -> Snapshot {
    let global = query(None);
    let (volumes, mut complete, capacity, local_items, local_size) = enum_volumes();
    let (items, size, error) = match global {
        Ok((i, s)) => (i, s, None),
        Err(e) => (0, 0, Some(e)),
    };
    if items != local_items || size != local_size || error.is_some() { complete = false; }
    let (startup, startup_status) = startup_state();
    Snapshot {
        available: error.is_none(), items, size, capacity, capacity_complete: complete,
        volumes, startup, startup_status, empty_busy: busy,
        checked_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(), error,
    }
}

fn own_command(command: &str, executable: &str) -> bool {
    command.trim().trim_matches('"').eq_ignore_ascii_case(executable)
}
fn startup_state() -> (bool, String) {
    let path = match env::current_exe() { Ok(p) => p.to_string_lossy().into_owned(), Err(_) => return (false, "Недоступен".into()) };
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let command: Option<String> = hkcu.open_subkey(RUN).ok().and_then(|k| k.get_value(VALUE).ok());
    if !command.as_deref().is_some_and(|c| own_command(c, &path)) {
        return (false, "Выключен".into());
    }
    // StartupApproved may retain disabled entries even when Run exists.
    if let Ok(key) = hkcu.open_subkey(APPROVED) {
        if let Ok(raw) = key.get_raw_value(VALUE) {
            if raw.bytes.first().is_some_and(|v| [1, 3, 7, 9].contains(v)) {
                return (false, "Отключён в Windows".into());
            }
        }
    }
    (true, "Включён".into())
}
pub fn toggle_startup() -> Result<bool, String> {
    let enabled = startup_state().0;
    let path = env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if enabled {
        let key = hkcu.open_subkey_with_flags(RUN, winreg::enums::KEY_READ | winreg::enums::KEY_WRITE).map_err(|e| e.to_string())?;
        let current: String = key.get_value(VALUE).map_err(|e| e.to_string())?;
        if own_command(&current, &path) { key.delete_value(VALUE).map_err(|e| e.to_string())?; }
    } else {
        if let Ok(key) = hkcu.open_subkey_with_flags(APPROVED, winreg::enums::KEY_WRITE) {
            let _ = key.delete_value(VALUE);
        }
        let (key, _) = hkcu.create_subkey(RUN).map_err(|e| e.to_string())?;
        key.set_value(VALUE, &format!("\"{}\"", path)).map_err(|e| e.to_string())?;
    }
    let (after, _) = startup_state();
    Ok(after)
}
pub fn open_recycle_bin() -> Result<(), String> {
    let windir = env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
    Command::new(std::path::Path::new(&windir).join("explorer.exe"))
        .arg("shell:RecycleBinFolder").spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn empty_recycle_bin() -> Result<(), String> {
    if query(None).map(|x| x.0).unwrap_or(0) == 0 { return Ok(()); }
    // Show the native Shell confirmation and progress, as in TrayBin 1.1.14.
    let ole = unsafe { OleInitialize(ptr::null_mut()) };
    let hr = unsafe { SHEmptyRecycleBinW(ptr::null_mut(), ptr::null(), 0) };
    if ole >= 0 { unsafe { OleUninitialize(); } }
    if hr == 0 { Ok(()) }
    else if hr as u32 == 0x800704C7 { Err("Очистка отменена пользователем".into()) }
    else { Err(format!("Windows: 0x{:08X}", hr as u32)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn own_command_quotes() {
        assert!(own_command(r#""C:\\Tools\\TrayBin.exe""#, r"C:\\Tools\\TrayBin.exe"));
        assert!(!own_command(r#""C:\\Other\\TrayBin.exe""#, r"C:\\Tools\\TrayBin.exe"));
    }
}

/// Compatibility for the legacy hidden INI option. Missing INI means five states.
pub fn two_states() -> bool {
    let local = env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join("TrayBin.ini")));
    let roaming = env::var_os("APPDATA").map(|p| PathBuf::from(p).join("TrayBin").join("TrayBin.ini"));
    let selected = local.filter(|p| p.exists()).or(roaming);
    let Some(path) = selected else { return false; };
    let Ok(text) = std::fs::read_to_string(path) else { return false; };
    let mut section = String::new();
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len()-1].to_string();
        } else if section.eq_ignore_ascii_case("Configure") {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim().eq_ignore_ascii_case("IconsTwoStates") { return value.trim() == "1"; }
            }
        }
    }
    false
}
