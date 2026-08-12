# Кухонный оркестратор — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Статическая PWA: обратный расчёт готовки от времени подачи — таймлайн «что и когда ставить», бипы по этапам, офлайн.

**Architecture:** Vanilla JS без сборки. Чистая логика в `schedule.js` (единственный тестируемый модуль, `node --test`), DOM/тик/звук/Wake Lock в `app.js`, cache-first `sw.js`. Спека: `docs/superpowers/specs/2026-08-12-kitchen-orchestrator-design.md`.

**Tech Stack:** Vanilla ES modules, Web Audio, Wake Lock API, Service Worker, node --test.

## Global Constraints

- Ноль внешних зависимостей, ноль шагов сборки. Никакого package.json.
- Все пути в HTML/SW относительные (`./`) — должно работать под `https://<user>.github.io/kitchen-orchestrator/`.
- Язык UI — русский; тон спокойный, глаголы действия; моноширинные метаданные в нижнем регистре с «·».
- Светлая «бумажная» тема, палитра vibecoded: `--paper:#F4F5F3`, `--card:#FFFFFF`, `--ink:#16181D`, `--ink-soft:#5A5F6A`, `--accent:#FF4D1F`, `--link:#3D5AFE`, `--line:#E2E4E0`. Без тёмной темы, без градиентов.
- Статусы позиции: `waiting` → `due` → `cooking` → `served`. `due` держится, пока позиция не «подтверждена» (acked): UI подтверждает автоматически через 60 с после первого показа. Константа `DUE_WINDOW_MS = 60_000` живёт в `app.js`; `schedule.js` принимает готовый `Set` acked-ids и остаётся чистым.
- localStorage-ключ: `"kitchen-plan"`, формат `{ serveTime, items, sound, notified }`.
- Коммит после каждой задачи. Без Claude в авторах/трейлерах.

## DOM-контракт (ids используются в Tasks 2–4)

`#serve-time` (input type=time), `#tomorrow-flag` (span «завтра», hidden), `#items` (контейнер строк), `#add-item`, `#timeline` (контейнер), `#countdown`, `#sound-toggle`, `#reset`, `#hint` (подсказка при пустом плане). Строка позиции: `.item-row[data-id]` c `.item-name` (input text), `.item-minutes` (input number), `.item-remove` (кнопка ×).

---

### Task 1: schedule.js — чистая логика (TDD)

**Files:**
- Create: `schedule.js`, `test/schedule.test.mjs`, `.gitignore` (`.DS_Store`)

**Interfaces:**
- Produces:
  - `resolveServeDate(hhmm: string, now: Date) -> Date` — сегодня в HH:MM, либо завтра, если время ≤ now.
  - `computeSchedule(items: [{id, name, minutes}], serveAt: Date, now: Date, acked?: Set<string>) -> { serveAt, entries }`, где `entries: [{id, name, minutes, start: Date, status}]`, отсортировано по `start` возрастанию (stable), невалидные позиции (пустое имя / minutes не конечное число > 0) отфильтрованы.
  - Статус: `served` (now ≥ serveAt) → иначе `waiting` (now < start) → иначе `due`, пока id нет в `acked` → иначе `cooking`.

- [ ] **Step 1: Написать падающие тесты**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveServeDate, computeSchedule } from "../schedule.js";

const at = (h, m) => new Date(2026, 7, 12, h, m, 0, 0); // 12 августа 2026, локальное время

test("resolveServeDate: время впереди — сегодня", () => {
  assert.deepEqual(resolveServeDate("20:00", at(18, 0)), at(20, 0));
});

test("resolveServeDate: время прошло — завтра", () => {
  const d = resolveServeDate("08:00", at(18, 0));
  assert.deepEqual(d, new Date(2026, 7, 13, 8, 0, 0, 0));
});

