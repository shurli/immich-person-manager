import test from 'node:test';
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
  const html = read('public/index.html');
  const app = read('public/app.js');
  assert.match(html, /<title>immich-person-manager<\/title>/);
  assert.match(html, /<strong>immich-person-manager<\/strong>/);
  assert.doesNotMatch(html, /Immich Person (?:Review|Manager)/);
  assert.match(app, /all\.sort\(comparePeopleKnownFirst\)/);
  assert.match(app, /requestAnimationFrame\(\(\) => \$\('#mergeTargetSearch'\)\.focus\(\)\)/);
  assert.match(app, /Verbunden · immich-person-manager/);
  assert.doesNotMatch(app, /s\\.keyName/);
  assert.match(read('server.mjs'), /detectAssetFacePersonColumn/);
  assert.match(read('Dockerfile'), /asset-face-schema\\.mjs/);
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
  assert.match(html, /immich-person-manager/);
  assert.doesNotMatch(html, /Person Review|Immich Person Manager/);
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
