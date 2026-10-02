# Immich Person Manager

Eigenständige Docker-Web-App zum Prüfen und Korrigieren von Immich-Personenzuordnungen.

## Version 0.14.0

Umbenannt von **Immich Person Review** zu **Immich Person Manager**. Die
Standardinstallation nutzt jetzt `ghcr.io/shurli/immich-person-manager:latest`
mit konfigurierbarem Port (Standard **3003**), wie beim Tag Manager.
Bestehende Installationen: zuerst die Hinweise in `MIGRATION.md` beachten.


Die Tag-Verwaltung wurde in das eigenstaendige Repository `shurli/immich-tag-manager` ausgelagert. Alle Personen- und Gesichtsfunktionen bleiben erhalten. Hinweise zur Uebernahme der bisherigen Tag-Datei stehen in `MIGRATION.md`.

### Bisheriger Personen-Funktionsumfang

Bereits enthalten:

- optionaler Layer für angrenzende Personen im Vektorgraphen,
- einstellbare Anzahl der angezeigten Nachbarpersonen,
- farbige und nummerierte Personenmittelpunkte in derselben radialen Projektion,
- Personen-Thumbnail und Distanz beim Überfahren eines Nachbarpunkts,
- Klick auf einen Nachbarpunkt öffnet einen Dialog zum Öffnen in Immich oder zum direkten Zusammenführen mit der aktuell geprüften Person,
- die aktuelle Person bleibt beim Zusammenführen als Ziel bestehen,
- die Asset-Galerie lässt sich zwischen `außerhalb`, `innerhalb` und `alle` umschalten; innerhalb des Radius stehen die grenzwertigsten Faces zuerst,
- der Mittelpunkt `c` des Vektor-Kreises kann direkt im Diagramm mit der Maus oder per Touch verschoben werden,
- alle Cosinusabstände werden dabei zum neuen Mittelpunkt im hochdimensionalen Raum neu berechnet,
- die Punkte werden radial um das aktuelle Zentrum neu projiziert, sodass der sichtbare Radius weiterhin dem tatsächlichen Abstand entspricht,
- beim Überfahren eines Vektorpunkts wird ein zugeschnittener Face-Thumbnail geladen,
- Asset-Karten enthalten einen Link zum zugehörigen Asset in Immich,
- interne API-Verbindung und externe Browser-URL sind getrennt:
  - `IMMICH_URL` für die Kommunikation innerhalb des Docker-Netzes,
  - `IMMICH_EXTERNAL_URL` für Personen- und Asset-Links im Browser,
- `docker-compose.yml` enthält die Anbindung an das externe Netzwerk `immich_default` bereits vollständig.

Die App schreibt **nicht direkt** in die Immich-Datenbank. Änderungen an Personenzuordnungen laufen über die Immich-REST-API. PostgreSQL wird nur lesend für Face-Embeddings und die dazugehörigen Metadaten verwendet.

## Funktionsumfang

- Person auswählen oder suchen
- Personen-Timeline paginiert und chronologisch anzeigen
- Asset, Face-Bounding-Box und vergrößerten Gesichtsausschnitt anzeigen
- Alter zum Aufnahmezeitpunkt berechnen
- Face einer anderen oder einer neuen Person zuweisen
- Personenzuordnung lösen, ohne Face-Markierung und Embedding zu löschen
- Face-Markierung vollständig entfernen
- Zuordnungen vor dem Geburtsdatum gesammelt prüfen und lösen
- unbenannte Personen anzeigen, verstecken oder zusammenführen
- Personen-Thumbnails aktualisieren
- doppelte Face-Boxen innerhalb desselben Assets bereinigen
- 512D-Vektorcluster mit:
  - Durchschnittsvektor und normierter Mittelrichtung `μ`,
  - verschiebbarem aktuellem Zentrum `c`,
  - frei wählbarem Distanzradius,
  - P90-/P95-Presets für das aktuelle Zentrum,
  - Hover-Face-Thumbnail,
  - optionalen angrenzenden Personen als eigene farbige Punkte,
  - einstellbarer Anzahl von Nachbarpersonen,
  - Hover-Personen-Thumbnail sowie direktem Öffnen oder Zusammenführen,
  - umschaltbarer Asset-Galerie für Faces außerhalb, innerhalb oder unabhängig vom Radius,
  - Mehrfachauswahl und Lösen der Zuordnung,
  - JSON-Export einschließlich aktuellem Mittelpunkt und neu berechneten Abständen.

## Konfiguration

```bash
cp .env.example .env
nano .env
```

Mindestens erforderlich:

