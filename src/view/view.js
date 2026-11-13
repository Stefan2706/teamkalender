/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * TeamKalender – (c) Stefan Scherer, ts-scherer.com */
"use strict";
/* Ansicht „TeamKalender“ */

const api = messenger.sbsCalendar;
const t = (key, ...subs) => messenger.i18n.getMessage(key, subs.map(String)) || key;
const LOCALE = messenger.i18n.getUILanguage();
const DAY_MS = 86400000;
const MIN_MS = 60000;
const HOUR_MS = 3600000;
const SNAP_CREATE = 30;
const SNAP_DRAG = 15;
const ZOOM = { s: 36, m: 48, l: 64 };
const ROW_H = 44;
const LABEL_W = 220;
const MAX_CUSTOM = 14;

const fmtTime = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "numeric" });
const fmtLong = new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtShort = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" });
const fmtYear = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric" });
const fmtWeekday = new Intl.DateTimeFormat(LOCALE, { weekday: "short" });
const fmtMonth = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric" });
const PANELS = ["picker", "finder", "settings", "jump"];

const DEFAULT_SETTINGS = { workStart: 8, workEnd: 18, workDays: [1, 2, 3, 4, 5], duration: 60, zoom: "m", hidePrivate: true, roles: {}, colorBy: "category", tint: "medium" };

const state = {
  mode: "workweek",
  anchor: startOfDay(new Date()),
  calendars: [],
  selected: [],
  groups: [],
  items: [],
  overlay: false,
  overlayTarget: null,
  settings: { ...DEFAULT_SETTINGS },
  cols: [],
  free: null,        // Ergebnisse des Freie-Zeit-Finders
  customDays: [],    // per Strg-Klick gewählte Einzeltage (Zeitstempel)
  categories: new Map(), // Kategorie -> Farbe (aus Thunderbird)
  selectedEvent: null,
  wizardKnown: null,
  prevMode: "day",
  lastPicked: null,
  scroll: null,      // { key, top, left }
};

const $ = sel => document.querySelector(sel);
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- Datum ---------- */
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); }
function isToday(d) { return startOfDay(new Date()).getTime() === d.getTime(); }
function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  return Math.ceil(((x - Date.UTC(x.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7);
}
function visibleDays() {
  if (state.mode === "custom" && state.customDays.length) return state.customDays.map(ts => new Date(ts));
  if (state.mode === "day" || state.mode === "schedule") return [state.anchor];
  const monday = startOfWeek(state.anchor);
  const count = state.mode === "workweek" ? 5 : 7;
  return Array.from({ length: count }, (_, i) => addDays(monday, i));
}
const isWorkDay = d => state.settings.workDays.includes(d.getDay());
const hourPx = () => ZOOM[state.settings.zoom] || 48;
const hourW = () => Math.round(hourPx() * 1.75);
const snap = (m, step) => Math.round(m / step) * step;
const timeRange = (s, e) => `${fmtTime.format(new Date(s))}–${fmtTime.format(new Date(e))}`;

/* ---------- Hinweise ---------- */
let toastTimer;
function toast(msg) {
  const box = $("#toast");
  box.textContent = msg;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 4500);
}
function showError(msg) { const e = $("#error"); e.textContent = msg; e.hidden = !msg; }
const errText = e => String((e && e.message) || e);

/* ---------- Kalender und Rollen ---------- */
const calById = id => state.calendars.find(c => c.id === id);
const role = cal => state.settings.roles[cal.id] || "own";
function selectedCalendars() {
  return state.selected.map(calById).filter(Boolean);
}
// Zielkalender für neue Termine ohne festen Kalender (Überlagern, Freie-Zeit-Finder)
function defaultTarget(cals = selectedCalendars()) {
  const writable = cals.filter(c => !c.readOnly && role(c) !== "room");
  return writable.find(c => c.id === state.overlayTarget)
    || writable.find(c => role(c) === "own")
    || writable[0] || null;
}
// Darstellung unter Berücksichtigung privater Termine
function display(it) {
  const cal = calById(it.calendarId);
  const masked = state.settings.hidePrivate && cal && role(cal) === "colleague"
    && (it.privacy === "PRIVATE" || it.privacy === "CONFIDENTIAL");
  return masked ? { title: t("privateEvent"), location: "", masked: true } : { title: it.title, location: it.location, masked: false };
}

/* ---------- Speicher ---------- */
function persist() {
  return messenger.storage.local.set({
    selected: state.selected, groups: state.groups, mode: state.mode,
    customDays: state.customDays, prevMode: state.prevMode,
    overlay: state.overlay, overlayTarget: state.overlayTarget, settings: state.settings,
  });
}

/* ---------- Laden ---------- */
async function loadCalendars() {
  state.calendars = await api.getCalendars();
  try {
    state.categories = new Map((await api.getCategories()).filter(c => c.color).map(c => [c.name, c.color]));
  } catch (e) {
    state.categories = new Map();
  }
}
// Lesbare Schriftfarbe auf kräftigem Hintergrund
function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#1d232b" : "#ffffff";
}
// Farbe eines Termins: Kategorie (wie Outlook) oder Kalender
function itemColor(it) {
  if (state.settings.colorBy === "category") {
    const c = (it.categories || []).map(n => state.categories.get(n)).find(Boolean);
    if (c) return c;
  }
  const cal = calById(it.calendarId);
  return cal ? cal.color : "#3b82f6";
}

async function refresh() {
  const days = visibleDays();
  const cals = selectedCalendars();
  try {
    state.items = cals.length
      ? await api.getItems(cals.map(c => c.id), days[0].toISOString(), addDays(days[days.length - 1], 1).toISOString())
      : [];
    showError("");
  } catch (e) {
    state.items = [];
    showError(t("loadError", errText(e)));
  }
  if (state.free) runFinder(false);
  render();
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadCalendars();
    if (state.wizardKnown) {
      const added = state.calendars.filter(c => !state.wizardKnown.has(c.id));
      if (added.length) {
        state.selected.push(...added.map(c => c.id));
        state.wizardKnown = null;
        persist();
        toast(t("calendarsAdded", added.length));
      }
    }
    renderPicker();
    await refresh();
  }, 500);
}

/* ---------- Werkzeugleiste ---------- */
function renderLabel(days) {
  const first = days[0];
  const last = days[days.length - 1];
  let text;
  const contiguous = days.every((d, i) => i === 0 || d.getTime() === addDays(days[i - 1], 1).getTime());
  if (days.length === 1) text = fmtLong.format(first);
  else if (state.mode === "custom" && !contiguous) text = days.map(d => fmtDay.format(d)).join(", ");
  else {
    const range = first.getFullYear() === last.getFullYear()
      ? `${fmtShort.format(first)} – ${fmtYear.format(last)}`
      : `${fmtYear.format(first)} – ${fmtYear.format(last)}`;
    text = `${t("week", String(isoWeek(first)))}, ${range}`;
  }
  $("#label").textContent = text;
  for (const b of document.querySelectorAll(".modes button")) {
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(b.dataset.mode === state.mode));
  }
  const ov = $("#overlay");
  ov.setAttribute("aria-pressed", String(state.overlay));
  ov.disabled = state.mode === "schedule";
}