test("resolveServeDate: ровно сейчас — завтра", () => {
  const d = resolveServeDate("18:00", at(18, 0));
  assert.deepEqual(d, new Date(2026, 7, 13, 18, 0, 0, 0));
});

test("computeSchedule: сортировка по старту, длинное — первым", () => {
  const { entries } = computeSchedule(
    [
      { id: "a", name: "картошка", minutes: 40 },
      { id: "b", name: "гусь", minutes: 180 },
    ],
    at(20, 0), at(10, 0),
  );
  assert.deepEqual(entries.map(e => e.id), ["b", "a"]);
  assert.deepEqual(entries[0].start, at(17, 0));
  assert.deepEqual(entries[1].start, at(19, 20));
});

test("computeSchedule: равные старты — порядок ввода", () => {
  const { entries } = computeSchedule(
    [
      { id: "a", name: "соус", minutes: 30 },
      { id: "b", name: "рис", minutes: 30 },
    ],
    at(20, 0), at(10, 0),
  );
  assert.deepEqual(entries.map(e => e.id), ["a", "b"]);
});

test("computeSchedule: четыре фазы статусов с границами", () => {
  const items = [{ id: "a", name: "утка", minutes: 60 }]; // старт 19:00
  const cases = [
    [at(18, 59), undefined, "waiting"],
    [at(19, 0), undefined, "due"],              // ровно старт, не подтверждено
    [at(19, 30), undefined, "due"],             // висит, пока не подтверждено
    [at(19, 30), new Set(["a"]), "cooking"],    // подтверждено
    [at(20, 0), new Set(["a"]), "served"],      // ровно подача
  ];
  for (const [now, acked, expected] of cases) {
    const { entries } = computeSchedule(items, at(20, 0), now, acked);
    assert.equal(entries[0].status, expected, `now=${now}`);
  }
});

test("computeSchedule: старт в прошлом — due сразу и держится", () => {
  const { entries } = computeSchedule(
    [{ id: "a", name: "гусь", minutes: 180 }], at(20, 0), at(19, 0),
  );
  assert.equal(entries[0].status, "due");
});

test("computeSchedule: невалидные позиции отфильтрованы", () => {
  const { entries } = computeSchedule(
    [
      { id: "a", name: "  ", minutes: 30 },
      { id: "b", name: "суп", minutes: 0 },
      { id: "c", name: "суп", minutes: NaN },
      { id: "d", name: "рис", minutes: 25 },
    ],
    at(20, 0), at(10, 0),
  );
  assert.deepEqual(entries.map(e => e.id), ["d"]);
});
```

- [ ] **Step 2: Прогнать — падают**

Run: `cd ~/projects/kitchen-orchestrator && node --test`
Expected: FAIL — `Cannot find module .../schedule.js`

- [ ] **Step 3: Реализация schedule.js**

```js
export function resolveServeDate(hhmm, now) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

export function computeSchedule(items, serveAt, now, acked = new Set()) {
  const valid = items.filter(
    (it) => it.name.trim() !== "" && Number.isFinite(it.minutes) && it.minutes > 0,
  );
  const entries = valid.map((it) => {
    const start = new Date(serveAt.getTime() - it.minutes * 60_000);
    let status;
    if (now >= serveAt) status = "served";
    else if (now < start) status = "waiting";
    else if (!acked.has(it.id)) status = "due";
    else status = "cooking";
    return { id: it.id, name: it.name, minutes: it.minutes, start, status };
  });
  entries.sort((a, b) => a.start - b.start);
  return { serveAt, entries };
}
```

`due` — «наступил старт, человек ещё не среагировал»: держится и для «старта в прошлом», пока UI не подтвердит (авто-ack через `DUE_WINDOW_MS` после первого показа, см. Task 4). Чистая модель про acked ничего не решает — только принимает готовый Set.

- [ ] **Step 4: Прогнать — зелёные**

Run: `node --test`
Expected: 8 tests pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pure schedule computation with tests"
```

---

### Task 2: index.html + style.css — разметка и дизайн

