/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * TeamKalender – (c) Stefan Scherer, ts-scherer.com */
/* Experiment-API „sbsCalendar“: liest die in Thunderbird eingerichteten Kalender
 * und öffnet Termine in den Thunderbird-eigenen Dialogen.
 * Funktioniert mit allen Kalendern, die Thunderbird kennt (CalDAV, lokal, ICS …). */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var { ExtensionError } = ExtensionUtils;

// Fehlermeldungen in der Sprache von Thunderbird (Deutsch oder Englisch)
const MSG = {
  noWindow: ["Kein Thunderbird-Hauptfenster gefunden.", "No Thunderbird main window found."],
  noCalendar: ["Kalender nicht gefunden.", "Calendar not found."],
  readOnly: ["Kalender ist schreibgeschützt.", "The calendar is read-only."],
  noItem: ["Termin nicht gefunden.", "Event not found."],
  noOccurrence: ["Vorkommen nicht gefunden.", "Occurrence not found."],
  seriesOther: ["Einzelne Serientermine können nicht in einen anderen Kalender verschoben werden.", "Single occurrences cannot be moved to another calendar."],
  invitationMove: ["Einladungen anderer Organisatoren können nur vom Organisator verschoben werden.", "Invitations from other organizers can only be moved by the organizer."],
  invitationEdit: ["Einladungen anderer Organisatoren können nicht geändert werden.", "Invitations from other organizers cannot be changed."],
};
function msg(key) {
  const de = (Services.locale.appLocaleAsBCP47 || "").toLowerCase().startsWith("de");
  return MSG[key][de ? 0 : 1];
}
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

/* ---------- Outlook-Design für den Thunderbird-Kalender ---------- */
const THEME_LISTENER = "teamkalender-outlook-theme";
const themeState = { active: false, uri: null, windows: new Map(), categoryColors: false, tint: "medium" };
const TINTS = { soft: "22%", medium: "40%", full: "40%" };
function themeApplyTint(doc) {
  doc.documentElement.style.setProperty("--tsol-tint", TINTS[themeState.tint] || "40%");
  doc.documentElement.setAttribute("tsol-tint", themeState.tint);
}

function categoryList() {
  return cal.category.fromPrefs().map(name => ({
    name,
    color: Services.prefs.getStringPref("calendar.category.color." + cal.view.formatStringForCSSRule(name), ""),
  }));
}
function categoryColorMap() {
  const map = new Map();
  for (const c of categoryList()) if (c.color) map.set(c.name, c.color);
  return map;
}
const HTML_NS = "http://www.w3.org/1999/xhtml";

// Thunderbird misst die Kopfhöhe nur einmal – nach Designwechsel neu messen lassen
function themeRelayout(doc) {
  for (const view of doc.querySelectorAll("calendar-day-view, calendar-week-view")) {
    try {
      view.headingContentHeight = 0;
      delete view.headingHeight;
      delete view.headingContentToBorderOffset;
      delete view.minHeadingWidth;
      view.headingDatesChanged = true;
      if (typeof view.readjustView === "function") view.readjustView(false, false, view.scrollMinute);
    } catch (e) {}
  }
}

function decorateSpan(doc, span, num, weekday) {
  if (!span || span.querySelector(".tsol-num")) return;
  span.dataset.tsolText = span.textContent;
  span.textContent = "";
  const n = doc.createElementNS(HTML_NS, "span");
  n.className = "tsol-num";
  n.textContent = String(num);
  const w = doc.createElementNS(HTML_NS, "span");
  w.className = "tsol-wd";
  w.textContent = weekday;
  span.append(n, w);
}

