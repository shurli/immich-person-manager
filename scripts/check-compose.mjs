import assert from 'node:assert/strict';
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