function renderPicker() {
  const list = $("#calList");
  list.textContent = "";
  const ordered = [...selectedCalendars(), ...state.calendars.filter(c => !state.selected.includes(c.id))];
  for (const c of ordered) {
    const li = el("li");
    const label = el("label");
    const box = el("input", { type: "checkbox" });
    box.checked = state.selected.includes(c.id);
    box.addEventListener("change", () => {
      if (box.checked) state.selected.push(c.id);
      else state.selected = state.selected.filter(id => id !== c.id);
      $("#group").value = "";
      persist();
      renderPicker();
      refresh();
    });
    const sw = el("span", { class: "swatch" });
    sw.style.background = c.color;
    label.append(box, sw, el("span", { class: "name" }, c.name));
    if (role(c) === "room") label.append(el("span", { class: "badge" }, t("roleRoom")));
    if (c.readOnly) label.append(el("span", { class: "badge" }, "🔒"));
    li.append(label);
    const idx = state.selected.indexOf(c.id);
    if (idx >= 0) {
      const mk = (txt, title, delta) => {
        const b = el("button", { title, "aria-label": title }, txt);
        b.disabled = idx + delta < 0 || idx + delta >= state.selected.length;
        b.addEventListener("click", () => {
          const s = state.selected;
          [s[idx], s[idx + delta]] = [s[idx + delta], s[idx]];
          persist();
          renderPicker();
          render();
        });
        return b;
      };
      li.append(mk("↑", t("up"), -1), mk("↓", t("down"), 1));
    }
    list.append(li);
  }
}

function renderGroups() {
  const sel = $("#group");
  const current = sel.value;
  sel.textContent = "";
  sel.append(el("option", { value: "" }, t("groupNone")));
  state.groups.forEach((g, i) => sel.append(el("option", { value: String(i) }, g.name)));
  sel.value = current && state.groups[current] ? current : "";
  $("#groupDelete").hidden = sel.value === "";
}

function renderSettings() {
  const s = state.settings;
  const box = $("#settings");
  box.textContent = "";
  const apply = () => { persist(); applyZoom(); renderPicker(); render(); };
  const hourSelect = (value, onChange) => {
    const sel = el("select");
    for (let h = 0; h <= 24; h++) sel.append(el("option", { value: String(h) }, `${String(h).padStart(2, "0")}:00`));
    sel.value = String(value);
    sel.addEventListener("change", () => onChange(Number(sel.value)));
    return sel;
  };

  const fb = el("a", { href: "#", class: "feedback" }, t("feedback"));
  fb.addEventListener("click", e => { e.preventDefault(); openUrl("https://github.com/Stefan2706/teamkalender/issues"); });
  box.append(fb, el("p", { class: "note" }, `${t("extensionName")} ${messenger.runtime.getManifest().version} · MPL 2.0 · ts-scherer.com`));

  const theme = el("label", { class: "check" });
  const tcb = el("input", { type: "checkbox" });
  messenger.storage.local.get("outlookTheme").then(r => { tcb.checked = r.outlookTheme !== false; });
  tcb.addEventListener("change", () => messenger.storage.local.set({ outlookTheme: tcb.checked }));
  theme.append(tcb, el("span", {}, t("setTheme")));
  box.append(theme);

  box.append(el("h2", {}, t("setWork")));
  const work = el("div", { class: "row" });
  work.append(
    hourSelect(s.workStart, v => { s.workStart = Math.min(v, s.workEnd - 1); apply(); renderSettings(); }),
    el("span", {}, t("setTo")),
    hourSelect(s.workEnd, v => { s.workEnd = Math.max(v, s.workStart + 1); apply(); renderSettings(); }),
  );
  box.append(work);

  box.append(el("h2", {}, t("setDays")));
  const days = el("div", { class: "days" });
  for (const wd of [1, 2, 3, 4, 5, 6, 0]) {
    const lbl = el("label");
    const cb = el("input", { type: "checkbox" });
    cb.checked = s.workDays.includes(wd);
    cb.addEventListener("change", () => {
      s.workDays = cb.checked ? [...s.workDays, wd] : s.workDays.filter(d => d !== wd);
      apply();
    });
    lbl.append(cb, document.createTextNode(fmtWeekday.format(new Date(2024, 0, wd === 0 ? 7 : wd))));
    days.append(lbl);
  }
  box.append(days);

  box.append(el("h2", {}, t("setDuration")));
  const dur = el("select");
  for (const m of [15, 30, 45, 60, 90, 120]) dur.append(el("option", { value: String(m) }, t("minutes", m)));
  dur.value = String(s.duration);
  dur.addEventListener("change", () => { s.duration = Number(dur.value); apply(); });
  box.append(dur);

  box.append(el("h2", {}, t("setColorBy")));
  const colorBy = el("select");
  for (const [v, key] of [["category", "colorByCategory"], ["calendar", "colorByCalendar"]]) colorBy.append(el("option", { value: v }, t(key)));
  colorBy.value = s.colorBy || "category";
  colorBy.addEventListener("change", () => { s.colorBy = colorBy.value; apply(); });
  box.append(colorBy);

  box.append(el("h2", {}, t("setTint")));
  const tint = el("select");
  for (const [k, key] of [["soft", "tintSoft"], ["medium", "tintMedium"], ["full", "tintFull"]]) tint.append(el("option", { value: k }, t(key)));
  tint.value = s.tint || "medium";
  tint.addEventListener("change", () => { s.tint = tint.value; apply(); });
  box.append(tint);

  box.append(el("h2", {}, t("setZoom")));
  const zoom = el("select");
  for (const [k, key] of [["s", "zoomS"], ["m", "zoomM"], ["l", "zoomL"]]) zoom.append(el("option", { value: k }, t(key)));
  zoom.value = s.zoom;
  zoom.addEventListener("change", () => { s.zoom = zoom.value; state.scroll = null; apply(); });
  box.append(zoom);

  const priv = el("label", { class: "check" });
  const pcb = el("input", { type: "checkbox" });
  pcb.checked = s.hidePrivate;
  pcb.addEventListener("change", () => { s.hidePrivate = pcb.checked; apply(); });
  priv.append(pcb, el("span", {}, t("setPrivate")));
  priv.style.marginTop = "14px";
  box.append(priv);

  box.append(el("h2", {}, t("setRoles")));
  const roles = el("ul", { class: "roles" });
  for (const c of state.calendars) {
    const li = el("li");
    const sw = el("span", { class: "swatch" });
    sw.style.background = c.color;
    const sel = el("select");
    for (const [v, key] of [["own", "roleOwn"], ["colleague", "roleColleague"], ["room", "roleRoom"]]) sel.append(el("option", { value: v }, t(key)));
    sel.value = role(c);
    sel.addEventListener("change", () => {
      if (sel.value === "own") delete s.roles[c.id]; else s.roles[c.id] = sel.value;
      apply();
      updateFinderControls();
    });
    li.append(sw, el("span", { class: "name", title: c.name }, c.name), sel);
    roles.append(li);
  }
  box.append(roles);
}

function applyZoom() {
  document.documentElement.style.setProperty("--tint", { soft: "22%", medium: "40%", full: "40%" }[state.settings.tint] || "40%");
  document.documentElement.dataset.tint = state.settings.tint || "medium";
  document.documentElement.style.setProperty("--hour", `${hourPx()}px`);
  document.documentElement.style.setProperty("--hourw", `${hourW()}px`);
}

/* ---------- Gemeinsame Bausteine ---------- */
function layoutLanes(events) {
  events.sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const lanes = [];
    for (const ev of cluster) {
      let lane = lanes.findIndex(end => end <= ev.s);
      if (lane < 0) { lane = lanes.length; lanes.push(ev.e); } else lanes[lane] = ev.e;
      ev.lane = lane;
    }
    for (const ev of cluster) ev.lanes = lanes.length;
    out.push(...cluster);
    cluster = [];
  };
  for (const ev of events) {
    if (cluster.length && ev.s >= clusterEnd) { flush(); clusterEnd = -Infinity; }
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.e);
  }
  if (cluster.length) flush();
  return out;
}

function timedSegments(items, dayStart, dayEnd) {
  return items
    .filter(x => !x.allDay)
    .map(it => ({ it, s: Math.max(it.start, dayStart), e: Math.min(Math.max(it.end, it.start + 15 * MIN_MS), dayEnd) }));
}

