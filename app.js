import { computeSchedule, resolveServeDate } from "./schedule.js";

const KEY = "kitchen-plan";
const DUE_WINDOW_MS = 60_000; // авто-подтверждение due через минуту после бипа

let state = loadState();

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.items)) {
      return { serveTime: "", sound: true, notified: {}, ...raw };
    }
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

function fmtMin(ms) {
  const total = Math.ceil(ms / 60_000);
  const h = Math.floor(total / 60), m = total % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

function renderTimeline() {
  const now = new Date();
  const p = plan(now);
  $("#hint").hidden = !!p;
  $("#timeline").hidden = !p;
  $("#countdown").hidden = !p;
  $("#tomorrow-flag").hidden = !state.serveTime ||
    resolveServeDate(state.serveTime, now).getDate() === now.getDate();
  syncWakeLock(!!p);
  if (!p) { saveState(); return; }

  // смена плана в середине готовки: старт снова в будущем — позиция снова бипнет
  for (const e of p.entries) if (e.status === "waiting") delete state.notified[e.id];
  if (now < p.serveAt) delete state.notified.__serve;

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

function renderSoundToggle() {
  $("#sound-toggle").textContent = state.sound ? "звук вкл" : "звук выкл";
}

function tick() {
  renderTimeline();
}

$("#serve-time").addEventListener("input", (e) => {
  state.serveTime = e.target.value;
  saveState();
  renderTimeline();
});
$("#add-item").addEventListener("click", () => addItem());
$("#sound-toggle").addEventListener("click", () => {
  state.sound = !state.sound;
  saveState();
  renderSoundToggle();
});
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
renderSoundToggle();
setInterval(tick, 1000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}
