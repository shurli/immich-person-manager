from pathlib import Path
import json
import subprocess

FILES = {}
FILES['docker-compose.yml'] = '''services:
  immich-person-manager:
    container_name: immich-person-manager
    image: "ghcr.io/shurli/immich-person-manager:${IMAGE_TAG:-latest}"
    restart: unless-stopped
    ports:
      - "${PORT:-3003}:${PORT:-3003}"
    networks:
      - immich
    environment:
      PORT: "${PORT:-3003}"
      IMMICH_URL: "${IMMICH_URL:-http://immich_server:2283}"
      IMMICH_EXTERNAL_URL: "${IMMICH_EXTERNAL_URL:-}"
      IMMICH_API_PREFIX: "${IMMICH_API_PREFIX-/api}"
      IMMICH_API_KEY: "${IMMICH_API_KEY:?Set IMMICH_API_KEY in .env}"

      # Optional: read-only PostgreSQL access for face vector clusters.
      # Existing DB_* variables remain supported as fallbacks.
      IMMICH_DB_URL: "${IMMICH_DB_URL:-}"
      IMMICH_DB_HOST: "${IMMICH_DB_HOST:-${DB_HOSTNAME:-}}"
      IMMICH_DB_PORT: "${IMMICH_DB_PORT:-${DB_PORT:-5432}}"
      IMMICH_DB_USER: "${IMMICH_DB_USER:-${DB_USERNAME:-immich_person_manager}}"
      IMMICH_DB_PASSWORD: "${IMMICH_DB_PASSWORD-${DB_PASSWORD:-}}"
      IMMICH_DB_NAME: "${IMMICH_DB_NAME:-${DB_DATABASE_NAME:-immich}}"
      IMMICH_DB_SSL: "${IMMICH_DB_SSL:-false}"

      VECTOR_CLUSTER_DEFAULT_RADIUS: "${VECTOR_CLUSTER_DEFAULT_RADIUS:-}"
      VECTOR_CLUSTER_MAX_FACES: "${VECTOR_CLUSTER_MAX_FACES:-30000}"
      VECTOR_CLUSTER_MAX_ADJACENT_PEOPLE: "${VECTOR_CLUSTER_MAX_ADJACENT_PEOPLE:-50}"
      VECTOR_CLUSTER_ADJACENT_CANDIDATE_POOL: "${VECTOR_CLUSTER_ADJACENT_CANDIDATE_POOL:-500}"

networks:
  immich:
    external: true
    name: "${IMMICH_NETWORK:-immich_default}"
'''
FILES['docker-compose.build.yml'] = '''# Optional local build; the default Compose file only pulls the GHCR image.
# docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
services:
  immich-person-manager:
    build: .
    image: immich-person-manager:local
'''
FILES['docker-compose.immich-network.yml'] = '''# Compatibility override: the main Compose file already joins this network.
services:
  immich-person-manager:
    networks:
      - immich
networks:
  immich:
    external: true
    name: "${IMMICH_NETWORK:-immich_default}"
'''
FILES['.env.example'] = '''# Host and container port (same value, as in immich-tag-manager).
PORT=3003
# Use latest or pin a published version, for example 0.14.0.
IMAGE_TAG=latest
IMMICH_NETWORK=immich_default

# Internal Immich address on the Docker network.
IMMICH_URL=http://immich_server:2283
# Browser-facing address used for links, not API requests.
IMMICH_EXTERNAL_URL=https://photos.example.com
IMMICH_API_PREFIX=/api
IMMICH_API_KEY=REPLACE_WITH_YOUR_API_KEY

# Optional: read-only database access for face vector clusters.
# Uncomment the host (or IMMICH_DB_URL) to enable it.
# IMMICH_DB_HOST=database
IMMICH_DB_PORT=5432
# Existing installations may keep IMMICH_DB_USER=immich_person_review.
IMMICH_DB_USER=immich_person_manager
IMMICH_DB_PASSWORD=REPLACE_WITH_READ_ONLY_PASSWORD
IMMICH_DB_NAME=immich
IMMICH_DB_SSL=false
# IMMICH_DB_URL=
# DB_HOSTNAME, DB_PORT, DB_USERNAME, DB_PASSWORD and DB_DATABASE_NAME
# remain supported as fallbacks when the corresponding IMMICH_DB_* is unset.

VECTOR_CLUSTER_DEFAULT_RADIUS=
VECTOR_CLUSTER_MAX_FACES=30000
VECTOR_CLUSTER_MAX_ADJACENT_PEOPLE=50
VECTOR_CLUSTER_ADJACENT_CANDIDATE_POOL=500
'''
FILES['Dockerfile'] = '''FROM node:22-alpine
LABEL org.opencontainers.image.title="Immich Person Manager" \\
      org.opencontainers.image.description="Review and manage Immich people and face assignments" \\
      org.opencontainers.image.source="https://github.com/shurli/immich-person-manager"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts
COPY --chown=node:node server.mjs cluster-math.mjs ./
COPY --chown=node:node public ./public
ENV NODE_ENV=production PORT=3003
USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.mjs"]
'''
FILES['MIGRATION.md'] = '''# Migration zu Immich Person Manager

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
'''
FILES['scripts/check-compose.mjs'] = r'''import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(IMMICH_|DB_|VECTOR_CLUSTER_|COMPOSE_|PORT$|IMAGE_TAG$)/.test(key)) delete env[key];
}
function render(overrides = {}, extraFiles = []) {
  const args = ['compose', '--project-name', 'immich-person-manager-ci', '--env-file', '/dev/null', '-f', 'docker-compose.yml'];
  for (const file of extraFiles) args.push('-f', file);
  args.push('config', '--format', 'json');
  return JSON.parse(execFileSync('docker', args, {
    env: { ...env, IMMICH_API_KEY: 'ci-placeholder', ...overrides },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
}
function service(config) { return config.services['immich-person-manager']; }
function checkPort(config, port) {
  const app = service(config);
  assert.equal(app.environment.PORT, String(port));
  assert.equal(app.ports.length, 1);
  assert.equal(app.ports[0].target, port);
  assert.equal(app.ports[0].published, String(port));
}
const defaults = render();
checkPort(defaults, 3003);
assert.deepEqual(Object.keys(defaults.services), ['immich-person-manager']);
assert.equal(service(defaults).image, 'ghcr.io/shurli/immich-person-manager:latest');
assert.equal(service(defaults).build, undefined);
assert.equal(service(defaults).environment.IMMICH_URL, 'http://immich_server:2283');
assert.equal(service(defaults).environment.IMMICH_DB_HOST, '');
assert.equal(service(defaults).environment.IMMICH_DB_USER, 'immich_person_manager');
assert.equal(defaults.networks.immich.external, true);
assert.equal(defaults.networks.immich.name, 'immich_default');
checkPort(render({ PORT: '' }), 3003);
const custom = render({ PORT: '43123', IMAGE_TAG: '0.14.0', IMMICH_NETWORK: 'photos', IMMICH_URL: 'http://custom:2283', IMMICH_API_PREFIX: '', VECTOR_CLUSTER_MAX_FACES: '12000' });
checkPort(custom, 43123);
assert.equal(service(custom).image, 'ghcr.io/shurli/immich-person-manager:0.14.0');
assert.equal(custom.networks.immich.name, 'photos');
assert.equal(service(custom).environment.IMMICH_URL, 'http://custom:2283');
assert.equal(service(custom).environment.IMMICH_API_PREFIX, '');
assert.equal(service(custom).environment.VECTOR_CLUSTER_MAX_FACES, '12000');
const legacy = { DB_HOSTNAME: 'db', DB_PORT: '5544', DB_USERNAME: 'legacy_reader', DB_PASSWORD: 'legacy-password', DB_DATABASE_NAME: 'photos' };
const fallback = service(render(legacy)).environment;
assert.equal(fallback.IMMICH_DB_HOST, 'db');
assert.equal(fallback.IMMICH_DB_PORT, '5544');
assert.equal(fallback.IMMICH_DB_USER, 'legacy_reader');
assert.equal(fallback.IMMICH_DB_PASSWORD, 'legacy-password');
assert.equal(fallback.IMMICH_DB_NAME, 'photos');
const explicit = service(render({ ...legacy, IMMICH_DB_USER: 'immich_person_review', IMMICH_DB_PASSWORD: '' })).environment;
assert.equal(explicit.IMMICH_DB_USER, 'immich_person_review');
assert.equal(explicit.IMMICH_DB_PASSWORD, '');
const networkOverride = render({ IMMICH_NETWORK: 'custom-network' }, ['docker-compose.immich-network.yml']);
assert.deepEqual(Object.keys(networkOverride.services), ['immich-person-manager']);
assert.equal(networkOverride.networks.immich.name, 'custom-network');
const build = service(render({}, ['docker-compose.build.yml']));
assert.ok(build.build);
assert.equal(build.image, 'immich-person-manager:local');
assert.throws(() => render({ IMMICH_API_KEY: '' }), /IMMICH_API_KEY/);
console.log('Compose checks passed: defaults, custom/empty port, image tag, network, DB compatibility, API prefix and local build.');
'''
FILES['scripts/check-container.sh'] = r'''#!/usr/bin/env bash
set -euo pipefail
image="${1:-immich-person-manager:test}"
container=''
cleanup() {
  if [ -n "$container" ]; then
    docker logs "$container" || true
    docker rm -f "$container" >/dev/null || true
  fi
}
trap cleanup EXIT
for mode in default custom; do
  port=3003
  options=()
  if [ "$mode" = custom ]; then
    port=43123
    options=(-e "PORT=$port")
  fi
  container="person-manager-ci-$mode"
  docker run --rm -d --name "$container" \
    -p "127.0.0.1::$port" --health-interval=1s --health-start-period=1s \
    -e IMMICH_URL=http://127.0.0.1:9 -e IMMICH_API_KEY=ci-not-a-real-key \
    "${options[@]}" "$image"
  binding="$(docker port "$container" "$port/tcp")"
  base="http://$binding"
  curl --silent --show-error --fail --retry 15 --retry-delay 1 \
    --retry-all-errors --retry-max-time 30 --max-time 3 "$base/healthz" \
    | node -e "let s=''; for await (const c of process.stdin) s+=c; const h=JSON.parse(s); if (!h.ok || h.app!=='immich-person-manager') process.exit(1)" --input-type=module
  curl --silent --show-error --fail "$base/" | grep 'Immich Person Manager' >/dev/null
  test "$(docker exec "$container" id -u)" = 1000
  healthy=false
  for attempt in $(seq 1 30); do
    if [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ]; then
      healthy=true
      break
    fi
    sleep 1
  done
  test "$healthy" = true
  echo "Container checks passed: $mode port $port, HTTP, UI, non-root user and Docker healthcheck."
  cleanup
  container=''
done
'''
FILES['deployment.test.mjs'] = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
function serverEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(IMMICH_|DB_|PORT$)/.test(key)) delete env[key];
  return { ...env, IMMICH_URL: 'http://127.0.0.1:9', IMMICH_API_KEY: 'health-test-secret', ...extra };
}
test('package, lockfile, UI and Docker defaults use the manager identity', () => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'immich-person-manager');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(read('public/index.html'), /Immich Person Manager/);
  assert.match(read('Dockerfile'), /ENV NODE_ENV=production PORT=3003/);
  assert.match(read('Dockerfile'), /EXPOSE 3003/);
  for (const file of ['server.mjs', 'public/index.html', 'Dockerfile', 'docker-compose.yml', 'docker-compose.immich-network.yml']) {
    assert.doesNotMatch(read(file), /Immich Person Review|immich-person-review/, file);
  }
});
test('default port is 3003 and health does not need an upstream connection', async (t) => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url), env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) { child.kill(); await once(child, 'exit'); }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 10000);
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('Listening on :3003')) { clearTimeout(timeout); resolve(); }
    });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  const response = await fetch('http://127.0.0.1:3003/healthz');
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.deepEqual(health, { ok: true, app: pkg.name, version: pkg.version });
  assert.ok(!JSON.stringify(health).includes('health-test-secret'));
  const html = await (await fetch('http://127.0.0.1:3003/')).text();
  assert.match(html, /Immich Person Manager/);
});
test('invalid ports fail with a clear configuration error', () => {
  for (const port of ['0', '-1', '65536', '1.5', 'not-a-port']) {
    const result = spawnSync(process.execPath, ['server.mjs'], {
      cwd: new URL('.', import.meta.url), env: serverEnv({ PORT: port }), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined, port);
    assert.equal(result.status, 1, port);
    assert.match(result.stderr, /PORT must be an integer between 1 and 65535/, port);
  }
});
'''

DOCKER_DOCS = '''## Start mit Docker Compose (fertiges Image)

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
docker run -d \\
  --name immich-person-manager \\
  --restart unless-stopped \\
  --network immich_default \\
  --env-file .env \\
  -p 3003:3003 \\
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

'''

def main():
    tracked = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
    for name in tracked:
        p = Path(name)
        if not name or not p.is_file() or name.startswith(('.github/', '.maintenance')) or name == 'MIGRATION.md':
            continue
        if p.suffix not in {'.mjs', '.js', '.html', '.json', '.md', '.yml', '.yaml'}:
            continue
        text = p.read_text()
        updated = text.replace('Immich Person Review', 'Immich Person Manager').replace('immich-person-review', 'immich-person-manager')
        if p.suffix != '.md':
            updated = updated.replace('0.13.0', '0.14.0')
        if updated != text:
            p.write_text(updated)
    for name in ['package.json', 'package-lock.json']:
        p = Path(name)
        data = json.loads(p.read_text())
        data.update(name='immich-person-manager', version='0.14.0')
        if name == 'package.json':
            data['scripts']['check:compose'] = 'node scripts/check-compose.mjs'
        else:
            data['packages'][''].update(name='immich-person-manager', version='0.14.0')
        p.write_text(json.dumps(data, indent=2) + '\n')
    p = Path('server.mjs')
    text = p.read_text()
    old = 'const port = Number(process.env.PORT || 3000);'
    assert text.count(old) == 1, 'Unexpected server port declaration'
    text = text.replace(old, "const port = Number(process.env.PORT || 3003);\nif (!Number.isInteger(port) || port < 1 || port > 65535) {\n  console.error('PORT must be an integer between 1 and 65535.');\n  process.exit(1);\n}")
    old = "  if (url.pathname.startsWith('/review-api/')) return handleApi(req, res, url);"
    assert text.count(old) == 1, 'Unexpected HTTP dispatcher'
    text = text.replace(old, "  if (req.method === 'GET' && url.pathname === '/healthz') {\n    return json(res, 200, { ok: true, app: packageInfo.name, version: appVersion });\n  }\n" + old)
    p.write_text(text)
    p = Path('app-isolation.test.mjs')
    text = p.read_text().replace("assert.equal(status.version, '0.14.0')", "assert.equal(status.version, JSON.parse(fs.readFileSync(new URL('package.json', import.meta.url), 'utf8')).version)")
    old = '  const base = `http://127.0.0.1:${port}`;'
    assert text.count(old) == 1
    text = text.replace(old, old + "\n  const health = await (await fetch(base + '/healthz')).json();\n  assert.equal(health.ok, true);\n  assert.equal(health.app, 'immich-person-manager');\n  assert.equal(seen.length, 0, 'healthcheck must not contact Immich');")
    p.write_text(text)
    p = Path('README.md')
    text = p.read_text().replace('immich_person_review', 'immich_person_manager').replace('http://immich-server:2283', 'http://immich_server:2283')
    text = text.replace('## Version 0.13.0', '## Version 0.14.0\n\nUmbenannt von **Immich Person Review** zu **Immich Person Manager**. Die\nStandardinstallation nutzt jetzt `ghcr.io/shurli/immich-person-manager:latest`\nmit konfigurierbarem Port (Standard **3003**), wie beim Tag Manager.\nBestehende Installationen: zuerst die Hinweise in `MIGRATION.md` beachten.\n')
    text = text.replace('Neu in dieser Version:', 'Bereits enthalten:')
    start = text.index('## Start mit Docker Compose')
    end = text.index('## Cluster-Mathematik')
    text = text[:start] + DOCKER_DOCS + text[end:]
    text = text.replace('Review-App', 'Person-Manager-App').replace('Review-Container', 'Person-Manager-Container')
    marker = '| Variable | Bedeutung | Standard |\n|---|---|---|\n'
    assert marker in text
    text = text.replace(marker, marker + '| `PORT` | HTTP-Port fuer Host und Container | `3003` |\n| `IMAGE_TAG` | GHCR-Image-Tag (Compose) | `latest` |\n| `IMMICH_NETWORK` | vorhandenes externes Docker-Netz (Compose) | `immich_default` |\n')
    text = text.replace('| `IMMICH_URL` | interne Basis-URL des Immich-Servers | erforderlich |', '| `IMMICH_URL` | interne Basis-URL des Immich-Servers | Compose: `http://immich_server:2283`; ohne Compose erforderlich |')
    text = text.replace('| `IMMICH_DB_USER` | PostgreSQL-Benutzer | `postgres` |', '| `IMMICH_DB_USER` | PostgreSQL-Benutzer | Compose: `immich_person_manager`; direkt: `postgres` |')
    text = text.replace('## Architektur und Datenschutz', 'Die bisherigen `DB_HOSTNAME`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` und\n`DB_DATABASE_NAME` bleiben als Fallbacks erhalten. Explizite `IMMICH_DB_*`\nWerte haben Vorrang; ein explizit leeres `IMMICH_DB_PASSWORD` bleibt leer.\nEin bestehender Read-only-Benutzer kann unveraendert weiterverwendet werden.\n\n## Architektur und Datenschutz')
    text = text.replace('npm install\nnpm test\nnpm start', 'npm ci\nnpm test\nnpm run check\n# Mit installiertem Docker Compose:\nnpm run check:compose\n# Die Node-App liest .env nicht selbst ein:\nset -a\n. ./.env\nset +a\nnpm start')
    p.write_text(text)
    for name, content in FILES.items():
        p = Path(name)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    subprocess.run(['git', 'diff', '--check'], check=True)
    print('Prepared Immich Person Manager 0.14.0 with image-based Compose and default port 3003.')

if __name__ == '__main__':
    main()