**Files:**
- Create: `index.html`, `style.css`

**Interfaces:**
- Produces: все ids из DOM-контракта; `<template id="item-row-tpl">` для строки позиции; статусные классы таймлайна `.tl-waiting/.tl-due/.tl-cooking/.tl-served`.
- Consumes: ничего из кода (app.js подключается `<script type="module" src="./app.js">`, но появится в Task 3 — страница обязана рендериться и без него).

- [ ] **Step 1: Загрузить skill `frontend-design:frontend-design` и сверстать страницу**

Требования к вёрстке (обязательные, поверх дизайн-скилла):
- `<html lang="ru">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<link rel="manifest" href="./manifest.json">`, `<meta name="theme-color" content="#F4F5F3">`, `<title>Кухонный оркестратор</title>`.
- Структура: `<header>` (название + tagline «считает назад от подачи»), секция времени (`#serve-time`, `#tomorrow-flag`), секция позиций (`#items`, `#add-item` «Добавить блюдо»), секция таймлайна (`#countdown`, `#sound-toggle`, `#timeline`, `#hint`, `#reset` «Сброс»).
- Семантика: `<main>`, `<section>`, `<button>` (не div), видимый focus-state, `prefers-reduced-motion` отключает анимации подсветки.
- Палитра и шрифтовая система из Global Constraints; системные шрифты (без webfonts — офлайн-PWA): текст `system-ui`, метаданные/время `ui-monospace, monospace`.
- Мобильная вёрстка обязательна (телефон на кухне — основной сценарий): один столбец, крупные тапабельные кнопки (min-height 44px), `#countdown` крупный моно.
- `.tl-due` подсвечивается `--accent` (фон-плашка или левая полоса), без градиентов.

- [ ] **Step 2: Проверить статическую страницу**

Run: `cd ~/projects/kitchen-orchestrator && python3 -m http.server 8765 &` затем открыть `http://localhost:8765` в браузере (Claude in Chrome), скриншот.
Expected: страница рендерится без консольных ошибок (404 на app.js/manifest допустим до Task 3/5), выглядит по дизайн-системе, мобильная ширина ок.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: page layout and paper-theme styles"
```

---

### Task 3: app.js — состояние, рендер, тик

**Files:**
- Create: `app.js`
- Modify: `index.html` (подключить `<script type="module" src="./app.js"></script>` перед `</body>`, если не сделано в Task 2)

**Interfaces:**
- Consumes: `computeSchedule`, `resolveServeDate`, `DUE_WINDOW_MS` из `./schedule.js`; DOM-контракт из Task 2.
- Produces: глобальное состояние и функции `loadState/saveState/render/tick` (внутренние, не экспортируются); Task 4 добавит в `tick` звук и Wake Lock.

- [ ] **Step 1: Реализация app.js (каркас)**

```js
import { computeSchedule, resolveServeDate } from "./schedule.js";

const KEY = "kitchen-plan";
const DUE_WINDOW_MS = 60_000; // авто-подтверждение due через минуту после бипа

let state = loadState();

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch {}
  return { serveTime: "", items: [], sound: true, notified: {} };
}

function saveState() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

const $ = (sel) => document.querySelector(sel);

function addItem(name = "", minutes = "") {
  state.items.push({ id: crypto.randomUUID(), name, minutes });
  saveState();
  renderItems();
  renderTimeline();
}

function renderItems() {
  const box = $("#items");
  box.textContent = "";
  for (const it of state.items) {
    const row = $("#item-row-tpl").content.firstElementChild.cloneNode(true);
    row.dataset.id = it.id;
    const name = row.querySelector(".item-name");
    const min = row.querySelector(".item-minutes");
    name.value = it.name;
    min.value = it.minutes;
    name.addEventListener("input", () => { it.name = name.value; saveState(); renderTimeline(); });
    min.addEventListener("input", () => { it.minutes = Number(min.value); saveState(); renderTimeline(); });
    row.querySelector(".item-remove").addEventListener("click", () => {
      state.items = state.items.filter((x) => x.id !== it.id);
      delete state.notified[it.id];
      saveState();
      renderItems();
      renderTimeline();
    });
    box.append(row);
  }
}

const timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

function plan(now = new Date()) {
  if (!state.serveTime) return null;
  const serveAt = resolveServeDate(state.serveTime, now);
  // acked: позиции, чей due показан больше DUE_WINDOW_MS назад (state.notified: {id: timestampMs})
  const acked = new Set(
    Object.entries(state.notified)
      .filter(([id, ts]) => id !== "__serve" && now.getTime() - ts >= DUE_WINDOW_MS)
      .map(([id]) => id),
  );
  const { entries } = computeSchedule(state.items, serveAt, now, acked);
  return entries.length ? { serveAt, entries } : null;
}

function renderTimeline() {
  const now = new Date();
  const p = plan(now);
  $("#hint").hidden = !!p;
  $("#timeline").hidden = !p;
  $("#countdown").hidden = !p;
  // «завтра» у поля времени
  $("#tomorrow-flag").hidden = !state.serveTime ||
    resolveServeDate(state.serveTime, now).getDate() === now.getDate();
  if (!p) return;

  // сбросить notified для позиций, чей старт снова в будущем (спека: смена плана в середине готовки)
  for (const e of p.entries) if (e.status === "waiting") delete state.notified[e.id];
  if (now < p.serveAt) delete state.notified.__serve;

  const tl = $("#timeline");
  tl.textContent = "";
  for (const e of p.entries) {
    const li = document.createElement("li");
    li.className = `tl-${e.status}`;
    const overdueMin = Math.round((now - e.start) / 60_000);
    const label =
      e.status === "waiting" ? `старт в ${timeFmt.format(e.start)} · через ${fmtMin(e.start - now)}` :
      e.status === "due" ? (overdueMin > 1 ? `ставь сейчас · старт был ${overdueMin} мин назад` : "пора ставить") :
      e.status === "cooking" ? `в работе · с ${timeFmt.format(e.start)}` :
      "подано";
    li.innerHTML = `<span class="tl-time">${timeFmt.format(e.start)}</span>
      <span class="tl-name"></span><span class="tl-status">${label}</span>`;
    li.querySelector(".tl-name").textContent = `${e.name} · ${e.minutes} мин`;
    tl.append(li);
  }
  const left = p.serveAt - now;
  $("#countdown").textContent = left > 0
    ? `подача в ${timeFmt.format(p.serveAt)} · через ${fmtMin(left)}`
    : "подано";
  saveState();
}