```dotenv
# Interne URL des Immich-Servers im Docker-Netz
IMMICH_URL=http://immich_server:2283
IMMICH_API_PREFIX=/api
IMMICH_API_KEY=DEIN_API_KEY

# Vom Browser erreichbare Webadresse
IMMICH_EXTERNAL_URL=https://photos.example.com
```

`IMMICH_EXTERNAL_URL` wird ausschließlich für Links verwendet. Der API-Key und die interne Docker-Adresse werden nicht an den Browser weitergegeben.

Für die Clusteransicht zusätzlich:

```dotenv
IMMICH_DB_HOST=database
IMMICH_DB_PORT=5432
IMMICH_DB_USER=immich_person_manager
IMMICH_DB_PASSWORD=DEIN_READ_ONLY_PASSWORT
IMMICH_DB_NAME=immich
IMMICH_DB_SSL=false
```

Alternativ kann eine vollständige Verbindung in `IMMICH_DB_URL` gesetzt werden.

## Read-only-PostgreSQL-Benutzer

Als PostgreSQL-Administrator in der Immich-Datenbank ausführen:

```sql
CREATE ROLE immich_person_manager
  LOGIN
  PASSWORD 'EIN_LANGES_ZUFAELLIGES_PASSWORT'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;

GRANT CONNECT ON DATABASE immich TO immich_person_manager;
GRANT USAGE ON SCHEMA public TO immich_person_manager;
GRANT SELECT ON TABLE
  public.asset,
  public.asset_face,
  public.face_search
TO immich_person_manager;
```

Nach einer Immich-Migration, die eine dieser Tabellen neu erstellt, müssen die `GRANT`-Anweisungen gegebenenfalls erneut ausgeführt werden.

## Start mit Docker Compose (fertiges Image)

`docker-compose.yml` verwendet wie der Tag Manager ein veroeffentlichtes
GHCR-Image. Ein Checkout des Quellcodes oder ein lokaler Build ist zum Betrieb
nicht notwendig; `docker-compose.yml` und eine `.env` genuegen.

```bash
cp .env.example .env
nano .env
# API-Key und interne/externe Immich-URL eintragen.
docker compose config --quiet
docker compose pull
docker compose up -d
```

Die zentrale Konfiguration lautet:

```yaml
services:
  immich-person-manager:
    image: "ghcr.io/shurli/immich-person-manager:${IMAGE_TAG:-latest}"
    ports:
      - "${PORT:-3003}:${PORT:-3003}"
    environment:
      PORT: "${PORT:-3003}"
```

Dies ist ein Ausschnitt; Netzwerk, API-Key, Datenbank- und Vektoroptionen
stehen vollstaendig in der mitgelieferten Compose-Datei.

Die Oberflaeche ist standardmaessig unter `http://DEIN-SERVER:3003` erreichbar.
Ein anderer Port wird ausschliesslich in `.env` eingestellt:

```dotenv
PORT=3103
```

Danach `docker compose up -d` ausfuehren. Host-Port, Server und Healthcheck
verwenden denselben Wert. Ein nicht gesetztes oder leeres `PORT` ergibt 3003.
Der Image-Tag ist mit `IMAGE_TAG=latest` oder z. B. `IMAGE_TAG=0.14.0` waehlbar.
Die gewuenschte Version muss bereits im GHCR veroeffentlicht sein.

Das externe Docker-Netz muss bereits existieren:

```bash
docker network ls | grep immich
```

Standard ist `immich_default`; einen anderen Namen mit `IMMICH_NETWORK` in
`.env` setzen. `IMMICH_URL` muss aus diesem Netz erreichbar sein; Standard
ist `http://immich_server:2283`. Den tatsaechlichen Servicenamen der eigenen
Immich-Installation verwenden.

```bash
docker compose ps
docker compose logs -f immich-person-manager
# Spaeter auf den konfigurierten Image-Tag aktualisieren:
docker compose pull
docker compose up -d
```

`GET /healthz` meldet App-Name und Version ohne API-Key oder Datenbankpasswort.
Der Docker-Healthcheck prueft damit nur die lokale App. Fuer den Status der
Immich-/Datenbankverbindung ist weiterhin die Statusanzeige in der Oberflaeche
massgeblich. Personen- und Gesichtsaenderungen verwenden weiterhin `/review-api/`.

Die App besitzt keine eigene Anmeldung. Nur in einem vertrauenswuerdigen
Netz oder hinter einem Reverse Proxy mit Zugriffsschutz bereitstellen;
nicht ungeschuetzt ins Internet exponieren.

### Optional lokal bauen

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Das Build-Override verwendet `immich-person-manager:local`, damit der lokale
Build nicht versehentlich den gepullten GHCR-Tag ueberschreibt.

## Nur Docker

Mit ausgefuellter `.env` und dem Standardport:

