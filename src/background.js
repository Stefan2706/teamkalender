/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * TeamKalender – (c) Stefan Scherer, ts-scherer.com */
// TeamKalender als eigener Bereich in der linken Thunderbird-Leiste
// (wie Kalender oder Adressbuch). Symbolleisten-Button und Menü öffnen ihn ebenfalls.
const VIEW_URL = "view/view.html";
const SPACE_NAME = "teamkalender";
let spaceId = null;
let viewTabId = null;

async function ensureSpace() {
  if (!messenger.spaces) return null;
  if (spaceId !== null) return spaceId;
  try {
    const space = await messenger.spaces.create(SPACE_NAME, VIEW_URL, {
      title: messenger.i18n.getMessage("extensionName"),
      defaultIcons: "icons/icon.svg",
    });
    spaceId = space.id;
  } catch (e) {
    try {
      const [existing] = await messenger.spaces.query({ name: SPACE_NAME });
      spaceId = existing ? existing.id : null;
    } catch (e2) {
      spaceId = null;
    }
  }
  return spaceId;
}

async function openView() {
  const id = await ensureSpace();
  if (id !== null) {
    await messenger.spaces.open(id);
    return;
  }
  // Rückfall für Thunderbird-Versionen ohne Bereiche-Schnittstelle
  if (viewTabId !== null) {
    try {
      await messenger.tabs.update(viewTabId, { active: true });
      return;
    } catch (e) {
      viewTabId = null;
    }
  }
  const tab = await messenger.tabs.create({ url: VIEW_URL });
  viewTabId = tab.id;
}

ensureSpace();
messenger.browserAction.onClicked.addListener(openView);

// Zusätzlicher Eintrag im Menü „Extras“
messenger.menus.create({
  id: "open-teamkalender",
  title: messenger.i18n.getMessage("actionTitle"),
  contexts: ["tools_menu"],
});
messenger.menus.onClicked.addListener(info => {
  if (info.menuItemId === "open-teamkalender") openView();
});

messenger.tabs.onRemoved.addListener(id => {
  if (id === viewTabId) viewTabId = null;
});

// Outlook-Design für den Thunderbird-Kalender (Standard: an)
async function applyTheme() {
  const { outlookTheme = true, settings = {} } = await messenger.storage.local.get(["outlookTheme", "settings"]);
  try {
    await messenger.sbsCalendar.setTheme(outlookTheme, {
      categoryColors: (settings.colorBy || "category") === "category",
      tint: settings.tint || "medium",
    });
  } catch (e) {
    console.error("TeamKalender: Design", e);
  }
}
messenger.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("outlookTheme" in changes || "settings" in changes)) applyTheme();
});
applyTheme();
