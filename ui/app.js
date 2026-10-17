'use strict';
const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
let busy = false;
let snap = null;
let toastTimer;
const number = new Intl.NumberFormat('ru-RU');
function formatSize(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  let n = Math.max(0, bytes); let u = 0;
  while (n >= 1024 && u < 4) { n /= 1024; u++; }
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${['Б','КБ','МБ','ГБ','ТБ'][u]}`;
}
function word(n) {
  const m = n % 100; const l = n % 10;
  return m >= 11 && m <= 14 ? 'объектов' : l === 1 ? 'объект' : l >= 2 && l <= 4 ? 'объекта' : 'объектов';
}
function toast(text) {
  const node = $('toast');
  node.textContent = String(text); node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3700);
}
function render(s) {
  if (!s) return; snap = s;
  const available = s.available;
  $('dot').className = `status-dot ${available ? 'online' : 'error'}`;
  $('dot').title = available ? 'Система Windows доступна' : 'Не удалось прочитать корзину';
  $('checked').textContent = new Date(s.checked_at * 1000).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  $('checked').title = 'Время последней полной проверки данных';
  $('hero-title').textContent = s.empty_busy ? 'Идёт очистка…' : !available ? 'Состояние недоступно' : s.items ? 'Обнаружены файлы' : 'Корзина пуста';
  $('count').textContent = available ? number.format(s.items) : '—';
  $('count-unit').textContent = available ? word(s.items) : '';
  $('used').textContent = !available ? 'Не удалось получить данные Windows' : s.items === 0 ? 'Всё чисто ✧' : 'Ожидают удаления';
  $('used-value').textContent = available ? formatSize(s.size) : '—';
  const reliable = available && s.capacity_complete && s.capacity > 0;
  $('limit-value').textContent = reliable ? formatSize(s.capacity) : 'Не определён';
  $('capacity-caption').textContent = reliable ? 'Заполненность корзины' : 'Точный лимит недоступен';
  const pct = reliable ? Math.min(100, Math.max(0, s.size / s.capacity * 100)) : null;
  $('percent').textContent = pct == null ? '—' : `${pct.toLocaleString('ru-RU', {maximumFractionDigits:1})}%`;
  $('fill').style.width = `${pct ?? 0}%`;
  $('empty').disabled = !available || s.items === 0 || s.empty_busy || busy;
  $('empty').setAttribute('aria-busy', String(s.empty_busy || busy));
  $('startup-status').textContent = s.startup_status;
  $('switch').classList.toggle('on', s.startup);
  $('startup').setAttribute('aria-pressed', String(s.startup));
  $('volumes').replaceChildren();
  if (!s.volumes || s.volumes.length === 0) $('volumes').textContent = 'Windows не вернула сведения о томах.';
  else for (const v of s.volumes) {
    const row = document.createElement('div'); row.className = 'drive';
    const title = document.createElement('span'); title.className = 'drive-title'; title.textContent = v.name;
    const note = document.createElement('span'); note.className = 'drive-note';
    note.textContent = `${formatSize(v.used)} / ${v.limit == null ? 'лимит неизвестен' : formatSize(v.limit)}${v.note ? ' · ' + v.note : ''}`;
    row.append(title, note); $('volumes').append(row);
  }
}
async function reload() {
  try { render(await invoke('get_snapshot')); }
  catch(e) { toast(`Не удалось прочитать корзину: ${e}`); }
}
async function operation(action, { hideBefore = false, hideAfter = false } = {}) {
  if (busy || !invoke) return;
  busy = true;
  $('open').disabled = true;
  $('startup').disabled = true;
  $('empty').disabled = true;
  try {
    if (hideBefore) await invoke('hide_panel');
    await invoke(action);
    if (hideAfter) await invoke('hide_panel');
  } catch(e) {
    if (!String(e).includes('отменена пользователем')) {
      if (hideBefore) {
        try { await invoke('show_panel_error'); } catch { /* Keep original error. */ }
      }
      toast(e);
    }
  } finally {
    busy = false;
    $('open').disabled = false;
    $('startup').disabled = false;
    await reload();
  }
}
function closeDetails() {
  $('details-panel').hidden = true;
  $('details').setAttribute('aria-expanded', 'false');
  $('details-arrow').textContent = '⌄';
}
$('open').addEventListener('click', () => operation('open_bin', { hideAfter: true }));
$('empty').addEventListener('click', () => {
  // Hide our always-on-top panel before the native Windows confirmation appears.
  operation('empty_bin', { hideBefore: true });
});
$('startup').addEventListener('click', () => operation('set_startup'));
$('hide').addEventListener('click', () => { closeDetails(); invoke?.('hide_panel'); });
$('quit').addEventListener('click', () => invoke?.('exit_app'));
$('details').addEventListener('click', () => {
  const hidden = !$('details-panel').hidden;
  $('details-panel').hidden = hidden;
  $('details').setAttribute('aria-expanded', String(!hidden));
  $('details-arrow').textContent = hidden ? '⌄' : '⌃';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDetails(); invoke?.('hide_panel'); }
});
if (invoke) {
  tauri.event.listen('traybin://snapshot', ({ payload }) => render(payload)).catch(console.error);
  tauri.event.listen('traybin://error', ({ payload }) => toast(payload)).catch(console.error);
  reload();
} else {
  $('hero-title').textContent = 'Запуск вне Tauri';
  $('used').textContent = 'Откройте приложение через npm run dev';
  $('checked').textContent = 'Нет подключения';
  $('open').disabled = true; $('startup').disabled = true; $('empty').disabled = true;
}