function themeDecorate(win, root, fmt) {
  const doc = win.document;
  for (const heading of root.querySelectorAll(".day-column-heading")) {
    const header = heading.parentElement && heading.parentElement.querySelector("calendar-header-container");
    const date = header && header.date;
    if (!date) continue;
    const jsDate = new Date(date.year, date.month, date.day);
    decorateSpan(doc, heading.children[0], date.day, fmt.long.format(jsDate));
    decorateSpan(doc, heading.children[1], date.day, fmt.short.format(jsDate));
  }
  const colors = themeState.categoryColors ? categoryColorMap() : null;
  for (const box of root.querySelectorAll("calendar-event-box, calendar-editable-item, calendar-month-day-box-item")) {
    const item = box.mOccurrence || box.occurrence;
    if (!item) continue;
    const sa = showAsOf(item);
    if (box.getAttribute("data-tsol-showas") !== sa) box.setAttribute("data-tsol-showas", sa);
    // Farbkategorien wie in Outlook: Termin in der Farbe seiner ersten Kategorie
    const catColor = colors && (item.getCategories() || []).map(n => colors.get(n)).find(Boolean);
    if (catColor) {
      if (box.dataset.tsolOrigBack === undefined) box.dataset.tsolOrigBack = box.style.getPropertyValue("--item-backcolor");
      if (box.style.getPropertyValue("--item-backcolor") !== catColor) box.style.setProperty("--item-backcolor", catColor);
    } else if (box.dataset.tsolOrigBack !== undefined) {
      box.style.setProperty("--item-backcolor", box.dataset.tsolOrigBack);
      delete box.dataset.tsolOrigBack;
    }
  }
}

function themeApply(win) {
  if (!themeState.uri || themeState.windows.has(win)) return;
  try {
    win.windowUtils.loadSheet(themeState.uri, win.windowUtils.AUTHOR_SHEET);
  } catch (e) {
    console.error("TeamKalender: Design konnte nicht geladen werden", e);
    return;
  }
  const doc = win.document;
  const root = doc.getElementById("view-box") || doc.documentElement;
  const locale = Services.locale.appLocaleAsBCP47;
  const fmt = {
    long: new Intl.DateTimeFormat(locale, { weekday: "long" }),
    short: new Intl.DateTimeFormat(locale, { weekday: "short" }),
  };
  let pending = false;
  const run = () => {
    pending = false;
    try { themeDecorate(win, root, fmt); } catch (e) { console.error(e); }
  };
  const observer = new win.MutationObserver(() => {
    if (pending) return;
    pending = true;
    win.requestAnimationFrame(run);
  });
  observer.observe(root, { childList: true, subtree: true });
  themeState.windows.set(win, { observer, root, run });
  themeApplyTint(doc);
  run();
  themeRelayout(doc);
}

function themeRemove(win) {
  const entry = themeState.windows.get(win);
  if (!themeState.uri || !entry) return;
  entry.observer.disconnect();
  try {
    win.windowUtils.removeSheet(themeState.uri, win.windowUtils.AUTHOR_SHEET);
  } catch (e) {}
  for (const span of entry.root.querySelectorAll("[data-tsol-text]")) {
    span.textContent = span.dataset.tsolText;
    delete span.dataset.tsolText;
  }
  for (const box of entry.root.querySelectorAll("[data-tsol-showas]")) box.removeAttribute("data-tsol-showas");
  for (const box of entry.root.querySelectorAll("[data-tsol-orig-back]")) {
    box.style.setProperty("--item-backcolor", box.dataset.tsolOrigBack);
    delete box.dataset.tsolOrigBack;
  }
  themeState.windows.delete(win);
  win.document.documentElement.style.removeProperty("--tsol-tint");
  win.document.documentElement.removeAttribute("tsol-tint");
  themeRelayout(win.document);
}
function themeSet(enabled, uri, options = {}) {
  const catChanged = themeState.categoryColors !== !!options.categoryColors;
  themeState.categoryColors = !!options.categoryColors;
  themeState.tint = TINTS[options.tint] ? options.tint : "medium";
  if (enabled && themeState.active) {
    for (const [win, entry] of themeState.windows) {
      themeApplyTint(win.document);
      if (catChanged) entry.run();
    }
  }
  if (enabled && !themeState.active) {
    themeState.uri = uri;
    ExtensionSupport.registerWindowListener(THEME_LISTENER, {
      chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
      onLoadWindow: themeApply,
    });
    themeState.active = true;
  } else if (!enabled && themeState.active) {
    ExtensionSupport.unregisterWindowListener(THEME_LISTENER);
    for (const win of Services.wm.getEnumerator("mail:3pane")) themeRemove(win);
    themeState.active = false;
  }
}

function mailWindow() {
  const win = Services.wm.getMostRecentWindow("mail:3pane");
  if (!win) throw new ExtensionError(msg("noWindow"));
  return win;
}

function findCalendar(id) {
  const calendar = cal.manager.getCalendarById(id);
  if (!calendar) throw new ExtensionError(msg("noCalendar"));
  return calendar;
}