```bash
docker pull ghcr.io/shurli/immich-person-manager:latest
docker run -d \
  --name immich-person-manager \
  --restart unless-stopped \
  --network immich_default \
  --env-file .env \
  -p 3003:3003 \
  ghcr.io/shurli/immich-person-manager:latest
```

Bei einem anderen `PORT` muessen beide Seiten von `-p` denselben Wert
verwenden, z. B. `-p 3103:3103` fuer `PORT=3103`. `IMAGE_TAG` und
`IMMICH_NETWORK` in `.env` werden nur von Compose ausgewertet; bei
`docker run` Image-Tag und `--network` direkt anpassen.

## Image-Veroeffentlichung

Der GitHub-Actions-Workflow prueft Tests, JavaScript-Syntax, Compose und
Containerstart inklusive Healthcheck mit Standard- und individuellem Port.
Erst nach erfolgreicher Pruefung auf `main` wird
`ghcr.io/shurli/immich-person-manager` veroeffentlicht. Die Tags sind
`latest`, die Version aus `package.json`, deren Minor-Version und `sha-...`.
Pull Requests veroeffentlichen keine Images.

Ein neues GHCR-Paket muss fuer anonyme Pulls oeffentlich sein. Bei
`denied`/`unauthorized` die Sichtbarkeit und Actions-Berechtigungen des
Pakets pruefen; private Pakete erfordern `docker login ghcr.io`.

## Cluster-Mathematik

Jedes Face-Embedding wird L2-normalisiert. Aus den normalisierten Embeddings wird zunächst der arithmetische Mittelwert und daraus die normierte Mittelrichtung `μ` berechnet.

Für ein normalisiertes Face-Embedding `x` und das aktuelle Zentrum `c` gilt:

```text
Cosinusdistanz d(x, c) = 1 - x · c
```

Kleine Werte bedeuten hohe Ähnlichkeit zum aktuellen Zentrum.

### Verschieben des Mittelpunkts

Die ersten beiden PCA-Richtungen im Tangentialraum von `μ` bilden zusammen mit `μ` einen dreidimensionalen Unterraum der 512-dimensionalen Einbettung. Beim Ziehen des Mittelpunkts wird `c` auf der Einheitssphäre innerhalb dieses Unterraums bewegt.

Für jeden Punkt speichert der Server nur drei skalare Projektionen:

- `x · μ`
- `x · pc1`
- `x · pc2`

Damit kann der Browser den exakten Skalarproduktswert `x · c` für jeden zulässigen verschobenen Mittelpunkt berechnen, ohne das vollständige Face-Embedding an den Browser zu senden.

Die Winkelachsen werden entlang der Bewegung parallel transportiert. Anschließend wird jeder Punkt mit seinem echten Abstand `d(x, c)` radial um den neuen Mittelpunkt gezeichnet. Daher stimmt „innerhalb/außerhalb des Kreises“ auch nach dem Verschieben mit dem neu berechneten hochdimensionalen Abstand überein.

### Galeriefilter

- **Außerhalb:** `d(x, c) > Radius`, größte Distanz zuerst.
- **Innerhalb:** `d(x, c) ≤ Radius`, ebenfalls größte Distanz zuerst; dadurch stehen die grenzwertigsten noch enthaltenen Faces zuerst.
- **Alle:** sämtliche Faces nach abnehmender Distanz.

Beim Wechsel des Filters werden nicht mehr sichtbare Markierungen aus Sicherheitsgründen verworfen, damit die Aktion „Personenzuordnung lösen“ nur auf die aktuell angezeigte Gruppe wirkt.

### Angrenzende Personen

Der Nachbarpersonen-Layer ist standardmäßig ausgeschaltet. Nach dem Aktivieren kann die Zahl der dargestellten Personen eingestellt werden.

Die Berechnung läuft in zwei Stufen:

1. Immich liefert eine begrenzte Kandidatenmenge anhand der Ähnlichkeit zum Feature-Face der aktuellen Person.
2. Für jeden Kandidaten berechnet die Person-Manager-App aus allen sichtbaren Face-Embeddings mit Personenzuordnung einen Durchschnitt, normalisiert ihn und bestimmt dessen Cosinusdistanz zur normierten Mittelrichtung der aktuellen Person.

Die endgültige Reihenfolge im Diagramm verwendet damit den Personenmittelpunkt und nicht nur ein einzelnes Feature-Face. Jeder Nachbar wird als eigener farbiger, nummerierter Punkt in die PCA-Basis der aktuellen Person projiziert. Wird der Mittelpunkt `c` verschoben, werden auch die Abstände der Nachbarpersonen zum neuen Mittelpunkt neu berechnet.