function fmtMin(ms) {
  const total = Math.ceil(ms / 60_000);
  const h = Math.floor(total / 60), m = total % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

function tick() {
  renderTimeline(); // Task 4 добавит сюда звук и wake lock
}

$("#serve-time").addEventListener("input", (e) => {
  state.serveTime = e.target.value;
  saveState();
  renderTimeline();
});
$("#add-item").addEventListener("click", () => addItem());
$("#reset").addEventListener("click", () => {
  state = { serveTime: "", items: [], sound: state.sound, notified: {} };
  saveState();
  $("#serve-time").value = "";
  renderItems();
  renderTimeline();
});

// восстановление
$("#serve-time").value = state.serveTime;
renderItems();
renderTimeline();
setInterval(tick, 1000);
```

Примечание: `due` с `overdueMin > 1` — это и есть кейс «не успеваем» из спеки: позиция с прошедшим стартом получает `due` немедленно и держит его (с плашкой «ставь сейчас · старт был N мин назад»), пока не отработает авто-ack через минуту после первого показа.

- [ ] **Step 2: Проверить в браузере**

Сервер из Task 2 ещё жив. Открыть страницу, добавить «гусь · 180» и «картошка · 40», подачу через 2 минуты от текущего времени.
Expected: таймлайн отсортирован (гусь раньше), «ставь сейчас · старт был …» у гуся (старт в прошлом), отсчёт до подачи тикает раз в секунду, перезагрузка страницы восстанавливает план, «Сброс» очищает.

- [ ] **Step 3: Прогнать node-тесты (не сломали)**

Run: `node --test`
Expected: 8 pass

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: interactive timeline with live tick and persistence"
```

---

### Task 4: Звук и Wake Lock

**Files:**
- Modify: `app.js`

**Interfaces:**
- Consumes: `state.sound`, `state.notified`, `tick()` из Task 3.
- Produces: `beep()`, `syncWakeLock()`; бип на переходе `waiting → due` (однократно на id) и в момент подачи (ключ `__serve`).

- [ ] **Step 1: Добавить в app.js**

```js
// — звук: три коротких бипа осциллятором, AudioContext лениво по первому жесту
let audioCtx = null;
document.addEventListener("pointerdown", () => {
  if (!audioCtx) audioCtx = new AudioContext();
}, { once: true });

function beep() {
  if (!state.sound || !audioCtx) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, t0 + i * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + i * 0.35 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.35 + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + i * 0.35);
    osc.stop(t0 + i * 0.35 + 0.3);
  }
}

// — wake lock: экран не гаснет, пока есть активный план
let wakeLock = null;
async function syncWakeLock(active) {
  try {
    if (active && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!active && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {} // нет API или запрещено — работаем без него
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncWakeLock(!!plan());
});
```

В `renderTimeline()` после построения списка добавить бипы (внутри цикла уже есть статусы):

```js
  let shouldBeep = false;
  for (const e of p.entries) {
    if (e.status !== "waiting" && !state.notified[e.id]) {
      state.notified[e.id] = now.getTime(); // timestamp: от него считается авто-ack
      shouldBeep = true;
    }
  }
  if (now >= p.serveAt && !state.notified.__serve) {
    state.notified.__serve = now.getTime();
    shouldBeep = true;
  }
  if (shouldBeep) beep();
```

В `tick()` добавить `syncWakeLock(!!plan());`. Кнопка звука:

```js
$("#sound-toggle").addEventListener("click", () => {
  state.sound = !state.sound;
  saveState();
  renderSoundToggle();
});
function renderSoundToggle() {
  $("#sound-toggle").textContent = state.sound ? "звук вкл" : "звук выкл";
}
renderSoundToggle();
```

Бип по `status !== "waiting" && !notified` покрывает и «старт в прошлом при добавлении» (сразу cooking после окна due — всё равно один бип), и обычный переход в due. После перезагрузки страницы `notified` из localStorage не даёт бипать повторно.

- [ ] **Step 2: Проверить в браузере**

План с подачей через 2 минуты, позиция на 1 минуту (старт через минуту).
Expected: в момент старта — тройной бип и подсветка `due`; в момент подачи — бип и «подано»; тумблер «звук выкл» глушит; после перезагрузки страницы в середине — бипы не повторяются.

- [ ] **Step 3: node-тесты зелёные**

Run: `node --test`
Expected: 8 pass

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: stage beeps and screen wake lock"
```

---

### Task 5: PWA — manifest, иконка, service worker

**Files:**
- Create: `manifest.json`, `icon.svg`, `sw.js`
- Modify: `app.js` (регистрация SW), `index.html` (иконки в head, если не добавлены в Task 2)

**Interfaces:**
- Produces: устанавливаемая офлайн-PWA; кэш `kitchen-v1`.

- [ ] **Step 1: manifest.json**

```json
{
  "name": "Кухонный оркестратор",
  "short_name": "Кухня",
  "description": "Считает назад от времени подачи: что и когда ставить",
  "lang": "ru",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#F4F5F3",
  "theme_color": "#F4F5F3",
  "icons": [
    { "src": "./icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "./icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 2: icon.svg — конфорка**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#F4F5F3"/>
  <circle cx="256" cy="256" r="150" fill="none" stroke="#16181D" stroke-width="28"/>
  <circle cx="256" cy="256" r="96" fill="none" stroke="#FF4D1F" stroke-width="28"/>
  <circle cx="256" cy="256" r="40" fill="#16181D"/>
</svg>
```

- [ ] **Step 3: sw.js**

```js
const CACHE = "kitchen-v1";
const ASSETS = ["./", "./index.html", "./style.css", "./app.js", "./schedule.js",
  "./manifest.json", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
```

- [ ] **Step 4: Регистрация в app.js (в конец файла)**

```js
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}
```

И в `<head>` index.html: `<link rel="icon" href="./icon.svg" type="image/svg+xml">`, `<link rel="apple-touch-icon" href="./icon.svg">`.

- [ ] **Step 5: Проверить офлайн в браузере**

DevTools → Application: SW активен, manifest валиден (installable). Выключить сеть (DevTools offline) → перезагрузка → страница работает.
Expected: офлайн-загрузка ок, консоль чистая.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: installable offline pwa"
```

---

### Task 6: Полная браузерная проверка и фиксы

**Files:**
- Modify: по находкам

- [ ] **Step 1: Сквозной сценарий в браузере (Claude in Chrome)**

Реальный план: подача через 3 минуты; позиции «чай · 1», «бутерброд · 2», «суп · 5» (старт в прошлом). Проверить: сортировку, «ставь сейчас» у супа, бип чая через ~1 мин (см. консоль/подсветку), отсчёт, «подано» в конце, «Сброс», восстановление после перезагрузки, мобильный вьюпорт 390×844, отсутствие ошибок в консоли.

- [ ] **Step 2: Найденное — чинить сразу, тесты держать зелёными**

Run: `node --test`
Expected: 8 pass

- [ ] **Step 3: Commit (если были фиксы)**

```bash
git add -A && git commit -m "fix: правки по итогам браузерной проверки"
```

---

### Task 7: README, GitHub, Pages

**Files:**
- Create: `README.md`

- [ ] **Step 1: README.md**

```markdown
# Кухонный оркестратор

Вводишь блюда и время подачи — считает назад, что и когда ставить,
чтобы всё поспело к одному моменту. Пищит, когда пора. Работает офлайн.

собран за вечер · claude code + vanilla js · pwa

**Открыть: https://art-ps.github.io/kitchen-orchestrator/**

На телефоне: открыть ссылку → «Добавить на экран „Домой"» — дальше
работает как приложение, без сети.

## Как устроено

- `schedule.js` — чистый расчёт (старт = подача − длительность), покрыт тестами
- `app.js` — таймлайн, бипы Web Audio, Wake Lock (экран не гаснет)
- `sw.js` — офлайн-кэш
- Ноль зависимостей, ноль сборки. `node --test` гоняет тесты.

## Приватность

Всё живёт в localStorage браузера. Ничего никуда не отправляется.
```

- [ ] **Step 2: GitHub-репо + Pages**

```bash
cd ~/projects/kitchen-orchestrator
git add -A && git commit -m "docs: README"
gh repo create kitchen-orchestrator --public \
  --description "Считает назад от времени подачи: что и когда ставить" \
  --source=. --remote=origin --push
gh api -X POST repos/art-ps/kitchen-orchestrator/pages \
  -f 'source[branch]=main' -f 'source[path]=/'
```

- [ ] **Step 3: Проверить прод**

Подождать сборку Pages (`gh api repos/art-ps/kitchen-orchestrator/pages --jq .status` до `built`), открыть https://art-ps.github.io/kitchen-orchestrator/ в браузере: страница живая, SW регистрируется, manifest подхватывается под подпутём.

- [ ] **Step 4: Финальный коммит-пуш при фиксах**

```bash
git push
```
