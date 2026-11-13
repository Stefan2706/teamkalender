# TeamKalender für Thunderbird (Beta)

**Kalender von Kollegen und Räumen nebeneinander – wie in Outlook.**
TeamKalender erweitert den Thunderbird-Kalender um die Team-Funktionen, die
Umsteiger von Outlook vermissen. Es funktioniert mit allen Kalendern, die in
Thunderbird eingerichtet sind, z. B. CalDAV von **Nextcloud** oder
**Mailcow/SOGo**.

[English version](README.en.md)

> ⚠️ **Beta-Version.** Bitte zuerst mit Testterminen ausprobieren. Fehler und
> Ideen gerne als [Issue](https://github.com/Stefan2706/teamkalender/issues/new/choose) melden.

## Funktionen
- **Nebeneinander, Überlagern und Zeitplan** – Kalender in eigenen Spalten, in
  einer gemeinsamen Ansicht oder als Zeilen mit waagerechter Zeitachse
- **Tag, Arbeitswoche, Woche** und **einzelne Tage per Strg + Klick**,
  Monatskalender mit **Kalenderwochen**
- **Freie Zeit finden** über alle gewählten Kalender, optional mit freiem Raum
- **Räume**: Raumkalender belegen und in der Raumsuche berücksichtigen
- **Termin-Vorschau** mit Teilnehmern (Zu-/Absagen) und **„Teilnehmen“-Button**
  für Nextcloud Talk, Jitsi, BigBlueButton, Teams, Zoom u. a.
- **Ziehen** zum Verschieben (auch Besprechungen – Thunderbird benachrichtigt die
  Teilnehmer), **Strg + Ziehen** zum Kopieren, **Zeitraum aufziehen** für neue
  Termine, **Rechtsklick-Menü**, **Entf** zum Löschen, **Strg + Z** rückgängig
- **„Anzeigen als“** (Gebucht, Mit Vorbehalt, Frei, Abwesend) und
  **Farbkategorien** wie in Outlook
- **Outlook-Design für den Thunderbird-Kalender** (abschaltbar)
- **Private Termine von Kollegen** nur als „Privat“, Arbeitszeiten hervorgehoben
- Gespeicherte Kalendergruppen, Drucken, Tastenkürzel (T, ←/→, 1–4)
- Deutsch und Englisch, helles und dunkles Design

## Installation
1. Die neueste `teamkalender-x.y.z.xpi` unter
   [Releases](https://github.com/Stefan2706/teamkalender/releases) herunterladen.
2. Thunderbird → ☰ → **Add-ons und Themes** → Zahnrad →
   **Add-on aus Datei installieren…** → Datei auswählen.
3. In der linken Leiste erscheint **TeamKalender** (zusätzlich gibt es einen
   Symbolleisten-Button und einen Eintrag im Menü **Extras**).

Updates werden danach automatisch installiert (beim nächsten Thunderbird-Start).

**Voraussetzungen:** Thunderbird 128 oder neuer, Kalender in Thunderbird
eingerichtet (z. B. CalDAV). Exchange-Kalender werden von Thunderbird derzeit
noch nicht unterstützt und erscheinen daher auch nicht in TeamKalender.

## Erste Schritte
1. **Kalender auswählen** – die Kalender anhaken, die erscheinen sollen.
   Kollegen-Kalender lassen sich über „＋ Kalender hinzufügen“ einbinden
   (Thunderbird findet freigegebene Kalender auf dem Server).
2. **⚙ Einstellungen** – für jeden Kalender festlegen, ob er **Eigener**,
   **Kollege** oder **Raum** ist, dazu Arbeitszeit, Farben und Design.
3. Häufige Auswahl als **Gruppe speichern**, z. B. „Vertrieb“ oder „Räume“.

## Datenschutz
TeamKalender **sendet keine Daten**. Es liest ausschließlich die Kalender, die
in Ihrem Thunderbird eingerichtet sind, und speichert seine Einstellungen lokal.
Einzige Netzwerkverbindung ist die Update-Prüfung bei GitHub.

## Technischer Hinweis
Thunderbird bietet für Kalender noch keine offizielle Add-on-Schnittstelle.
TeamKalender nutzt deshalb eine **Experiment-API** mit vollem Zugriff auf
Thunderbird. Nach größeren Thunderbird-Updates kann eine Anpassung nötig sein –
für Unternehmen empfiehlt sich die **ESR-Version** von Thunderbird.

## Entwicklung
```bash
./scripts/release.sh   # baut dist/teamkalender-<version>.xpi und aktualisiert updates.json
```
Zum Testen ohne Installation: Thunderbird → Add-ons → Zahnrad →
**Add-ons debuggen** → **Temporäres Add-on laden** → `src/manifest.json`.

## Lizenz
[Mozilla Public License 2.0](LICENSE) · © Stefan Scherer,
[ts-scherer.com](https://ts-scherer.com) – Beratung zum Umstieg auf
Open-Source-Lösungen.

„Outlook“ ist eine Marke der Microsoft Corporation. TeamKalender steht in keiner
Verbindung zu Microsoft oder Mozilla.