async function findOccurrence(calendar, itemId, recurrenceId) {
  const item = await calendar.getItem(itemId);
  if (!item) throw new ExtensionError(msg("noItem"));
  if (recurrenceId && item.recurrenceInfo) {
    return item.recurrenceInfo.getOccurrenceFor(cal.createDateTime(recurrenceId)) || item;
  }
  return item;
}

function toDateTime(iso) {
  return cal.dtz.jsDateToDateTime(new Date(iso), cal.dtz.defaultTimezone);
}

// calIDateTime -> Millisekunden; ganztägige Daten als lokale Mitternacht
function toMillis(dt) {
  if (!dt) return null;
  if (dt.isDate) return new Date(dt.year, dt.month, dt.day).getTime();
  return cal.dtz.dateTimeToJsDate(dt).getTime();
}

// „Anzeigen als“ wie in Outlook: busy, tentative, free, oof
function showAsOf(item) {
  const cdo = (item.getProperty("X-MICROSOFT-CDO-BUSYSTATUS") || "").toUpperCase();
  if (cdo === "OOF") return "oof";
  if (cdo === "FREE" || (item.getProperty("TRANSP") || "").toUpperCase() === "TRANSPARENT") return "free";
  if (cdo === "TENTATIVE" || (item.status || "").toUpperCase() === "TENTATIVE") return "tentative";
  return "busy";
}

function newEvent() {
  const { CalEvent } = ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs");
  return new CalEvent();
}

function convertItem(item, calendarId) {
  const start = item.startDate;
  const end = item.endDate || start;
  return {
    calendarId,
    id: item.id,
    recurrenceId: item.recurrenceId ? item.recurrenceId.icalString : "",
    title: item.title || "",
    location: item.getProperty("LOCATION") || "",
    allDay: !!(start && start.isDate),
    start: toMillis(start),
    end: toMillis(end),
    status: item.status || "",
    attendees: item.getAttendees ? item.getAttendees().length : 0,
    privacy: (item.privacy || "").toUpperCase(),
    transparent: (item.getProperty("TRANSP") || "").toUpperCase() === "TRANSPARENT",
    showAs: showAsOf(item),
    categories: item.getCategories ? item.getCategories() : [],
    recurring: !!item.recurrenceId,
  };
}