function openItem(it) {
  if (display(it).masked) { toast(t("privateBlocked")); return; }
  api.openItem(it.calendarId, it.id, it.recurrenceId || "").catch(e => toast(t("openError", errText(e))));
}

// Termin-Kasten; axis "y" = Tag/Woche, "x" = Zeitplan
function eventBox(seg, dayStart, axis) {
  const { it } = seg;
  const cal = calById(it.calendarId);
  const shown = display(it);
  const box = el("div", { class: "ev" + (it.status === "CANCELLED" ? " cancelled" : "") + (shown.masked ? " masked" : "") + ` sa-${it.showAs || "busy"}` + (isSelected(it) ? " selected" : "") });
  box.style.setProperty("--c", itemColor(it));
  box.style.setProperty("--ct", contrastText(itemColor(it)) || "inherit");
  if (axis === "y") {
    const heightPx = Math.max(18, ((seg.e - seg.s) / HOUR_MS) * hourPx() - 2);
    // Kurze Termine einzeilig wie in Outlook: Titel zuerst, Uhrzeit dahinter
    if (heightPx < 44) box.classList.add("compact");
    if (heightPx < 20) box.classList.add("tiny");
    Object.assign(box.style, {
      top: `${((seg.s - dayStart) / HOUR_MS) * hourPx()}px`,
      height: `${heightPx}px`,
      left: `calc(${(seg.lane * 100) / seg.lanes}% + 2px)`,
      width: `calc(${100 / seg.lanes}% - 4px)`,
    });
  } else {
    const h = (ROW_H - 8) / seg.lanes;
    Object.assign(box.style, {
      left: `${((seg.s - dayStart) / HOUR_MS) * hourW()}px`,
      width: `${Math.max(14, ((seg.e - seg.s) / HOUR_MS) * hourW() - 2)}px`,
      top: `${5 + seg.lane * h}px`,
      height: `${h - 2}px`,
    });
  }
  const when = timeRange(it.start, it.end);
  const tip = [when, shown.title, shown.location];
  if (state.overlay || axis === "x") tip.push(cal.name);
  box.title = tip.filter(Boolean).join("\n");
  box.append(el("div", { class: "tm" }, when), el("div", { class: "ti" }, shown.title));
  if (shown.location && axis === "y") box.append(el("div", { class: "lo" }, shown.location));
  const grip = el("div", { class: "grip" });
  box.append(grip);

  bindItemEvents(box, it);
  box.addEventListener("pointerdown", e => beginEventDrag(e, it, box, "move"));
  grip.addEventListener("pointerdown", e => beginEventDrag(e, it, box, "resize"));
  return box;
}

function freeSlotsFor(dayStart, dayEnd, cal) {
  if (!state.free) return [];
  return state.free.slots.filter(sl => sl.start < dayEnd && sl.end > dayStart
    && (!sl.room || !cal || role(cal) !== "room" || sl.room === cal.id));
}

// Kalender per × aus der Ansicht nehmen (bleibt in Thunderbird erhalten)
function hideCalendar(cal) {
  state.selected = state.selected.filter(id => id !== cal.id);
  $("#group").value = "";
  $("#groupDelete").hidden = true;
  persist();
  renderPicker();
  refresh();
  toast(t("calendarHidden", cal.name));
}
function closeButton(cal) {
  const b = el("button", { class: "x", type: "button", title: t("hideCalendar"), "aria-label": `${t("hideCalendar")}: ${cal.name}` }, "×");
  b.addEventListener("pointerdown", e => e.stopPropagation());
  b.addEventListener("click", e => { e.stopPropagation(); hideCalendar(cal); });
  return b;
}

/* ---------- Darstellung ---------- */
function render() {
  const days = visibleDays();
  const cals = selectedCalendars();
  renderLabel(days);
  const scroller = $("#scroller");
  const grid = $("#grid");
  const key = `${state.mode}|${state.settings.zoom}`;
  if (grid.firstChild && state.scroll && state.scroll.key === key) {
    state.scroll.top = scroller.scrollTop;
    state.scroll.left = scroller.scrollLeft;
  } else if (grid.firstChild) {
    state.scroll = null;
  }
  grid.textContent = "";
  state.cols = [];

  if (!state.calendars.length) { grid.append(el("p", { class: "empty" }, t("noCalendarsAtAll"))); return; }
  if (!cals.length) { grid.append(el("p", { class: "empty" }, t("noCalendars"))); return; }

  if (state.mode === "schedule") renderSchedule(cals, days[0]);
  else renderGrid(days, cals);

  if (state.scroll && state.scroll.key === key) {
    scroller.scrollTop = state.scroll.top;
    scroller.scrollLeft = state.scroll.left;
  } else if (state.mode === "schedule") {
    scroller.scrollTop = 0;
    scroller.scrollLeft = Math.max(0, state.settings.workStart * hourW() - 20);
  } else {
    scroller.scrollLeft = 0;
    scroller.scrollTop = Math.max(0, state.settings.workStart * hourPx() - 12);
  }
  state.scroll = { key, top: scroller.scrollTop, left: scroller.scrollLeft };
}

