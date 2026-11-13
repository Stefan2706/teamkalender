#!/usr/bin/env bash
# Baut ein Debian-Paket (.deb), das TeamKalender systemweit für Thunderbird installiert.
# Voraussetzung: dist/teamkalender-<version>.xpi existiert (vorher ./scripts/release.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('src/manifest.json'))['version'])")
XPI="dist/teamkalender-${VERSION}.xpi"
ID="teamkalender@ts-scherer.com"
TB_APP_ID="{3550f703-e582-4d05-9a08-453d09bdfdc6}"
PKG="thunderbird-teamkalender"
[ -f "$XPI" ] || { echo "Fehlt: $XPI – bitte zuerst ./scripts/release.sh ausführen"; exit 1; }

BUILD=$(mktemp -d)
chmod 0755 "$BUILD"
trap 'rm -rf "$BUILD"' EXIT
mkdir -p "$BUILD/DEBIAN" "$BUILD/usr/share/teamkalender" \
         "$BUILD/usr/share/mozilla/extensions/${TB_APP_ID}" "$BUILD/usr/share/doc/${PKG}"

install -m 0644 "$XPI" "$BUILD/usr/share/teamkalender/teamkalender.xpi"
ln -s /usr/share/teamkalender/teamkalender.xpi \
      "$BUILD/usr/share/mozilla/extensions/${TB_APP_ID}/${ID}.xpi"

cat > "$BUILD/usr/share/doc/${PKG}/copyright" << 'TXT'
TeamKalender für Thunderbird
Copyright (c) Stefan Scherer, ts-scherer.com
Lizenz: Mozilla Public License 2.0 – https://mozilla.org/MPL/2.0/
Quellcode: https://github.com/Stefan2706/teamkalender
TXT

SIZE=$(du -sk "$BUILD/usr" | cut -f1)
cat > "$BUILD/DEBIAN/control" << CTRL
Package: ${PKG}
Version: ${VERSION}
Section: mail
Priority: optional
Architecture: all
Recommends: thunderbird
Installed-Size: ${SIZE}
Maintainer: Stefan Scherer <stefan@ts-scherer.com>
Homepage: https://github.com/Stefan2706/teamkalender
Description: TeamKalender – Kalender von Kollegen und Räumen nebeneinander
 Add-on für Thunderbird mit Nebeneinander-, Überlagern- und Zeitplan-Ansicht,
 Freie-Zeit-Finder mit Raumsuche, Termin-Vorschau mit Teilnehmen-Button,
 Farbkategorien und optionalem Outlook-Design für den Thunderbird-Kalender.
CTRL

cat > "$BUILD/DEBIAN/postinst" << 'SH'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  echo "TeamKalender installiert. Bitte Thunderbird neu starten und das Add-on beim Start aktivieren."
fi
exit 0
SH
chmod 0755 "$BUILD/DEBIAN/postinst"

OUT="dist/${PKG}_${VERSION}_all.deb"
dpkg-deb --root-owner-group --build "$BUILD" "$OUT" > /dev/null
echo "Fertig: $OUT"
