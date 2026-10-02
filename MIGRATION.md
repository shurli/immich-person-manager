# Migration zu Immich Person Manager

## Umbenennung und Image-Deployment ab 0.14.0

Das Repository `shurli/immich-person-review` heisst jetzt
`shurli/immich-person-manager`. App, npm-Paket, Container und Compose-Service
heissen entsprechend **Immich Person Manager** bzw. `immich-person-manager`.
Das veroeffentlichte Image ist `ghcr.io/shurli/immich-person-manager:latest`.
Die Standard-Compose-Datei benoetigt keinen lokalen Build mehr.

Der neue Standardport ist **3003**, fuer Host und Container. Mit `PORT=3030`
in `.env` bleibt die bisherige Browseradresse mit Port 3030 verwendbar.
Ein bereits gesetztes `PORT` wird weiter beruecksichtigt; es steuert jetzt
auch das Port-Mapping. Das Docker-Netz bleibt `immich_default`, konfigurierbar
ueber `IMMICH_NETWORK`. Der Tag Manager verwendet standardmaessig Port 3002.

### Bestehende Installation uebernehmen

1. Bestehende `.env` sichern und beibehalten, nicht mit `.env.example`
   ueberschreiben. `PORT=3003` (oder den gewuenschten bisherigen Port) und
   optional `IMAGE_TAG=latest` ergaenzen. Interne/externe Immich-URLs,
   API-Key, Datenbankzugang und Vektoroptionen bleiben erhalten.
2. Den neuen Compose-Stand verwenden. Das alte `image: immich-person-review:...`,
   `build: .`, den alten Service-/Containernamen und festes `3030:3000` nicht
   aus einem alten Override uebernehmen. Eigene Overrides auf den neuen
   Service `immich-person-manager` umstellen.
3. Alten Container erst nach einer erforderlichen Tag-Datei-Sicherung (unten)
   stoppen und die neue Instanz starten:

   ```sh
   docker stop immich-person-review
   docker compose config --quiet
   docker compose pull
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 immich-person-manager
   ```

4. Nach erfolgreicher Pruefung kann der gestoppte alte Container entfernt werden:

   ```sh
   docker rm immich-person-review
   ```

**Keine Volumes loeschen und kein `down -v` ausfuehren.** Fuer diese
Umbenennung sind weder Datenmigration noch Schreibzugriffe auf PostgreSQL
notwendig. Die Personen-App verwendet weiterhin kein eigenes Daten-Volume.
Ein Rollback auf die alte gesicherte Compose-Datei bleibt moeglich; vorher
den neuen Container stoppen, damit der Port frei ist.

### Datenbankbenutzer und API-Kompatibilitaet

Der bestehende Read-only-Benutzer `immich_person_review` bleibt gueltig:

```dotenv
IMMICH_DB_USER=immich_person_review
```

Es ist **kein** `ALTER ROLE` erforderlich. Nur die Beispiele fuer neue
Installationen verwenden `immich_person_manager`. Bereits gesetzte
`IMMICH_DB_*` bzw. die bisherigen `DB_*`-Fallbacks bleiben unterstuetzt.
Die vorhandenen SELECT-Rechte auf `asset`, `asset_face` und `face_search`
reichen weiterhin aus. Die API-Pfade unter `/review-api/` bleiben unveraendert.
`/healthz` prueft nur die lokale App, nicht die Verbindung zu Immich oder PostgreSQL.

Wird auch der Browserport geaendert, entsteht ein anderer Browser-Origin;
etwaige lokal gespeicherte Browser-Einstellungen werden nicht automatisch
auf den neuen Origin uebernommen.

## Historisch: Auslagerung der Tag-Verwaltung ab 0.13.0

Ab 0.13.0 enthaelt die Personen-App nur noch Personen- und Gesichtsfunktionen.
`shurli/immich-tag-manager` uebernimmt die Tag-Taxonomie inklusive Prompts,
Thresholds, Kategorien und SigLIP2-Preview. Wer von einer aelteren Version
mit integriertem Tag-Editor migriert, muss die bearbeitete Taxonomie sichern.

### Vor dem Ersetzen eines alten Containers mit Tag-Editor

Zuerst im alten Tag-Editor speichern und die bestehende Datei sichern:

```sh
docker cp immich-person-review:/app/storage/tags.json ./tags-before-split.json
docker inspect immich-person-review --format '{{json .Mounts}}'
```

Bei einem individuellen `TAG_TAXONOMY_PATH` genau diesen Pfad sichern.
Vor Version 0.12.2 kann die Datei unter `/app/data/tags.json` liegen.
Die bearbeitete Datei steckt normalerweise in einem Compose-Volume,
nicht im Repository. **Kein `down -v` ausfuehren.**

Die Personen-App mountet und veraendert keine Taxonomie. Im separaten
Tag-Manager dessen `TAG_TAXONOMY_VOLUME` auf den tatsaechlich ermittelten
alten Volume-Namen setzen. Vor dem Start mit `docker volume inspect NAME`
pruefen, dass das Volume bereits existiert; ein Tippfehler koennte sonst
unbemerkt ein leeres Volume erzeugen. Dann im Tag-Manager-Verzeichnis:

```sh
docker compose pull
docker compose up -d
```

Die aktuelle Standard-Compose-Datei des Tag Managers bindet dieses Volume
bereits ein; ein `docker-compose.existing-taxonomy.yml` ist nicht erforderlich.
Alter und neuer Tag-Editor duerfen nicht gleichzeitig auf die Datei schreiben.
Datei und Verzeichnis muessen fuer UID 1000 schreibbar sein. Weitere Varianten
und Rollback stehen in `MIGRATION.md` des Tag-Manager-Repositories.

Alte Tag-/ML-Variablen werden von der Personen-App nicht verwendet und
koennen aus ihrer `.env` entfernt werden. Personen-/Face-API-Rechte und
Read-only-Datenbankrechte bleiben unveraendert erforderlich.

### Bekannter Altfehler

Die bisherige Standard-Taxonomie enthaelt fuer `diagram` und `chart` denselben
Pfad `KI/Medientypen/Diagramm`. Der Tag Manager korrigiert genau dieses Paar
beim Einlesen: `chart` erhaelt einen freien `KI/Medientypen/Schaubild`-Pfad.
Alle Konzept-IDs und Prompts bleiben erhalten. Die Korrektur wird angezeigt
und erst mit JSON speichern samt Backup persistiert. Die Auslagerung schreibt
weder Personen-/Gesichtsdaten noch Tags in Immich.