function renderGrid(days, cals) {
  const groups = state.overlay ? [{ cals, overlay: true }] : cals.map(c => ({ cals: [c], overlay: false }));
  const cols = [];
  for (const g of groups) {
    const target = g.overlay ? defaultTarget(g.cals) : g.cals[0];
    days.forEach((d, i) => cols.push({ day: d, first: i === 0, cals: g.cals, overlay: g.overlay, target, ids: new Set(g.cals.map(c => c.id)) }));
  }
  state.cols = cols;
  const hp = hourPx();
  const minCol = days.length === 1 || state.overlay ? 180 : 110;
  const template = `var(--gutter) repeat(${cols.length}, minmax(${minCol}px, 1fr))`;
  const minWidth = `calc(var(--gutter) + ${cols.length * minCol}px)`;

  const head = el("div", { class: "head" });
  Object.assign(head.style, { gridTemplateColumns: template, minWidth });
  head.append(el("div", { class: "corner" }, t("allDay")));
  groups.forEach((g, i) => {
    const span = `${2 + i * days.length} / span ${days.length}`;
    if (!g.overlay) {
      const c = g.cals[0];
      const h = el("div", { class: "calhead", title: c.name });
      h.append(el("span", { class: "name" }, c.name + (c.readOnly ? " 🔒" : "")), closeButton(c));
      h.style.setProperty("--c", c.color);
      h.style.gridColumn = span;
      head.append(h);
      return;
    }
    const legend = el("div", { class: "legend", title: t("overlayTitle") });
    legend.style.gridColumn = span;
    const target = defaultTarget(g.cals);
    for (const c of g.cals) {
      const b = el("button", { type: "button" });
      const sw = el("span", { class: "swatch" });
      sw.style.background = c.color;
      b.append(sw, document.createTextNode(c.name + (c.readOnly ? " 🔒" : "")));
      b.setAttribute("aria-current", String(!!target && target.id === c.id));
      b.addEventListener("click", () => {
        if (c.readOnly || role(c) === "room") { toast(t("readOnly", c.name)); return; }
        state.overlayTarget = c.id;
        persist();
        render();
      });
      const wrap = el("span", { class: "legend-item" });
      wrap.append(b, closeButton(c));
      legend.append(wrap);
    }
    head.append(legend);
  });

  const body = el("div", { class: "body" });
  Object.assign(body.style, { gridTemplateColumns: template, minWidth, height: `${24 * hp}px` });
  const gutter = el("div", { class: "gutter" });
  for (let h = 1; h < 24; h++) {
    const lbl = el("span", {}, fmtTime.format(new Date(2000, 0, 1, h)));
    lbl.style.top = `${h * hp}px`;
    gutter.append(lbl);
  }
  body.append(gutter);

  const now = Date.now();
  const { workStart, workEnd } = state.settings;
  cols.forEach((col, i) => {
    const gridCol = String(i + 2);
    const dayStart = col.day.getTime();
    const dayEnd = addDays(col.day, 1).getTime();
    const today = isToday(col.day);
    const extra = (col.first ? " calstart" : "") + (today ? " today" : "");

    const dh = el("div", { class: "dayhead" + extra }, fmtDay.format(col.day));
    dh.style.gridColumn = gridCol;
    head.append(dh);

    const mine = state.items.filter(it => col.ids.has(it.calendarId) && it.start < dayEnd && it.end > dayStart);
    const ad = el("div", { class: "allday" + extra });
    ad.style.gridColumn = gridCol;
    for (const it of mine.filter(x => x.allDay)) {
      const shown = display(it);
      const chip = el("div", { class: "chip" + (it.status === "CANCELLED" ? " cancelled" : "") + ` sa-${it.showAs || "busy"}`, title: shown.title }, shown.title);
      chip.style.setProperty("--c", itemColor(it));
      chip.style.setProperty("--ct", contrastText(itemColor(it)) || "inherit");
      bindItemEvents(chip, it);
      ad.append(chip);
    }
    head.append(ad);

    const colEl = el("div", { class: "col" + extra + (!col.target || col.target.readOnly ? " readonly" : "") });
    colEl.style.gridColumn = gridCol;
    colEl.dataset.drop = "col";
    colEl.dataset.idx = String(i);
    colEl.addEventListener("pointerdown", e => beginCreateDrag(e, colEl));

    // Zeiten außerhalb der Arbeitszeit
    const offRanges = isWorkDay(col.day) ? [[0, workStart], [workEnd, 24]] : [[0, 24]];
    for (const [a, b] of offRanges) {
      if (b <= a) continue;
      const off = el("div", { class: "off" });
      Object.assign(off.style, { top: `${a * hp}px`, height: `${(b - a) * hp}px` });
      colEl.append(off);
    }
    for (const sl of freeSlotsFor(dayStart, dayEnd, col.overlay ? null : col.cals[0])) {
      const band = el("div", { class: "freeband" });
      Object.assign(band.style, { top: `${((sl.start - dayStart) / HOUR_MS) * hp}px`, height: `${((sl.end - sl.start) / HOUR_MS) * hp}px` });
      colEl.append(band);
    }
    for (const seg of layoutLanes(timedSegments(mine, dayStart, dayEnd))) colEl.append(eventBox(seg, dayStart, "y"));
    if (today) {
      const line = el("div", { class: "now" });
      line.style.top = `${((now - dayStart) / HOUR_MS) * hp}px`;
      colEl.append(line);
    }
    body.append(colEl);
  });
  $("#grid").append(head, body);
}

function renderSchedule(cals, day) {
  const hw = hourW();
  const width = 24 * hw;
  const dayStart = day.getTime();
  const dayEnd = addDays(day, 1).getTime();
  const people = cals.filter(c => role(c) !== "room");
  const rooms = cals.filter(c => role(c) === "room");
  const { workStart, workEnd } = state.settings;

  const wrap = el("div", { class: "sched" });
  wrap.style.gridTemplateColumns = `${LABEL_W}px ${width}px`;
  wrap.style.width = `${LABEL_W + width}px`;
  wrap.append(el("div", { class: "s-corner" }, fmtDay.format(day)));
  const hours = el("div", { class: "s-hours" });
  for (let h = 0; h < 24; h++) {
    const s = el("span", {}, fmtTime.format(new Date(2000, 0, 1, h)));
    s.style.left = `${h * hw}px`;
    hours.append(s);
  }
  wrap.append(hours);

  const row = c => {
    const label = el("div", { class: "s-label", title: c.name });
    const sw = el("span", { class: "swatch" });
    sw.style.background = c.color;
    label.append(sw, el("span", { class: "name" }, c.name + (c.readOnly ? " 🔒" : "")), closeButton(c));
    label.style.height = `${ROW_H}px`;

    const track = el("div", { class: "track" + (isToday(day) ? " today" : "") + (c.readOnly ? " readonly" : "") });
    track.style.height = `${ROW_H}px`;
    track.dataset.drop = "track";
    track.dataset.cal = c.id;
    track.addEventListener("pointerdown", e => beginCreateDrag(e, track));

    const offRanges = isWorkDay(day) ? [[0, workStart], [workEnd, 24]] : [[0, 24]];
    for (const [a, b] of offRanges) {
      if (b <= a) continue;
      const off = el("div", { class: "off" });
      Object.assign(off.style, { left: `${a * hw}px`, width: `${(b - a) * hw}px` });
      track.append(off);
    }
    for (const sl of freeSlotsFor(dayStart, dayEnd, c)) {
      const band = el("div", { class: "freeband" });
      Object.assign(band.style, { left: `${((sl.start - dayStart) / HOUR_MS) * hw}px`, width: `${((sl.end - sl.start) / HOUR_MS) * hw}px` });
      track.append(band);
    }
    const mine = state.items.filter(it => it.calendarId === c.id && it.start < dayEnd && it.end > dayStart);
    if (mine.some(x => x.allDay)) {
      const bar = el("div", { class: "s-allday" });
      bar.style.setProperty("--c", c.color);
      label.title = [c.name, ...mine.filter(x => x.allDay).map(x => display(x).title)].join("\n");
      track.append(bar);
    }
    for (const seg of layoutLanes(timedSegments(mine, dayStart, dayEnd))) track.append(eventBox(seg, dayStart, "x"));
    if (isToday(day)) {
      const line = el("div", { class: "now-x" });
      line.style.left = `${((Date.now() - dayStart) / HOUR_MS) * hw}px`;
      track.append(line);
    }
    wrap.append(label, track);
  };
  const section = (title, list) => {
    if (!list.length) return;
    if (rooms.length) wrap.append(el("div", { class: "s-section" }, title), el("div", { class: "s-sectionfill" }));
    list.forEach(row);
  };
  section(t("people"), people);
  section(t("rooms"), rooms);
  $("#grid").append(wrap);
}

/* ---------- Ziehen: Termine anlegen, verschieben, kopieren ---------- */
let drag = null;
let suppressClick = false;

function describeTarget(node) {
  if (!node) return null;
  if (node.dataset.drop === "col") {
    const col = state.cols[Number(node.dataset.idx)];
    return { node, axis: "y", day: col.day, cal: col.overlay ? null : col.target, createCal: col.target };
  }
  const cal = calById(node.dataset.cal);
  return { node, axis: "x", day: state.anchor, cal, createCal: cal };
}
function targetAt(x, y) {
  const n = document.elementFromPoint(x, y);
  return describeTarget(n && n.closest("[data-drop]"));
}
function minutesAt(target, x, y) {
  const r = target.node.getBoundingClientRect();
  return target.axis === "y" ? ((y - r.top) / hourPx()) * 60 : ((x - r.left) / hourW()) * 60;
}
function placeGhost(target, start, end, color, text) {
  if (!drag.ghost) drag.ghost = el("div", { class: "ghost" });
  const g = drag.ghost;
  if (color) g.style.setProperty("--c", color);
  if (g.parentElement !== target.node) target.node.append(g);
  const dayStart = target.day.getTime();
  const visEnd = Math.min(end, dayStart + DAY_MS);
  if (target.axis === "y") {
    Object.assign(g.style, { top: `${((start - dayStart) / HOUR_MS) * hourPx()}px`, height: `${Math.max(18, ((visEnd - start) / HOUR_MS) * hourPx() - 2)}px`, left: "2px", width: "calc(100% - 4px)" });
  } else {
    Object.assign(g.style, { left: `${((start - dayStart) / HOUR_MS) * hourW()}px`, width: `${Math.max(14, ((visEnd - start) / HOUR_MS) * hourW() - 2)}px`, top: "5px", height: `${ROW_H - 10}px` });
  }
  g.textContent = `${timeRange(start, end)} ${text || ""}`;
}
function startDragging() {
  drag.started = true;
  document.body.classList.add("is-dragging");
}
function endDragging() {
  document.body.classList.remove("is-dragging");
  if (drag && drag.ghost) drag.ghost.remove();
  if (drag && drag.box) drag.box.classList.remove("dragging");
}