var sbsCalendar = class extends ExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (!isAppShutdown) themeSet(false);
  }

  getAPI(context) {
    return {
      sbsCalendar: {
        async setTheme(enabled, options) {
          const uri = Services.io.newURI(context.extension.getURL("theme/outlook-calendar.css"));
          themeSet(!!enabled, uri, options || {});
        },

        // Blendet die Adressleiste über dem TeamKalender-Tab aus (Thunderbird zeigt sie
        // bei Erweiterungsseiten sonst immer an)
        async hideTabToolbar() {
          const base = context.extension.baseURI.spec;
          for (const win of Services.wm.getEnumerator("mail:3pane")) {
            const tabmail = win.document.getElementById("tabmail");
            for (const tab of (tabmail && tabmail.tabInfo) || []) {
              const spec = tab.browser && tab.browser.currentURI && tab.browser.currentURI.spec;
              if (spec && spec.startsWith(base) && tab.panel) {
                const toolbox = tab.panel.querySelector(".contentTabToolbox");
                if (toolbox) toolbox.style.display = "none";
              }
            }
          }
        },

        // Farbe und Name eines Kalenders direkt in Thunderbird ändern
        async setCalendarProps(calendarId, props) {
          const calendar = findCalendar(calendarId);
          if (props.color) calendar.setProperty("color", props.color);
          if (props.name && props.name.trim()) calendar.name = props.name.trim();
        },

        async getCategories() {
          return categoryList();
        },

        async openCalendarWizard() {
          cal.window.openCalendarWizard(mailWindow());
        },

        async getItemDetails(calendarId, itemId, recurrenceId) {
          const calendar = findCalendar(calendarId);
          const item = await findOccurrence(calendar, itemId, recurrenceId);
          const person = a => a && {
            name: a.commonName || "",
            email: (a.id || "").replace(/^mailto:/i, ""),
            partstat: (a.participationStatus || "NEEDS-ACTION").toUpperCase(),
            role: a.role || "",
            cutype: (a.userType || "INDIVIDUAL").toUpperCase(),
          };
          let description = "";
          try { description = item.descriptionText || ""; } catch (e) {}
          if (!description) description = item.getProperty("DESCRIPTION") || "";
          return {
            ...convertItem(item, calendarId),
            description,
            url: item.getProperty("URL") || "",
            organizer: person(item.organizer),
            attendees: (item.getAttendees() || []).map(person),
            isInvitation: !!cal.itip.isInvitation(item),
            privacy: (item.privacy || "").toUpperCase(),
          };
        },

        // Löschen über Thunderbird: fragt bei Serien nach, sendet Absagen, Strg+Z möglich
        async deleteItem(calendarId, itemId, recurrenceId) {
          const calendar = findCalendar(calendarId);
          if (calendar.readOnly) throw new ExtensionError(msg("readOnly"));
          const item = await findOccurrence(calendar, itemId, recurrenceId);
          mailWindow().calendarViewController.deleteOccurrences([item], false, false);
        },

        // Eigenschaften ändern: Anzeigen als, privat, Kategorien
        async updateItem(calendarId, itemId, recurrenceId, changes) {
          const calendar = findCalendar(calendarId);
          if (calendar.readOnly) throw new ExtensionError(msg("readOnly"));
          const oldItem = await findOccurrence(calendar, itemId, recurrenceId);
          if (cal.itip.isInvitation(oldItem) && (changes.privacy !== undefined)) {
            throw new ExtensionError(msg("invitationEdit"));
          }
          const newItem = oldItem.clone();
          if (changes.showAs) {
            const sa = changes.showAs;
            newItem.setProperty("TRANSP", sa === "free" ? "TRANSPARENT" : "OPAQUE");
            newItem.setProperty("X-MICROSOFT-CDO-BUSYSTATUS", { busy: "BUSY", tentative: "TENTATIVE", free: "FREE", oof: "OOF" }[sa]);
            if (sa === "tentative") newItem.status = "TENTATIVE";
            else if ((newItem.status || "").toUpperCase() === "TENTATIVE") newItem.status = "CONFIRMED";
          }
          if (changes.privacy !== undefined) newItem.privacy = changes.privacy ? "PRIVATE" : "PUBLIC";
          if (Array.isArray(changes.categories)) newItem.setCategories(changes.categories);
          await mailWindow().doTransaction("modify", newItem, calendar, oldItem, null);
        },

        async getCalendars() {
          return cal.manager
            .getCalendars()
            .filter(c => !c.getProperty("disabled"))
            .filter(c => c.getProperty("capabilities.events.supported") !== false)
            .map(c => ({
              id: c.id,
              name: c.name,
              color: c.getProperty("color") || "#3b82f6",
              readOnly: !!c.readOnly,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        },

        async getItems(calendarIds, rangeStart, rangeEnd) {
          const start = toDateTime(rangeStart);
          const end = toDateTime(rangeEnd);
          const filter =
            Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES;
          const result = [];
          for (const id of calendarIds) {
            const calendar = cal.manager.getCalendarById(id);
            if (!calendar || calendar.getProperty("disabled")) continue;
            try {
              const items = await calendar.getItemsAsArray(filter, 0, start, end);
              for (const item of items) result.push(convertItem(item, id));
            } catch (e) {
              console.error(`TeamKalender: ${calendar.name}`, e);
            }
          }
          return result;
        },

        async openItem(calendarId, itemId, recurrenceId) {
          const calendar = findCalendar(calendarId);
          let item = await calendar.getItem(itemId);
          if (!item) throw new ExtensionError(msg("noItem"));
          if (recurrenceId && item.recurrenceInfo) {
            const occurrence = item.recurrenceInfo.getOccurrenceFor(cal.createDateTime(recurrenceId));
            if (occurrence) item = occurrence;
          }
          // true = bei Serien nachfragen: „nur dieses Vorkommen“ oder „ganze Serie“
          mailWindow().modifyEventWithDialog(item, true);
        },

        async createItem(calendarId, start, end, prefill) {
          const calendar = findCalendar(calendarId);
          if (calendar.readOnly) throw new ExtensionError(msg("readOnly"));
          const win = mailWindow();
          const s = toDateTime(start);
          const e = toDateTime(end);
          if (prefill && (prefill.title || prefill.location)) {
            try {
              const event = newEvent();
              event.title = prefill.title || "";
              if (prefill.location) event.setProperty("LOCATION", prefill.location);
              event.startDate = s;
              event.endDate = e;
              event.calendar = calendar;
              win.createEventWithDialog(calendar, s, e, null, event);
              return;
            } catch (err) {
              console.error("TeamKalender: Vorbelegung nicht möglich", err);
            }
          }
          win.createEventWithDialog(calendar, s, e);
        },

        // Legt einen Termin ohne Dialog an (z. B. Raumreservierung)
        async addItem(calendarId, start, end, title, location) {
          const calendar = findCalendar(calendarId);
          if (calendar.readOnly) throw new ExtensionError(msg("readOnly"));
          const event = newEvent();
          event.id = cal.getUUID();
          event.title = title;
          if (location) event.setProperty("LOCATION", location);
          event.startDate = toDateTime(start);
          event.endDate = toDateTime(end);
          event.calendar = calendar;
          await mailWindow().doTransaction("add", event, calendar, null, null);
        },

        // Kopiert einen Termin (bei Serien nur das Vorkommen) – ohne Teilnehmer
        async copyItem(calendarId, itemId, recurrenceId, targetCalendarId, startIso, endIso) {
          const source = findCalendar(calendarId);
          const target = findCalendar(targetCalendarId || calendarId);
          if (target.readOnly) throw new ExtensionError(msg("readOnly"));
          const original = await source.getItem(itemId);
          if (!original) throw new ExtensionError(msg("noItem"));
          let base = original;
          if (recurrenceId && original.recurrenceInfo) {
            base = original.recurrenceInfo.getOccurrenceFor(cal.createDateTime(recurrenceId)) || original;
          }
          const copy = newEvent();
          copy.id = cal.getUUID();
          copy.title = base.title;
          for (const prop of ["LOCATION", "DESCRIPTION", "CATEGORIES", "TRANSP"]) {
            const value = base.getProperty(prop);
            if (value) copy.setProperty(prop, value);
          }
          if (base.privacy) copy.privacy = base.privacy;
          copy.startDate = toDateTime(startIso);
          copy.endDate = toDateTime(endIso);
          copy.calendar = target;
          await mailWindow().doTransaction("add", copy, target, null, null);
        },

        // Verschieben über Thunderbirds Transaktionen: sendet Aktualisierungen an
        // Teilnehmer und lässt sich mit Strg+Z rückgängig machen.
        async moveItem(calendarId, itemId, recurrenceId, targetCalendarId, startIso, endIso) {
          const source = findCalendar(calendarId);
          const target = findCalendar(targetCalendarId || calendarId);
          if (source.readOnly || target.readOnly) throw new ExtensionError(msg("readOnly"));
          const original = await source.getItem(itemId);
          if (!original) throw new ExtensionError(msg("noItem"));
          if (cal.itip.isInvitation(original)) {
            throw new ExtensionError(msg("invitationMove"));
          }
          let oldItem = original;
          if (recurrenceId && original.recurrenceInfo) {
            if (target.id !== source.id) {
              throw new ExtensionError(msg("seriesOther"));
            }
            oldItem = original.recurrenceInfo.getOccurrenceFor(cal.createDateTime(recurrenceId));
            if (!oldItem) throw new ExtensionError(msg("noOccurrence"));
          }
          const newItem = oldItem.clone();
          newItem.startDate = toDateTime(startIso);
          newItem.endDate = toDateTime(endIso);
          if (target.id !== source.id) newItem.calendar = target;
          await mailWindow().doTransaction("modify", newItem, target, oldItem, null);
        },

        async undo() {
          const win = mailWindow();
          if (!win.canUndo()) return false;
          win.undo();
          return true;
        },

        async redo() {
          const win = mailWindow();
          if (!win.canRedo()) return false;
          win.redo();
          return true;
        },

        onChanged: new ExtensionCommon.EventManager({
          context,
          name: "sbsCalendar.onChanged",
          register: fire => {
            const notify = () => fire.async();
            const observer = {
              QueryInterface: ChromeUtils.generateQI(["calIObserver", "calICalendarManagerObserver"]),
              onStartBatch() {},
              onEndBatch: notify,
              onLoad: notify,
              onAddItem: notify,
              onModifyItem: notify,
              onDeleteItem: notify,
              onError() {},
              onPropertyChanged(calendar, name) {
                if (["name", "color", "disabled", "readOnly"].includes(name)) notify();
              },
              onPropertyDeleting() {},
              onCalendarRegistered: notify,
              onCalendarUnregistering: notify,
              onCalendarDeleting() {},
            };
            cal.manager.addCalendarObserver(observer);
            cal.manager.addObserver(observer);
            return () => {
              cal.manager.removeCalendarObserver(observer);
              cal.manager.removeObserver(observer);
            };
          },
        }).api(),
      },
    };
  }
};
