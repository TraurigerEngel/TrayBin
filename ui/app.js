'use strict';
const $ = id => document.getElementById(id);
const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const number = new Intl.NumberFormat('ru-RU');
let busy = false;
let toastTimer;
let lastVolumesKey = null;

function formatSize(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  let size = Math.max(0, bytes);
  let unit = 0;
  while (size >= 1024 && unit < 4) { size /= 1024; unit++; }
  return `${size.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'][unit]}`;
}
function word(value) {
  const a = value % 100;
  const b = value % 10;
  return a >= 11 && a <= 14 ? 'объектов' : b === 1 ? 'объект' : b >= 2 && b <= 4 ? 'объекта' : 'объектов';
}
function toast(message) {
  const node = $('toast');
  node.textContent = String(message);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3700);
}
function renderVolumes(volumes) {
  const key = JSON.stringify(volumes ?? []);
  if (key === lastVolumesKey) return;
  lastVolumesKey = key;
  const container = $('volumes');
  container.replaceChildren();
  if (!volumes?.length) {
    container.textContent = 'Windows не вернула сведения о дисках.';
    return;
  }
  for (const volume of volumes) {
    const row = document.createElement('div');
    row.className = 'drive';
    row.setAttribute('role', 'listitem');
    const name = document.createElement('span');
    name.className = 'drive-title';
    name.textContent = volume.name;
    const note = document.createElement('span');
    note.className = 'drive-note';
    note.textContent = `${formatSize(volume.used)} / ${volume.limit == null ? 'лимит неизвестен' : formatSize(volume.limit)}${volume.note ? ` · ${volume.note}` : ''}`;
    row.append(name, note);
    container.append(row);
  }
}
function render(snapshot) {
  if (!snapshot) return;
  const available = Boolean(snapshot.available);
  const items = available ? snapshot.items : 0;
  const status = $('dot');
  status.className = `status-dot ${available ? 'online' : 'error'}`;
  status.title = available ? 'Данные Windows доступны' : 'Не удалось прочитать корзину';
  $('checked').textContent = Number.isFinite(snapshot.checked_at) && snapshot.checked_at > 0
    ? new Date(snapshot.checked_at * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : 'Нет данных';
  $('checked').title = 'Последняя проверка';
  $('hero-title').textContent = snapshot.empty_busy ? 'Очистка корзины…' : !available ? 'Состояние недоступно' : items ? 'В корзине' : 'Корзина пуста';
  $('count').textContent = available ? number.format(items) : '—';
  $('count-unit').textContent = available && items ? word(items) : '';
  $('used').textContent = !available ? 'Не удалось получить данные Windows' : items === 0 ? 'Ничего лишнего' : `Занято ${formatSize(snapshot.size)}`;

  $('used-value').textContent = available ? formatSize(snapshot.size) : '—';
  // "capacity_complete" is stricter than "at least one explicit disk limit exists":
  // the native scan also marks it false on missing disk data or a Shell count mismatch.
  // Show known limits honestly even when a complete aggregate cannot be established.
  const knownCapacity = available && Number.isFinite(snapshot.capacity) && snapshot.capacity > 0;
  const reliable = knownCapacity && snapshot.capacity_complete === true;
  const partial = knownCapacity && !reliable;
  $('limit-label').textContent = partial ? 'Известный лимит' : 'Лимит Windows';
  $('limit-value').textContent = reliable ? formatSize(snapshot.capacity)
    : partial ? `≥ ${formatSize(snapshot.capacity)}` : (available ? 'Не определён' : '—');
  $('limit-value').title = partial ? 'Нижняя граница: общий лимит по всем дискам не подтверждён' : '';
  $('capacity-caption').textContent = reliable ? 'Заполненность'
    : partial ? 'Общий лимит требует уточнения' : 'Точный лимит недоступен';
  const percent = reliable ? Math.min(100, Math.max(0, snapshot.size / snapshot.capacity * 100)) : null;
  const percentText = percent == null ? '—' : `${percent.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  $('percent').textContent = percentText;
  $('fill').style.width = `${percent ?? 0}%`;
  const track = $('track');
  track.hidden = percent == null;
  track.setAttribute('aria-valuetext', percent == null ? 'Точный лимит неизвестен' : percentText);
  if (percent == null) track.removeAttribute('aria-valuenow');
  else track.setAttribute('aria-valuenow', String(percent));

  $('empty').disabled = !available || !items || snapshot.empty_busy || busy;
  $('empty').setAttribute('aria-busy', String(snapshot.empty_busy || busy));
  $('open').disabled = busy;
  $('startup').disabled = busy;
  $('startup-status').textContent = snapshot.startup_status;
  $('switch').classList.toggle('on', Boolean(snapshot.startup));
  $('startup').setAttribute('aria-pressed', String(Boolean(snapshot.startup)));
  renderVolumes(snapshot.volumes);
}
async function reload() {
  if (!invoke) return;
  try { render(await invoke('get_snapshot')); }
  catch (error) {
    render({ available: false, items: 0, capacity_complete: false, volumes: [], startup: false, startup_status: 'Недоступен' });
    toast(`Не удалось получить данные: ${error}`);
  }
}
async function operation(command, { hideBefore = false, hideAfter = false } = {}) {
  if (busy || !invoke) return;
  busy = true;
  $('open').disabled = true;
  $('startup').disabled = true;
  $('empty').disabled = true;
  try {
    if (hideBefore) await invoke('hide_panel');
    await invoke(command);
    if (hideAfter) await invoke('hide_panel');
  } catch (error) {
    if (!String(error).includes('отменена пользователем')) {
      if (hideBefore) {
        try { await invoke('show_panel_error'); } catch { /* Preserve the original error. */ }
      }
      toast(error);
    }
  } finally {
    busy = false;
    await reload();
  }
}
function setDetails(open) {
  $('home-view').hidden = open;
  $('details-panel').hidden = !open;
  $('details').textContent = open ? '← Назад' : 'Подробнее';
  $('details').setAttribute('aria-expanded', String(open));
  if (open) $('volumes').scrollTop = 0;
}
function closeDetails() { setDetails(false); }
$('open').addEventListener('click', () => operation('open_bin', { hideAfter: true }));
$('empty').addEventListener('click', () => operation('empty_bin', { hideBefore: true }));
$('startup').addEventListener('click', () => operation('set_startup'));
$('hide').addEventListener('click', () => { closeDetails(); invoke?.('hide_panel'); });
$('quit').addEventListener('click', () => invoke?.('exit_app'));
$('details').addEventListener('click', () => setDetails($('details-panel').hidden));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeDetails(); invoke?.('hide_panel'); }
});
window.addEventListener?.('blur', closeDetails);

if (invoke) {
  tauri.event.listen('traybin://snapshot', ({ payload }) => render(payload)).catch(console.error);
  tauri.event.listen('traybin://error', ({ payload }) => toast(payload)).catch(console.error);
  reload();
} else {
  $('hero-title').textContent = 'Запуск вне Tauri';
  $('used').textContent = 'Запусти приложение через npm run dev';
  $('checked').textContent = 'Нет подключения';
  $('startup-status').textContent = 'Нет подключения';
}