function beginCreateDrag(e, node) {
  if (e.button !== 0 || e.target.closest(".ev")) return;
  e.preventDefault();
  const origin = describeTarget(node);
  drag = { kind: "create", origin, x0: e.clientX, y0: e.clientY, started: false, ghost: null,
    anchorMin: Math.floor(minutesAt(origin, e.clientX, e.clientY) / SNAP_CREATE) * SNAP_CREATE, range: null };
}

function beginEventDrag(e, it, box, mode) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const origin = describeTarget(box.parentElement);
  drag = { kind: "event", mode, it, box, origin, x0: e.clientX, y0: e.clientY, started: false, ghost: null,
    grabMin: minutesAt(origin, e.clientX, e.clientY) - (it.start - origin.day.getTime()) / MIN_MS, result: null };
}

function onPointerMove(e) {
  if (!drag) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
    if (drag.kind === "event") {
      const cal = calById(drag.it.calendarId);
      if (cal.readOnly && !e.ctrlKey) { toast(t("readOnly", cal.name)); drag = null; return; }
      drag.box.classList.add("dragging");
    } else if (!drag.origin.createCal || drag.origin.createCal.readOnly) {
      drag = null;
      return;
    }
    startDragging();
  }

  if (drag.kind === "create") {
    const o = drag.origin;
    const cur = Math.max(0, Math.min(1440, snap(minutesAt(o, e.clientX, e.clientY), SNAP_CREATE)));
    let a = Math.min(drag.anchorMin, cur);
    let b = Math.max(drag.anchorMin + SNAP_CREATE, cur);
    const dayStart = o.day.getTime();
    drag.range = { start: dayStart + a * MIN_MS, end: dayStart + b * MIN_MS };
    placeGhost(o, drag.range.start, drag.range.end, o.createCal.color, "");
    return;
  }

  const duration = drag.it.end - drag.it.start;
  const target = drag.mode === "move" ? targetAt(e.clientX, e.clientY) || drag.lastTarget || drag.origin : drag.origin;
  drag.lastTarget = target;
  const dayStart = target.day.getTime();
  let start;
  let end;
  if (drag.mode === "move") {
    const m = Math.max(0, Math.min(1440 - SNAP_DRAG, snap(minutesAt(target, e.clientX, e.clientY) - drag.grabMin, SNAP_DRAG)));
    start = dayStart + m * MIN_MS;
    end = start + duration;
  } else {
    start = drag.it.start;
    end = Math.max(start + SNAP_DRAG * MIN_MS, dayStart + snap(minutesAt(target, e.clientX, e.clientY), SNAP_DRAG) * MIN_MS);
  }
  drag.result = { start, end, target };
  const color = target.cal && target.cal.id !== drag.it.calendarId ? target.cal.color : itemColor(drag.it);
  placeGhost(target, start, end, color, (e.ctrlKey ? "＋ " : "") + display(drag.it).title);
}

async function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  endDragging();
  drag = null;

  if (d.kind === "create") {
    const cal = d.origin.createCal;
    if (!cal || cal.readOnly) {
      const name = (cal || d.origin.cal || selectedCalendars()[0] || {}).name || "";
      if (!d.started) toast(cal || d.origin.cal ? t("readOnly", name) : t("noTarget"));
      return;
    }
    let { start, end } = d.range || {};
    if (!d.started) {
      start = d.origin.day.getTime() + d.anchorMin * MIN_MS;
      end = start + state.settings.duration * MIN_MS;
    }
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    api.createItem(cal.id, new Date(start).toISOString(), new Date(end).toISOString())
      .catch(err => toast(t("openError", errText(err))));
    return;
  }

  if (!d.started || !d.result) return;
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
  const { start, end, target } = d.result;
  const it = d.it;
  const copy = e.ctrlKey;
  const targetCal = target.cal || calById(it.calendarId);
  if (!copy && start === it.start && end === it.end && targetCal.id === it.calendarId) return;
  if (targetCal.readOnly) { toast(t("readOnly", targetCal.name)); return; }
  const isoS = new Date(start).toISOString();
  const isoE = new Date(end).toISOString();
  try {
    if (copy) {
      await api.copyItem(it.calendarId, it.id, it.recurrenceId || "", targetCal.id, isoS, isoE);
      toast(t("copied"));
    } else {
      await api.moveItem(it.calendarId, it.id, it.recurrenceId || "", targetCal.id, isoS, isoE);
      toast(t(it.attendees > 0 ? "movedMeeting" : "moved"));
    }
  } catch (err) {
    toast(t("moveError", errText(err)));
  }
  await refresh();
}

window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", () => { endDragging(); drag = null; });

/* ---------- Auswahl, Vorschau und Kontextmenü ---------- */
const sameItem = (a, b) => a && b && a.id === b.id && a.calendarId === b.calendarId && (a.recurrenceId || "") === (b.recurrenceId || "");
const isSelected = it => sameItem(state.selectedEvent, it);

function selectItem(it, node) {
  state.selectedEvent = it;
  for (const n of document.querySelectorAll(".ev.selected, .chip.selected")) n.classList.remove("selected");
  if (node) node.classList.add("selected");
}

function bindItemEvents(node, it) {
  node.addEventListener("click", e => {
    e.stopPropagation();
    if (suppressClick) return;
    selectItem(it, node);
    showPreview(it, node);
  });
  node.addEventListener("dblclick", e => {
    e.stopPropagation();
    hidePreview();
    openItem(it);
  });
  node.addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    selectItem(it, node);
    hidePreview();
    showMenu(it, e.clientX, e.clientY);
  });
}

const MEETING_RE = /https?:\/\/[^\s<>"']*(?:jitsi|meet\.|\/call\/|talk|teams\.microsoft|teams\.live|zoom\.us|webex|bigbluebutton|bbb\.|whereby|meet\.google|gotomeeting|goto\.com|alfaview|senfcall|opentalk)[^\s<>"']*/i;
const URL_RE = /https?:\/\/[^\s<>"']+/i;
function meetingLink(d) {
  for (const text of [d.location, d.url, d.description]) {
    const m = (text || "").match(MEETING_RE);
    if (m) return m[0].replace(/[).,;]+$/, "");
  }
  return "";
}
const openUrl = url => messenger.windows.openDefaultBrowser(url).catch(() => window.open(url, "_blank"));

function placePopover(box, anchor, x, y) {
  box.hidden = false;
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y };
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  let left = r.right + 8;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 8);
  let top = Math.min(Math.max(8, r.top), window.innerHeight - h - 8);
  Object.assign(box.style, { left: `${left}px`, top: `${Math.max(8, top)}px` });
}