Ein Klick auf einen Nachbarpunkt bietet zwei Aktionen:

- Person in Immich öffnen,
- Nachbarperson in die aktuell geprüfte Person zusammenführen.

Beim Zusammenführen ist die Nachbarperson die Quelle und die aktuell geöffnete Person das Ziel. Die Quelle wird nach der Übernahme ihrer Face-Zuordnungen von Immich entfernt.

## Benötigte Immich-API-Rechte

Je nach verwendeter Funktion:

- `person.read`
- `person.create`
- `person.update`
- `person.delete`
- `person.merge`
- `asset.read`
- `asset.view`
- `face.read`
- `face.update`
- `face.delete`

Für das Lösen einer Zuordnung wird das Face kurz einer versteckten temporären Person zugewiesen. Danach wird diese Person gelöscht. Dadurch bleibt die Face-Markierung erhalten, während ihre Personenzuordnung leer wird.

## Konfigurationsvariablen

| Variable | Bedeutung | Standard |
|---|---|---|
| `PORT` | HTTP-Port fuer Host und Container | `3003` |
| `IMAGE_TAG` | GHCR-Image-Tag (Compose) | `latest` |
| `IMMICH_NETWORK` | vorhandenes externes Docker-Netz (Compose) | `immich_default` |
| `IMMICH_URL` | interne Basis-URL des Immich-Servers | Compose: `http://immich_server:2283`; ohne Compose erforderlich |
| `IMMICH_EXTERNAL_URL` | vom Browser erreichbare Immich-Webadresse für Links | fällt aus Kompatibilitätsgründen auf `IMMICH_URL` zurück |
| `IMMICH_API_PREFIX` | API-Prefix | `/api` |
| `IMMICH_API_KEY` | serverseitig verwendeter API-Key | erforderlich |
| `IMMICH_DB_URL` | vollständige PostgreSQL-Verbindungszeichenfolge | leer |
| `IMMICH_DB_HOST` | PostgreSQL-Host, falls keine URL verwendet wird | leer |
| `IMMICH_DB_PORT` | PostgreSQL-Port | `5432` |
| `IMMICH_DB_USER` | PostgreSQL-Benutzer | Compose: `immich_person_manager`; direkt: `postgres` |
| `IMMICH_DB_PASSWORD` | PostgreSQL-Passwort | leer |
| `IMMICH_DB_NAME` | Datenbankname | `immich` |
| `IMMICH_DB_SSL` | TLS-Verbindung aktivieren | `false` |
| `VECTOR_CLUSTER_DEFAULT_RADIUS` | fester Startwert; leer bedeutet P90 je Person | leer |
| `VECTOR_CLUSTER_MAX_FACES` | Sicherheitslimit je Person | `30000` |
| `VECTOR_CLUSTER_MAX_ADJACENT_PEOPLE` | maximal auswählbare Anzahl angrenzender Personen | `50` |
| `VECTOR_CLUSTER_ADJACENT_CANDIDATE_POOL` | Größe der von Immich vorselektierten Kandidatenmenge | `500` |

Die bisherigen `DB_HOSTNAME`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` und
`DB_DATABASE_NAME` bleiben als Fallbacks erhalten. Explizite `IMMICH_DB_*`
Werte haben Vorrang; ein explizit leeres `IMMICH_DB_PASSWORD` bleibt leer.
Ein bestehender Read-only-Benutzer kann unveraendert weiterverwendet werden.

## Architektur und Datenschutz

```text
Browser
  └─ Person-Manager-Container
       ├─ Immich REST API       über IMMICH_URL
       ├─ Immich-Weblinks       über IMMICH_EXTERNAL_URL
       └─ PostgreSQL read-only  für Embeddings und Face-/Asset-Metadaten
```

API-Key und Datenbankpasswort werden nicht an den Browser ausgegeben. Einzelne vollständige Face-Embeddings werden ebenfalls nicht gesendet. Für das Verschieben des Zentrums erhält der Browser pro Face nur drei skalare Projektionswerte sowie die für die Darstellung benötigten Metadaten.

Auch bei Nachbarpersonen erhält der Browser nicht deren vollständigen Durchschnittsvektor, sondern nur Distanz und drei skalare Projektionen in die Basis des aktuell geöffneten Clusters. Die bestehenden Read-only-Rechte auf `asset`, `asset_face` und `face_search` reichen weiterhin aus; ein zusätzliches `SELECT` auf `person` ist nicht erforderlich.

## Entwicklung und Tests

```bash
npm ci
npm test
npm run check
# Mit installiertem Docker Compose:
npm run check:compose
# Die Node-App liest .env nicht selbst ein:
set -a
. ./.env
set +a
npm start
```
