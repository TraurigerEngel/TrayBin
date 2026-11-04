'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
const ids = [
  'dot', 'checked', 'hero-title', 'count', 'count-unit', 'used', 'used-value',
  'limit-value', 'limit-label', 'capacity-caption', 'percent', 'fill', 'empty', 'startup-status',
  'switch', 'startup', 'volumes', 'open', 'hide', 'quit', 'details', 'details-panel',
  'track', 'toast', 'home-view',
];
function element() {
  const listeners = new Map();
  const attrs = new Map();
  const classes = new Set();
  return {
    textContent: '', className: '', style: {}, disabled: false, hidden: true,
    children: [], attributes: attrs, classes, replaceCalls: 0,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
    },
    setAttribute(k, v) { attrs.set(k, v); },
    removeAttribute(k) { attrs.delete(k); },
    addEventListener(k, fn) { listeners.set(k, fn); },
    replaceChildren() { this.children = []; this.textContent = ''; this.replaceCalls++; },
    append(...elements) { this.children.push(...elements); },
    click() { return listeners.get('click')?.(); },
  };
}
function snapshot(overrides = {}) {
  return {
    available: true, items: 1043, size: 10 * (1024 ** 3),
    capacity: 50 * (1024 ** 3), capacity_complete: true,
    volumes: [{ name: 'C:', used: 10 * (1024 ** 3), limit: 50 * (1024 ** 3), note: '' }],
    startup: false, startup_status: 'Выключен', empty_busy: false,
    checked_at: 1791670000, error: null, ...overrides,
  };
}
function setup({ failure = {}, initial = snapshot() } = {}) {
  const nodes = Object.fromEntries(ids.map(id => [id, element()]));
  const events = new Map();
  const commands = [];
  const handlers = new Map();
  const document = {
    getElementById: id => { assert.ok(nodes[id], id); return nodes[id]; },
    createElement: () => element(),
    addEventListener: (name, fn) => handlers.set(name, fn),
  };
  let current = initial;
  const invoke = async (name) => {
    commands.push(name);
    if (failure[name]) throw failure[name];
    if (name === 'get_snapshot') return current;
    return undefined;
  };
  const context = {
    document, Intl, Date, Number, String, console,
    setTimeout: () => 1, clearTimeout: () => {},
    window: { __TAURI__: { core: { invoke }, event: { listen: async (name, fn) => { events.set(name, fn); } } } },
  };
  vm.runInNewContext(source, context, { filename: 'ui/app.js' });
  nodes['home-view'].hidden = false;
  return { nodes, events, commands, handlers, setSnapshot: s => { current = s; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

// These tests execute the real app.js with a mocked Tauri bridge and DOM.
test('Russian numbers, percentage, Classic status and drives are rendered', async () => {
  const { nodes } = setup();
  await tick();
  assert.equal(nodes.count.textContent, '1 043');
  assert.equal(nodes['count-unit'].textContent, 'объекта');
  assert.equal(nodes.percent.textContent, '20%');
  assert.equal(nodes.fill.style.width, '20%');
  assert.equal(nodes.track.hidden, false);
  assert.equal(nodes.track.attributes.get('aria-valuenow'), '20');
  assert.equal(nodes.used.textContent, 'Занято 10 ГБ');
  assert.equal(nodes['used-value'].textContent, '10 ГБ');
  assert.equal(nodes['limit-value'].textContent, '50 ГБ');
  assert.equal(nodes['limit-label'].textContent, 'Лимит Windows');
  assert.equal(nodes.volumes.children.length, 1);
  assert.equal(nodes.empty.disabled, false);
  assert.equal(nodes.startup.attributes.get('aria-pressed'), 'false');
});
test('Unknown capacity remains unknown; empty bin is disabled', async () => {
  const { nodes } = setup({ initial: snapshot({items: 0, size: 0, capacity_complete: false, capacity: 0}) });
  await tick();
  assert.equal(nodes['hero-title'].textContent, 'Корзина пуста');
  assert.equal(nodes['limit-value'].textContent, 'Не определён');
  assert.equal(nodes.percent.textContent, '—');
  assert.equal(nodes.track.hidden, true);
  assert.equal(nodes.track.attributes.has('aria-valuenow'), false);
  assert.equal(nodes.empty.disabled, true);
});
test('Unavailable Shell data cannot authorize deleting', async () => {
  const { nodes } = setup({ initial: snapshot({ available: false, error: 'Windows read failed'}) });
  await tick();
  assert.equal(nodes.empty.disabled, true);
  assert.equal(nodes.count.textContent, '—');
  assert.equal(nodes.dot.title, 'Не удалось прочитать корзину');
});
test('Left action opens bin then hides panel; startup stays in place', async () => {
  const { nodes, commands } = setup();
  await tick();
  nodes.open.click();
  await tick();
  assert.deepEqual(commands.slice(-3), ['open_bin', 'hide_panel', 'get_snapshot']);
  nodes.startup.click();
  await tick();
  assert.deepEqual(commands.slice(-2), ['set_startup', 'get_snapshot']);
});
test('Clear operation hides panel first, never repeats on rapid clicks', async () => {
  const { nodes, commands } = setup();
  await tick();
  nodes.empty.click();
  nodes.empty.click();
  await tick();
  assert.equal(commands.filter(x => x === 'empty_bin').length, 1);
  assert.ok(commands.indexOf('hide_panel') < commands.indexOf('empty_bin'));
});
test('Failed empty restores panel and displays the error; cancellation is silent', async () => {
  const failed = setup({ failure: { empty_bin: 'Системная ошибка' } });
  await tick();
  failed.nodes.empty.click();
  await tick();
  assert.deepEqual(failed.commands.slice(-4), ['hide_panel', 'empty_bin', 'show_panel_error', 'get_snapshot']);
  assert.equal(failed.nodes.toast.textContent, 'Системная ошибка');
  const cancelled = setup({ failure: { empty_bin: 'Очистка отменена пользователем' } });
  await tick();
  cancelled.nodes.empty.click();
  await tick();
  assert.equal(cancelled.commands.includes('show_panel_error'), false);
  assert.equal(cancelled.nodes.toast.textContent, '');
});
test('Live Tauri updates and Escape close the details cleanly', async () => {
  const { nodes, events, handlers, commands } = setup();
  await tick();
  assert.equal(events.has('traybin://snapshot'), true);
  events.get('traybin://snapshot')({ payload: snapshot({ items: 3, startup: true, startup_status: 'Включён' }) });
  assert.equal(nodes['count-unit'].textContent, 'объекта');
  assert.equal(nodes['startup-status'].textContent, 'Включён');
  assert.equal(nodes.startup.attributes.get('aria-pressed'), 'true');
  nodes.details.click();
  assert.equal(nodes['details-panel'].hidden, false);
  assert.equal(nodes['home-view'].hidden, true);
  assert.equal(nodes.details.textContent, '← Назад');
  handlers.get('keydown')({key: 'Escape'});
  assert.equal(nodes['details-panel'].hidden, true);
  assert.equal(nodes['home-view'].hidden, false);
  assert.equal(nodes.details.textContent, 'Подробнее');
  assert.equal(nodes.details.attributes.get('aria-expanded'), 'false');
  assert.equal(commands.at(-1), 'hide_panel');
});


test('Repeated snapshots do not rebuild unchanged drive details', async () => {
  const { nodes, events } = setup();
  await tick();
  const old = nodes.volumes.replaceCalls;
  events.get('traybin://snapshot')({ payload: snapshot({ items: 98 }) });
  assert.equal(nodes.volumes.replaceCalls, old);
  events.get('traybin://snapshot')({ payload: snapshot({ volumes: [{ name: 'D:', used: 0, limit: null, note: 'Unknown' }] }) });
  assert.equal(nodes.volumes.replaceCalls, old + 1);
});

test('Snapshot loading failure is fail-safe, not stuck in checking state', async () => {
  const { nodes } = setup({ failure: { get_snapshot: 'IPC failure' } });
  await tick();
  assert.equal(nodes['hero-title'].textContent, 'Состояние недоступно');
  assert.equal(nodes['startup-status'].textContent, 'Недоступен');
  assert.equal(nodes.empty.disabled, true);
  assert.match(nodes.toast.textContent, /IPC failure/);
});

test('In-progress native empty blocks repeated destructive actions', async () => {
  const { nodes, events } = setup();
  await tick();
  events.get('traybin://snapshot')({ payload: snapshot({ empty_busy: true }) });
  assert.equal(nodes.empty.disabled, true);
  assert.equal(nodes.empty.attributes.get('aria-busy'), 'true');
  assert.equal(nodes['hero-title'].textContent, 'Очистка корзины…');
});

test('Details remain keyboard-accessible and can be toggled without removing content', async () => {
  const { nodes, handlers } = setup();
  await tick();
  nodes.details.click();
  assert.equal(nodes['details-panel'].hidden, false);
  assert.equal(nodes.details.attributes.get('aria-expanded'), 'true');
  nodes.details.click();
  assert.equal(nodes['details-panel'].hidden, true);
  nodes.details.click();
  handlers.get('keydown')({ key: 'Escape' });
  assert.equal(nodes['details-panel'].hidden, true);
  assert.equal(nodes['home-view'].hidden, false);
  assert.equal(nodes.details.textContent, 'Подробнее');
  assert.equal(nodes.details.attributes.get('aria-expanded'), 'false');
});


test('Known disk limits remain visible when an additional disk lacks its limit', async () => {
  const giga = 1024 ** 3;
  const knownLimit = Math.round(14.46 * giga) + Math.round(37.18 * giga);
  const { nodes } = setup({ initial: snapshot({
    capacity: knownLimit, capacity_complete: false, size: 6.64 * giga,
    volumes: [
      { name: 'C:\\', used: 3 * 1024 ** 2, limit: Math.round(14.46 * giga), note: '' },
      { name: 'T:\\', used: 6.64 * giga, limit: Math.round(37.18 * giga), note: '' },
      { name: 'D:\\', used: null, limit: null, note: 'Явный лимит Windows не найден' },
    ],
  }) });
  await tick();
  assert.equal(nodes['limit-label'].textContent, 'Известный лимит');
  assert.equal(nodes['limit-value'].textContent, '≥ 51,64 ГБ');
  assert.equal(nodes['capacity-caption'].textContent, 'Общий лимит требует уточнения');
  assert.equal(nodes.percent.textContent, '—');
  assert.equal(nodes.track.hidden, true);
  assert.equal(nodes.volumes.children.length, 3);
});

test('When full scan is incomplete without missing explicit capacities, known total is still shown', async () => {
  const { nodes } = setup({ initial: snapshot({ capacity_complete: false }) });
  await tick();
  assert.equal(nodes['limit-value'].textContent, '≥ 50 ГБ');
  assert.equal(nodes['limit-label'].textContent, 'Известный лимит');
  assert.equal(nodes.track.hidden, true);
});

test('Missing Shell data never presents a known capacity as reliable', async () => {
  const { nodes } = setup({ initial: snapshot({ available: false, capacity_complete: true }) });
  await tick();
  assert.equal(nodes['limit-value'].textContent, '—');
  assert.equal(nodes.track.hidden, true);
});

test('Details form an exclusive view; back restores home, preserves native commands', async () => {
  const { nodes, commands } = setup();
  await tick();
  nodes.details.click();
  assert.equal(nodes['home-view'].hidden, true);
  assert.equal(nodes['details-panel'].hidden, false);
  assert.equal(nodes.details.textContent, '← Назад');
  nodes.details.click();
  assert.equal(nodes['home-view'].hidden, false);
  assert.equal(nodes['details-panel'].hidden, true);
  assert.equal(nodes.details.textContent, 'Подробнее');
  nodes.open.click();
  await tick();
  assert.deepEqual(commands.slice(-3), ['open_bin', 'hide_panel', 'get_snapshot']);
});