let previewToken = 0;
async function showPreview(it, anchor) {
  const box = $("#preview");
  if (display(it).masked) { hidePreview(); toast(t("privateBlocked")); return; }
  const token = ++previewToken;
  let d;
  try {
    d = await api.getItemDetails(it.calendarId, it.id, it.recurrenceId || "");
  } catch (e) {
    toast(t("openError", errText(e)));
    return;
  }
  if (token !== previewToken) return;
  const cal = calById(it.calendarId);
  box.textContent = "";
  box.style.setProperty("--c", itemColor(d));

  const head = el("div", { class: "pv-head" });
  head.append(el("h3", {}, d.title || "–"));
  const close = el("button", { class: "icon pv-close", title: t("close"), "aria-label": t("close") }, "×");
  close.addEventListener("click", hidePreview);
  head.append(close);
  box.append(head);

  const when = d.allDay
    ? `${fmtLong.format(new Date(d.start))} · ${t("allDay")}`
    : `${fmtLong.format(new Date(d.start))} · ${timeRange(d.start, d.end)}`;
  box.append(el("p", { class: "pv-when" }, when + (d.recurring ? ` · ${t("recurring")}` : "")));

  const meeting = meetingLink(d);
  if (meeting) {
    const join = el("button", { class: "primary pv-join" }, `▶ ${t("join")}`);
    join.addEventListener("click", () => openUrl(meeting));
    box.append(join);
  }

  const meta = el("dl", { class: "pv-meta" });
  const row = (label, node) => { meta.append(el("dt", {}, label)); const dd = el("dd"); dd.append(node); meta.append(dd); };
  if (d.location) {
    const loc = URL_RE.test(d.location) ? el("a", { href: "#" }, d.location) : document.createTextNode(d.location);
    if (loc.tagName === "A") loc.addEventListener("click", e => { e.preventDefault(); openUrl(d.location.match(URL_RE)[0]); });
    row(t("location"), loc);
  }
  const calNode = el("span");
  const sw = el("span", { class: "swatch" });
  sw.style.background = cal.color;
  calNode.append(sw, document.createTextNode(" " + cal.name));
  row(t("calendar"), calNode);
  row(t("showAs"), document.createTextNode(t("show_" + (d.showAs || "busy"))));
  if (d.categories && d.categories.length) {
    const cats = el("span", { class: "pv-cats" });
    for (const name of d.categories) {
      const chip = el("span", { class: "pv-cat" }, name);
      chip.style.setProperty("--cc", state.categories.get(name) || "var(--line-strong)");
      cats.append(chip);
    }
    row(t("menuCategories"), cats);
  }
  if (d.privacy === "PRIVATE" || d.privacy === "CONFIDENTIAL") row(t("menuPrivate"), document.createTextNode("✓"));
  if (d.organizer && (d.organizer.name || d.organizer.email)) row(t("organizer"), document.createTextNode(d.organizer.name || d.organizer.email));
  box.append(meta);

  const people = (d.attendees || []).filter(a => a.cutype !== "ROOM" && a.cutype !== "RESOURCE");
  const rooms = (d.attendees || []).filter(a => a.cutype === "ROOM" || a.cutype === "RESOURCE");
  if (people.length) {
    const count = s => people.filter(a => a.partstat === s).length;
    const parts = [
      [count("ACCEPTED"), "accepted"], [count("TENTATIVE"), "tentativeP"],
      [count("DECLINED"), "declined"], [count("NEEDS-ACTION"), "needsAction"],
    ].filter(([n]) => n).map(([n, k]) => `${n} ${t(k)}`);
    box.append(el("h4", {}, `${t("attendees")} (${people.length})`));
    box.append(el("p", { class: "pv-summary" }, parts.join(" · ")));
    const list = el("ul", { class: "pv-people" });
    const icon = { ACCEPTED: "✓", DECLINED: "✕", TENTATIVE: "?", DELEGATED: "→" };
    for (const a of people.slice(0, 30)) {
      const li = el("li", { class: `ps-${a.partstat.toLowerCase()}`, title: a.email });
      li.append(el("span", { class: "ps" }, icon[a.partstat] || "…"), document.createTextNode(a.name || a.email));
      list.append(li);
    }
    box.append(list);
  }
  if (rooms.length) {
    box.append(el("h4", {}, t("rooms")));
    box.append(el("p", {}, rooms.map(r => r.name || r.email).join(", ")));
  }
  if (d.description) {
    const desc = el("div", { class: "pv-desc" });
    desc.textContent = d.description.length > 800 ? d.description.slice(0, 800) + " …" : d.description;
    box.append(desc);
  }

  const actions = el("div", { class: "pv-actions" });
  const open = el("button", {}, t("previewOpen"));
  open.addEventListener("click", () => { hidePreview(); openItem(it); });
  actions.append(open);
  if (!cal.readOnly) {
    const del = el("button", { class: "danger" }, t("delete"));
    del.addEventListener("click", () => { hidePreview(); deleteEvent(it); });
    actions.append(del);
  }
  box.append(actions);
  placePopover(box, anchor);
}
function hidePreview() { previewToken++; $("#preview").hidden = true; }

function deleteEvent(it) {
  const cal = calById(it.calendarId);
  if (!cal || cal.readOnly) { toast(t("readOnly", cal ? cal.name : "")); return; }
  api.deleteItem(it.calendarId, it.id, it.recurrenceId || "").catch(e => toast(t("moveError", errText(e))));
}

function updateEvent(it, changes) {
  api.updateItem(it.calendarId, it.id, it.recurrenceId || "", changes)
    .then(() => toast(t("updated")))
    .catch(e => toast(t("moveError", errText(e))));
}

function showMenu(it, x, y) {
  const menu = $("#ctxmenu");
  menu.textContent = "";
  const cal = calById(it.calendarId);
  const editable = cal && !cal.readOnly && !display(it).masked;
  const item = (label, onClick, opts = {}) => {
    const b = el("button", { role: "menuitem", class: opts.checked ? "checked" : "" });
    if (opts.color) {
      const sw = el("span", { class: "swatch" });
      sw.style.background = opts.color;
      b.append(sw);
    }
    b.append(document.createTextNode(label));
    b.disabled = !!opts.disabled;
    b.addEventListener("click", () => { hideMenu(); onClick(); });
    menu.append(b);
  };
  const heading = text => menu.append(el("div", { class: "menu-head" }, text));
  const sep = () => menu.append(el("hr"));

  item(t("previewOpen"), () => openItem(it), { disabled: display(it).masked });
  if (editable) {
    sep();
    heading(t("showAs"));
    for (const sa of ["busy", "tentative", "free", "oof"]) {
      item(t("show_" + sa), () => updateEvent(it, { showAs: sa }), { checked: (it.showAs || "busy") === sa });
    }
    sep();
    heading(t("menuCategories"));
    const cats = [...state.categories.keys()];
    if (!cats.length) menu.append(el("div", { class: "menu-note" }, t("noCategories")));
    for (const name of cats) {
      const has = (it.categories || []).includes(name);
      item(name, () => updateEvent(it, { categories: has ? it.categories.filter(c => c !== name) : [...(it.categories || []), name] }),
        { checked: has, color: state.categories.get(name) });
    }
    if ((it.categories || []).length) item(t("menuNoCategory"), () => updateEvent(it, { categories: [] }));
    sep();
    const isPrivate = it.privacy === "PRIVATE" || it.privacy === "CONFIDENTIAL";
    item(t("menuPrivate"), () => updateEvent(it, { privacy: !isPrivate }), { checked: isPrivate });
    sep();
    item(t("delete"), () => deleteEvent(it));
  }
  menu.hidden = false;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  Object.assign(menu.style, {
    left: `${Math.min(x, window.innerWidth - w - 6)}px`,
    top: `${Math.max(6, Math.min(y, window.innerHeight - h - 6))}px`,
  });
  const first = menu.querySelector("button:not([disabled])");
  if (first) first.focus();
}
function hideMenu() { $("#ctxmenu").hidden = true; }

/* ---------- Freie Zeit finden ---------- */
function mergeIntervals(list) {
  list.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of list) {
    if (out.length && iv[0] <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], iv[1]);
    else out.push([...iv]);
  }
  return out;
}
function busyIntervals(calIds, from, to) {
  return mergeIntervals(state.items
    .filter(it => calIds.has(it.calendarId) && it.status !== "CANCELLED" && it.showAs !== "free" && !it.transparent && it.start < to && it.end > from)
    .map(it => [Math.max(it.start, from), Math.min(it.end, to)]));
}
function freeIntervals(busy, from, to) {
  const out = [];
  let cur = from;
  for (const [s, e] of busy) {
    if (s > cur) out.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (cur < to) out.push([cur, to]);
  return out;
}
function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]);
    const e = Math.min(a[i][1], b[j][1]);
    if (s < e) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

function runFinder(show = true) {
  const duration = Number($("#findDuration").value) * MIN_MS;
  const needRoom = $("#findRoom").checked;
  const cals = selectedCalendars();
  const people = new Set(cals.filter(c => role(c) !== "room").map(c => c.id));
  const rooms = cals.filter(c => role(c) === "room");
  const { workStart, workEnd } = state.settings;
  const nowMs = Math.ceil(Date.now() / (15 * MIN_MS)) * 15 * MIN_MS;
  const slots = [];
  for (const day of visibleDays().filter(isWorkDay)) {
    const from = Math.max(day.getTime() + workStart * HOUR_MS, isToday(day) ? nowMs : 0);
    const to = day.getTime() + workEnd * HOUR_MS;
    if (to - from < duration) continue;
    const freeP = freeIntervals(busyIntervals(people, from, to), from, to);
    if (!needRoom) {
      for (const [s, e] of freeP) if (e - s >= duration) slots.push({ start: s, end: e });
    } else {
      for (const r of rooms) {
        const freeR = freeIntervals(busyIntervals(new Set([r.id]), from, to), from, to);
        for (const [s, e] of intersect(freeP, freeR)) if (e - s >= duration) slots.push({ start: s, end: e, room: r.id });
      }
    }
  }
  slots.sort((a, b) => a.start - b.start);
  state.free = { slots, duration };
  renderFinderResults();
  if (show) render();
}

function renderFinderResults() {
  const list = $("#findResults");
  list.textContent = "";
  if (!state.free) return;
  if (!state.free.slots.length) { list.append(el("li", { class: "note" }, t("findNone"))); return; }
  for (const sl of state.free.slots.slice(0, 40)) {
    const li = el("li");
    const when = el("span", { class: "when" }, `${fmtDay.format(new Date(sl.start))}  ${timeRange(sl.start, sl.end)}`);
    if (sl.room) when.append(el("span", { class: "room" }, calById(sl.room).name));
    const btn = el("button", {}, t("findCreate"));
    btn.addEventListener("click", () => bookSlot(sl));
    li.append(when, btn);
    list.append(li);
  }
}

async function bookSlot(sl) {
  const target = defaultTarget();
  if (!target) { toast(t("noTarget")); return; }
  const start = new Date(sl.start).toISOString();
  const end = new Date(sl.start + state.free.duration).toISOString();
  const room = sl.room ? calById(sl.room) : null;
  try {
    if (room && $("#findReserve").checked && !room.readOnly) {
      await api.addItem(room.id, start, end, t("reservedTitle"), "");
      toast(t("reserved", room.name));
    }
    await api.createItem(target.id, start, end, room ? { location: room.name } : undefined);
  } catch (err) {
    toast(t("openError", errText(err)));
  }
}

function updateFinderControls() {
  const hasRooms = selectedCalendars().some(c => role(c) === "room");
  $("#findRoom").disabled = !hasRooms;
  if (!hasRooms) $("#findRoom").checked = false;
  $("#findReserve").disabled = !$("#findRoom").checked;
  $("#findRoomHint").hidden = hasRooms;
}

/* ---------- Monatsübersicht mit Kalenderwochen ---------- */
let miniMonth = null;
function renderMini() {
  if (!miniMonth) miniMonth = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
  $("#miniTitle").textContent = fmtMonth.format(miniMonth);
  const grid = $("#miniGrid");
  grid.textContent = "";
  const head = el("tr");
  head.append(el("th", { class: "wk" }, t("weekShort")));
  for (let i = 0; i < 7; i++) head.append(el("th", {}, fmtWeekday.format(new Date(2024, 0, 1 + i))));
  grid.append(head);

  const visible = new Set(visibleDays().map(x => x.getTime()));
  const jump = day => {
    if (state.mode === "custom") { state.mode = "day"; state.scroll = null; }
    state.anchor = day;
    state.lastPicked = day.getTime();
    persist();
    setPanel(null);
    refresh();
  };
  let d = startOfWeek(miniMonth);
  for (let w = 0; w < 6; w++) {
    const tr = el("tr");
    const monday = new Date(d);
    const wb = el("button", { class: "wk", title: t("week", String(isoWeek(monday))) }, String(isoWeek(monday)));
    wb.addEventListener("click", () => {
      if (state.mode === "custom" || state.mode === "day" || state.mode === "schedule") state.mode = "workweek";
      state.scroll = null;
      jump(monday);
    });
    const wtd = el("td");
    wtd.append(wb);
    tr.append(wtd);
    for (let i = 0; i < 7; i++) {
      const day = new Date(d);
      const cls = [
        day.getMonth() !== miniMonth.getMonth() ? "other" : "",
        day.getDay() === 0 || day.getDay() === 6 ? "weekend" : "",
        visible.has(day.getTime()) ? "inview" : "",
        isToday(day) ? "today" : "",
      ].filter(Boolean).join(" ");
      const b = el("button", { class: cls, title: fmtLong.format(day) }, String(day.getDate()));
      b.addEventListener("click", e => {
        if (e.ctrlKey || e.metaKey) toggleCustomDay(day);
        else if (e.shiftKey) rangeCustomDays(day);
        else jump(day);
      });
      const td = el("td");
      td.append(b);
      tr.append(td);
      d = addDays(d, 1);
    }
    grid.append(tr);
    if (d.getMonth() !== miniMonth.getMonth()) break;
  }
}

// Strg-Klick: einzelne Tage hinzufügen/entfernen, Umschalt-Klick: zusammenhängender Zeitraum
function enterCustom(days) {
  const unique = [...new Set(days.map(d => startOfDay(d).getTime()))].sort((a, b) => a - b);
  if (unique.length > MAX_CUSTOM) { toast(t("tooManyDays", MAX_CUSTOM)); return; }
  if (state.mode !== "custom") state.prevMode = state.mode === "schedule" ? "day" : state.mode;
  state.mode = "custom";
  state.customDays = unique;
  state.anchor = new Date(unique[0]);
  state.scroll = null;
  persist();
  refresh().then(renderMini);
}
function toggleCustomDay(day) {
  const ts = day.getTime();
  const current = state.mode === "custom" ? state.customDays.map(x => new Date(x))
    : state.mode === "schedule" ? [state.anchor] : visibleDays();
  const has = current.some(d => d.getTime() === ts);
  const next = has ? current.filter(d => d.getTime() !== ts) : [...current, day];
  state.lastPicked = ts;
  if (!next.length) return;
  enterCustom(next);
}
function rangeCustomDays(day) {
  const from = state.lastPicked ?? state.anchor.getTime();
  const [a, b] = from <= day.getTime() ? [from, day.getTime()] : [day.getTime(), from];
  const days = [];
  for (let d = new Date(a); d.getTime() <= b; d = addDays(d, 1)) days.push(new Date(d));
  enterCustom(days);
}

/* ---------- Bedienung ---------- */
function setPanel(name) {
  const top = `${Math.round(document.querySelector(".toolbar").getBoundingClientRect().bottom) + 6}px`;
  for (const id of PANELS) {
    const open = id === name;
    $(`#${id}`).hidden = !open;
    $(`#${id}`).style.top = top;
    const btn = document.querySelector(`[data-panel="${id}"]`);
    if (btn) btn.setAttribute("aria-expanded", String(open));
  }
  if (name === "settings") renderSettings();
  if (name === "jump") {
    const r = $("#jumpBtn").getBoundingClientRect();
    Object.assign($("#jump").style, { left: `${Math.round(r.left)}px`, right: "auto", top: `${Math.round(r.bottom) + 6}px` });
    miniMonth = null;
    renderMini();
  }
  if (name === "finder") updateFinderControls();
  if (name !== "finder" && state.free) { state.free = null; $("#findResults").textContent = ""; render(); }
}
const openPanel = () => PANELS.find(id => !$(`#${id}`).hidden) || null;

function step() { return state.mode === "day" || state.mode === "schedule" ? 1 : 7; }
function go(days) {
  if (state.mode === "custom") state.customDays = state.customDays.map(ts => addDays(new Date(ts), days).getTime());
  state.anchor = addDays(state.anchor, days);
  persist();
  refresh();
}
function setMode(mode) { state.mode = mode; state.scroll = null; persist(); refresh(); }
function goToday() {
  if (state.mode === "custom") state.mode = state.prevMode || "day";
  state.anchor = startOfDay(new Date());
  state.scroll = null;
  persist();
  refresh();
}

function bindUI() {
  $("#today").addEventListener("click", goToday);
  $("#prev").addEventListener("click", () => go(-step()));
  $("#next").addEventListener("click", () => go(step()));
  $("#miniPrev").addEventListener("click", () => { miniMonth = new Date(miniMonth.getFullYear(), miniMonth.getMonth() - 1, 1); renderMini(); });
  $("#miniNext").addEventListener("click", () => { miniMonth = new Date(miniMonth.getFullYear(), miniMonth.getMonth() + 1, 1); renderMini(); });
  $("#miniToday").addEventListener("click", () => { setPanel(null); goToday(); });
  for (const b of document.querySelectorAll(".modes button")) b.addEventListener("click", () => setMode(b.dataset.mode));
  $("#overlay").addEventListener("click", () => { state.overlay = !state.overlay; persist(); render(); });
  $("#printBtn").addEventListener("click", () => window.print());

  for (const btn of document.querySelectorAll("[data-panel]")) {
    btn.addEventListener("click", e => { e.stopPropagation(); setPanel(openPanel() === btn.dataset.panel ? null : btn.dataset.panel); });
  }
  for (const id of PANELS) $(`#${id}`).addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", e => {
    if (openPanel() && openPanel() !== "finder") setPanel(null);
    if (!e.target.closest("#preview")) hidePreview();
    if (!e.target.closest("#ctxmenu")) hideMenu();
  });
  document.addEventListener("contextmenu", e => { if (!e.target.closest(".ev, .chip")) hideMenu(); });
  $("#preview").addEventListener("click", e => e.stopPropagation());
  $("#scroller").addEventListener("scroll", () => { hidePreview(); hideMenu(); }, { passive: true });
  $("#addCalendar").addEventListener("click", () => {
    state.wizardKnown = new Set(state.calendars.map(c => c.id));
    setPanel(null);
    api.openCalendarWizard().catch(e => toast(t("openError", errText(e))));
  });

  document.addEventListener("keydown", async e => {
    if (e.key === "Escape") { setPanel(null); hidePreview(); hideMenu(); return; }
    const typing = e.target.closest("input, select, textarea");
    if (!typing && e.key === "Delete" && state.selectedEvent) {
      e.preventDefault();
      hidePreview();
      deleteEvent(state.selectedEvent);
      return;
    }
    const key = e.key.toLowerCase();
    if (!typing && (e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
      e.preventDefault();
      const redo = key === "y" || e.shiftKey;
      try {
        const done = redo ? await api.redo() : await api.undo();
        toast(t(done ? (redo ? "redone" : "undone") : "nothingToUndo"));
      } catch (err) {
        toast(t("moveError", errText(err)));
      }
      return;
    }
    if (e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
    const modes = { 1: "day", 2: "workweek", 3: "week", 4: "schedule" };
    if (e.key === "t" || e.key === "T") goToday();
    else if (e.key === "ArrowLeft") go(-step());
    else if (e.key === "ArrowRight") go(step());
    else if (modes[e.key]) setMode(modes[e.key]);
  });

  const dur = $("#findDuration");
  for (const m of [30, 45, 60, 90, 120, 180]) dur.append(el("option", { value: String(m) }, t("minutes", m)));
  dur.value = String(state.settings.duration >= 30 ? state.settings.duration : 60);
  $("#findRoom").addEventListener("change", updateFinderControls);
  $("#findSearch").addEventListener("click", () => runFinder(true));

  $("#group").addEventListener("change", e => {
    const g = state.groups[e.target.value];
    $("#groupDelete").hidden = !g;
    if (!g) return;
    state.selected = g.ids.filter(id => calById(id));
    persist();
    renderPicker();
    refresh();
  });
  $("#groupSave").addEventListener("click", () => {
    const name = $("#groupName").value.trim();
    if (!name || !state.selected.length) return;
    const existing = state.groups.findIndex(g => g.name === name);
    const group = { name, ids: [...state.selected] };
    if (existing >= 0) state.groups[existing] = group; else state.groups.push(group);
    persist();
    renderGroups();
    $("#group").value = String(existing >= 0 ? existing : state.groups.length - 1);
    $("#groupDelete").hidden = false;
    $("#groupName").value = "";
    toast(t("groupSaved", name));
  });
  $("#groupDelete").addEventListener("click", () => {
    const idx = Number($("#group").value);
    if (Number.isNaN(idx) || !state.groups[idx]) return;
    state.groups.splice(idx, 1);
    persist();
    $("#group").value = "";
    renderGroups();
  });
}

function applyI18n() {
  for (const n of document.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll("[data-i18n-title]")) {
    n.title = t(n.dataset.i18nTitle);
    n.setAttribute("aria-label", n.title);
  }
  for (const n of document.querySelectorAll("[data-i18n-placeholder]")) n.placeholder = t(n.dataset.i18nPlaceholder);
  document.documentElement.lang = LOCALE;
}

async function init() {
  applyI18n();
  api.hideTabToolbar().catch(() => {});
  const saved = await messenger.storage.local.get(["selected", "groups", "mode", "overlay", "overlayTarget", "settings", "customDays", "prevMode"]);
  state.groups = saved.groups || [];
  state.mode = saved.mode || "workweek";
  state.customDays = saved.customDays || [];
  state.prevMode = saved.prevMode || "day";
  if (state.mode === "custom" && !state.customDays.length) state.mode = "workweek";
  if (state.mode === "custom") state.anchor = new Date(state.customDays[0]);
  state.overlay = !!saved.overlay;
  state.overlayTarget = saved.overlayTarget || null;
  state.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
  state.settings.roles = { ...(state.settings.roles || {}) };
  applyZoom();
  try {
    await loadCalendars();
  } catch (e) {
    showError(t("loadError", errText(e)));
  }
  state.selected = (saved.selected || state.calendars.map(c => c.id)).filter(id => calById(id));

  bindUI();
  renderPicker();
  renderGroups();
  await refresh();

  api.onChanged.addListener(scheduleRefresh);

  // Beta-Hinweis beim ersten Start
  const { betaSeen } = await messenger.storage.local.get("betaSeen");
  if (!betaSeen) {
    showError(t("betaNotice"));
    $("#error").classList.add("info");
    messenger.storage.local.set({ betaSeen: true });
  }
  setInterval(render, 5 * 60000);
}

init();
