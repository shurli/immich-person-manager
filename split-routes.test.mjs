// Integration test of the "Split group" routes against a real PostgreSQL with pgvector (and VectorChord when
// available) plus a mock Immich API. Skipped unless SPLIT_TEST_DB_URL points to a throwaway database, e.g.
//   docker run -d --name ipm-split-testdb -e POSTGRES_PASSWORD=test -e POSTGRES_DB=immich -p 127.0.0.1:55432:5432 \
//     ghcr.io/immich-app/postgres:18-vectorchord0.5.3-pgvector0.8.1
//   SPLIT_TEST_DB_URL=postgres://postgres:test@127.0.0.1:55432/immich node --test split-routes.test.mjs
// The test drops and recreates the tables asset, asset_face and face_search in that database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import pg from 'pg';

const dbUrl = process.env.SPLIT_TEST_DB_URL;

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '00000000-0000-4000-8000-000000000002';
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BERT = 'bbbbbbbb-0000-4000-8000-000000000001';
const GROUP = 'cccccccc-0000-4000-8000-000000000001';
const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function setupDatabase(db) {
  await db.query('DROP TABLE IF EXISTS face_search, asset_face, asset');
  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  await db.query(`CREATE TABLE asset (id uuid PRIMARY KEY, "ownerId" uuid NOT NULL, "deletedAt" timestamptz,
    "localDateTime" timestamptz NOT NULL, "fileCreatedAt" timestamptz, "createdAt" timestamptz DEFAULT now(), "originalFileName" text)`);
  await db.query(`CREATE TABLE asset_face (id uuid PRIMARY KEY, "assetId" uuid NOT NULL REFERENCES asset(id), "personGroupId" uuid,
    "imageWidth" int NOT NULL DEFAULT 1000, "imageHeight" int NOT NULL DEFAULT 800, "boundingBoxX1" int NOT NULL DEFAULT 100,
    "boundingBoxY1" int NOT NULL DEFAULT 100, "boundingBoxX2" int NOT NULL DEFAULT 200, "boundingBoxY2" int NOT NULL DEFAULT 220,
    "deletedAt" timestamptz, "isVisible" boolean NOT NULL DEFAULT true)`);
  await db.query('CREATE TABLE face_search ("faceId" uuid PRIMARY KEY REFERENCES asset_face(id), embedding vector(3) NOT NULL)');
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS vchord CASCADE');
    await db.query('CREATE INDEX face_index ON face_search USING vchordrq (embedding vector_cosine_ops)');
  } catch { /* plain pgvector: the query still works, just without the index */ }

  let n = 0;
  async function face({ person, vector, owner = OWNER, date = '2015-06-01T12:00:00Z' }) {
    n++;
    const assetId = uuid('dddddddd', n);
    const faceId = uuid('eeeeeeee', n);
    await db.query('INSERT INTO asset (id, "ownerId", "localDateTime", "originalFileName") VALUES ($1, $2, $3, $4)', [assetId, owner, date, `img${n}.jpg`]);
    await db.query('INSERT INTO asset_face (id, "assetId", "personGroupId") VALUES ($1, $2, $3)', [faceId, assetId, person]);
    await db.query('INSERT INTO face_search ("faceId", embedding) VALUES ($1, $2)', [faceId, `[${vector.join(',')}]`]);
    return faceId;
  }
  const jitter = (v, i) => v.map((x, k) => x + ((i * (k + 1)) % 5) * 0.01);
  for (let i = 0; i < 8; i++) await face({ person: ANNA, vector: jitter([1, 0.1, 0], i) });
  for (let i = 0; i < 8; i++) await face({ person: BERT, vector: jitter([0, 1, 0.1], i) });
  // another account's faces right next to Anna's, named Bert: they must not vote
  for (let i = 0; i < 10; i++) await face({ person: BERT, vector: jitter([1, 0.12, 0], i), owner: OTHER_OWNER });
  const group = {
    anna: [await face({ person: GROUP, vector: [1, 0.11, 0.01] }), await face({ person: GROUP, vector: [0.98, 0.12, 0] })],
    bert: [await face({ person: GROUP, vector: [0.02, 1, 0.12] })],
    // Bert was born in 2010, so on a photo from 2000 his votes are dropped
    bertBefore: [await face({ person: GROUP, vector: [0.01, 0.99, 0.1], date: '2000-01-01T10:00:00Z' })],
    // a face of another account in the same group (shared person groups): invisible to this API key
    otherAccount: [await face({ person: GROUP, vector: [1, 0.1, 0.02], owner: OTHER_OWNER })],
  };
  return group;
}

// like Immich: an asset of another account is "Not found or no asset.view access"
async function mockAsset(db, req, res) {
  const match = req.url.match(/^\/api\/assets\/([0-9a-f-]+)$/);
  if (req.method !== 'GET' || !match) return false;
  const owner = (await db.query('SELECT "ownerId" FROM asset WHERE id = $1', [match[1]])).rows[0]?.ownerId;
  if (owner === OWNER) res.end(JSON.stringify({ id: match[1] }));
  else { res.statusCode = 400; res.end(JSON.stringify({ message: 'Not found or no asset.view access' })); }
  return true;
}

async function startServer(t, env) {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(IMMICH_|DB_|PORT$|SPLIT_|VECTOR_)/.test(key)) delete clean[key];
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url), env: { ...clean, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode == null && child.signalCode == null) { child.kill(); await once(child, 'exit'); } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 10000);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes(`Listening on :${port}`)) { clearTimeout(timeout); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  return `http://127.0.0.1:${port}`;
}

test('split view, apply, undo and catch-all against a real database', { skip: !dbUrl && 'SPLIT_TEST_DB_URL not set' }, async (t) => {
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  t.after(() => db.end());
  const group = await setupDatabase(db);

  const people = [
    { id: ANNA, name: 'Anna', birthDate: '1990-01-01', isHidden: false },
    { id: BERT, name: 'Bert', birthDate: '2010-01-01', isHidden: false },
    { id: GROUP, name: '', birthDate: null, isHidden: false },
  ];
  const seen = [];
  let slowFaces = 0;
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    seen.push({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    const faceMove = req.url.match(/^\/api\/faces\/([0-9a-f-]+)$/);
    if (req.method === 'PUT' && faceMove) {
      if (slowFaces) await new Promise((resolve) => setTimeout(resolve, slowFaces));
      // like Immich: the person id is in the path, the face id in the body
      await db.query('UPDATE asset_face SET "personGroupId" = $1 WHERE id = $2', [faceMove[1], body.id]);
      return res.end(JSON.stringify({ id: faceMove[1] }));
    }
    if (req.method === 'GET' && req.url.startsWith('/api/people?')) return res.end(JSON.stringify({ people, hasNextPage: false }));
    const personMatch = req.url.match(/^\/api\/people\/([0-9a-f-]+)$/);
    if (personMatch && req.method === 'GET') return res.end(JSON.stringify(people.find((p) => p.id === personMatch[1]) || {}));
    if (personMatch && req.method === 'PUT') {
      Object.assign(people.find((p) => p.id === personMatch[1]), body);
      return res.end(JSON.stringify(people.find((p) => p.id === personMatch[1])));
    }
    if (await mockAsset(db, req, res)) return;
    if (req.method === 'POST' && req.url === '/api/people') {
      const created = { id: uuid('12121212', people.length + 1), name: body?.name || '', birthDate: null, isHidden: Boolean(body?.isHidden) };
      people.push(created);
      return res.end(JSON.stringify(created));
    }
    if (req.method === 'DELETE' && personMatch) {
      // like Immich: deleting a person keeps its faces, without a person
      await db.query('UPDATE asset_face SET "personGroupId" = NULL WHERE "personGroupId" = $1', [personMatch[1]]);
      people.splice(people.findIndex((p) => p.id === personMatch[1]), 1);
      return res.end('{}');
    }
    if (req.url === '/api/api-keys/me') return res.end(JSON.stringify({ name: 'test' }));
    res.statusCode = 404;
    res.end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => { mock.closeAllConnections(); mock.close(); });

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipm-split-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const logPath = path.join(logDir, 'nested', 'split-log.jsonl');
  const base = await startServer(t, {
    IMMICH_URL: `http://127.0.0.1:${mock.address().port}`,
    IMMICH_API_KEY: 'test-secret',
    IMMICH_DB_URL: dbUrl,
    SPLIT_LOG_PATH: logPath,
  });
  const call = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };

  const status = await call('GET', '/review-api/status');
  assert.equal(status.body.split.log.writable, true);
  assert.equal(status.body.split.rule.neighbours, 10);
  assert.equal(status.body.split.keyOwner, null, 'the status check does not resolve the account itself');

  // the view: Anna's look-alikes are "sure" Anna, the other account's faces do not vote, the birth rule drops Bert
  const split = await call('GET', `/review-api/people/${GROUP}/split`);
  assert.equal(split.status, 200, JSON.stringify(split.body));
  assert.equal(split.body.totalFaces, 4, 'the other account\'s face is filtered out');
  assert.equal(split.body.otherAccountFaces, 1);
  assert.ok(!split.body.faces.some((f) => f.faceId === group.otherAccount[0]));
  assert.deepEqual((await call('GET', '/review-api/status')).body.split.keyOwner, { ownerId: OWNER, accounts: 2, readableAccounts: 1 });
  assert.deepEqual(split.body.people.map((p) => p.name), ['Anna', 'Bert']);
  const byId = new Map(split.body.faces.map((f) => [f.faceId, f]));
  for (const id of group.anna) {
    assert.equal(byId.get(id).level, 'sure');
    assert.equal(byId.get(id).proposalName, 'Anna');
    assert.equal(byId.get(id).votes, 8, 'only the own account votes');
    assert.equal(byId.get(id).neighbours, 10);
  }
  assert.equal(byId.get(group.bert[0]).proposalName, 'Bert');
  const before = byId.get(group.bertBefore[0]);
  assert.equal(before.droppedByBirth, 8);
  assert.equal(before.date, '2000-01-01');
  assert.notEqual(before.proposalId, BERT);
  assert.equal(split.body.faces[0].level, 'sure', 'sorted by level');
  assert.equal(split.body.conflictCheck, true);
  assert.ok(group.anna.every((id) => byId.get(id).preselect === true && byId.get(id).warnings.length === 0));
  assert.equal(split.body.warnings.faces, 0);

  // two faces close to each other (0.2) but proposed for different people: a contradiction inside the group
  const extra = [];
  for (const [i, vector] of [[1, [1, 0.5, 0]], [2, [0.5, 1, 0.05]]]) {
    const assetId = uuid('abababab', i);
    const faceId = uuid('cdcdcdcd', i);
    await db.query('INSERT INTO asset (id, "ownerId", "localDateTime") VALUES ($1, $2, $3)', [assetId, OWNER, '2015-06-01T12:00:00Z']);
    await db.query('INSERT INTO asset_face (id, "assetId", "personGroupId") VALUES ($1, $2, $3)', [faceId, assetId, GROUP]);
    await db.query('INSERT INTO face_search ("faceId", embedding) VALUES ($1, $2)', [faceId, `[${vector.join(',')}]`]);
    extra.push(faceId);
  }
  const conflicted = await call('GET', `/review-api/people/${GROUP}/split`);
  const c = new Map(conflicted.body.faces.map((f) => [f.faceId, f]));
  assert.deepEqual([c.get(extra[0]).proposalName, c.get(extra[1]).proposalName], ['Anna', 'Bert']);
  assert.deepEqual(c.get(extra[0]).warnings, [{ type: 'conflict', with: ['Bert'] }]);
  assert.equal(c.get(extra[0]).preselect, false);
  // single linkage: the Anna and Bert look-alikes of the group chain into the same component
  assert.ok(group.anna.every((id) => c.get(id).warnings.some((w) => w.type === 'conflict')));
  assert.equal(c.get(group.bertBefore[0]).warnings.length, 0, 'unclear faces get no conflict');
  assert.deepEqual(conflicted.body.warnings.conflictNames.sort(), ['Anna', 'Bert']);
  await db.query('DELETE FROM face_search WHERE "faceId" = ANY($1)', [extra]);
  await db.query('DELETE FROM asset_face WHERE id = ANY($1)', [extra]);

  // nothing applied yet
  assert.deepEqual((await call('GET', '/review-api/split/last')).body, { last: null });
  assert.equal((await call('POST', '/review-api/split/apply', { assignments: [{ faceId: 'x', personId: ANNA }] })).status, 400);

  // apply: two moves, one face that already sits in the target is skipped
  const applied = await call('POST', '/review-api/split/apply', {
    sourcePersonId: GROUP,
    assignments: [
      { faceId: group.anna[0], personId: ANNA },
      { faceId: group.anna[1], personId: ANNA },
      { faceId: group.bert[0], personId: GROUP },
      { faceId: group.otherAccount[0], personId: ANNA },
    ],
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual([applied.body.assigned, applied.body.skipped, applied.body.failed], [2, 2, 0]);
  assert.deepEqual(applied.body.skippedFaces.map((f) => f.reason).sort(), ['anderes Konto', 'bereits zugeordnet']);
  const moved = await db.query('SELECT id, "personGroupId" FROM asset_face WHERE id = ANY($1)', [group.anna]);
  assert.ok(moved.rows.every((row) => row.personGroupId === ANNA));
  const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(log.map((e) => e.type), ['batch', 'assign', 'assign']);
  assert.ok(log.slice(1).every((e) => e.from === GROUP && e.to === ANNA && e.toName === 'Anna' && e.ok && e.time && e.assetId));
  const putFaces = seen.filter((r) => r.method === 'PUT' && r.url === `/api/faces/${ANNA}`);
  assert.deepEqual(putFaces.map((r) => r.body.id).sort(), [...group.anna].sort());

  const last = (await call('GET', '/review-api/split/last')).body.last;
  assert.equal(last.batch, applied.body.batch);
  assert.equal(last.assigned, 2);
  assert.equal(last.sourcePersonId, GROUP);

  // undo puts them back into the old group, and only once
  const undone = await call('POST', '/review-api/split/undo', {});
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.deepEqual([undone.body.restored, undone.body.failed, undone.body.skipped], [2, 0, 0]);
  const back = await db.query('SELECT "personGroupId" FROM asset_face WHERE id = ANY($1)', [group.anna]);
  assert.ok(back.rows.every((row) => row.personGroupId === GROUP));
  assert.deepEqual((await call('GET', '/review-api/split/last')).body, { last: null });
  assert.equal((await call('POST', '/review-api/split/undo', { batch: applied.body.batch })).status, 409);
  assert.equal((await call('POST', '/review-api/split/undo', {})).status, 404);

  // writes without a JSON body are refused before anything happens
  const plain = await fetch(base + '/review-api/split/undo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 415);
  const plainCatchAll = await fetch(base + `/review-api/people/${GROUP}/catch-all`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"x"}' });
  assert.equal(plainCatchAll.status, 415);
  assert.equal((await call('POST', '/review-api/split/undo', {})).status, 404, 'nothing was undone by the refused requests');

  // a stale view: faces no longer in the source group are skipped
  await db.query('UPDATE asset_face SET "personGroupId" = $1 WHERE id = $2', [ANNA, group.anna[1]]);
  const stale = await call('POST', '/review-api/split/apply', { sourcePersonId: GROUP, assignments: [{ faceId: group.anna[1], personId: BERT }] });
  assert.deepEqual([stale.body.assigned, stale.body.skippedFaces[0].reason], [0, 'inzwischen anders zugeordnet']);
  assert.equal((await db.query('SELECT "personGroupId" FROM asset_face WHERE id = $1', [group.anna[1]])).rows[0].personGroupId, ANNA);
  await db.query('UPDATE asset_face SET "personGroupId" = $1 WHERE id = $2', [GROUP, group.anna[1]]);

  // only one assign or undo at a time
  slowFaces = 300;
  const first = call('POST', '/review-api/split/apply', { sourcePersonId: GROUP, assignments: [{ faceId: group.anna[1], personId: ANNA }] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const parallel = await call('POST', '/review-api/split/undo', {});
  assert.equal(parallel.status, 409);
  assert.equal((await first).body.assigned, 1);
  slowFaces = 0;
  assert.equal((await call('POST', '/review-api/split/undo', {})).body.restored, 1);

  // a face moved elsewhere after the apply is not pulled back by the undo
  const second = await call('POST', '/review-api/split/apply', { sourcePersonId: GROUP, assignments: [{ faceId: group.anna[0], personId: ANNA }] });
  await db.query('UPDATE asset_face SET "personGroupId" = $1 WHERE id = $2', [BERT, group.anna[0]]);
  const partial = await call('POST', '/review-api/split/undo', { batch: second.body.batch });
  assert.deepEqual([partial.body.restored, partial.body.skipped], [0, 1]);

  // detach (personId null), and back with undo
  const groupOf = async (id) => (await db.query('SELECT "personGroupId" FROM asset_face WHERE id = $1', [id])).rows[0].personGroupId;
  const detached = await call('POST', '/review-api/split/apply', { sourcePersonId: GROUP, assignments: [{ faceId: group.bert[0], personId: null }] });
  assert.equal(detached.status, 200, JSON.stringify(detached.body));
  assert.deepEqual([detached.body.assigned, detached.body.failed], [1, 0]);
  assert.equal(await groupOf(group.bert[0]), null);
  assert.ok(!people.some((p) => p.name.startsWith('__immich_person_manager')), 'temporary person removed');
  const detachLog = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.batch === detached.body.batch && e.type === 'assign');
  assert.deepEqual(detachLog.map((e) => [e.from, e.to, e.ok]), [[GROUP, null, true]]);
  assert.equal((await call('POST', '/review-api/split/apply', { assignments: [{ faceId: group.bert[0], personId: null }] })).body.skippedFaces[0].reason, 'bereits ohne Person');
  const reattached = await call('POST', '/review-api/split/undo', { batch: detached.body.batch });
  assert.equal(reattached.body.restored, 1);
  assert.equal(await groupOf(group.bert[0]), GROUP);

  // a new person for a face of someone not named yet (empty name: unnamed person)
  const created = await call('POST', '/review-api/split/new-person', { name: '' });
  assert.equal(created.status, 200);
  assert.deepEqual(seen.filter((r) => r.method === 'POST' && r.url === '/api/people').at(-1).body, { isHidden: false });
  const named = await call('POST', '/review-api/split/new-person', { name: ' Clara ' });
  assert.equal(named.body.name, 'Clara');
  const moved2 = await call('POST', '/review-api/split/apply', { sourcePersonId: GROUP, assignments: [{ faceId: group.bert[0], personId: created.body.id }] });
  assert.equal(moved2.body.assigned, 1);
  assert.equal(await groupOf(group.bert[0]), created.body.id);
  await call('POST', '/review-api/split/undo', { batch: moved2.body.batch });

  // the rest becomes a hidden catch-all group
  const catchAll = await call('POST', `/review-api/people/${GROUP}/catch-all`, { name: '_Unknown (side/small faces)' });
  assert.equal(catchAll.status, 200);
  const rename = seen.find((r) => r.method === 'PUT' && r.url === `/api/people/${GROUP}`);
  assert.deepEqual(rename.body, { name: '_Unknown (side/small faces)', isHidden: true });
  assert.equal((await call('POST', `/review-api/people/${GROUP}/catch-all`, { name: '  ' })).status, 400);
  assert.ok(seen.every((r) => !r.url.includes('/users/me')), 'no user.read permission needed');
});

test('suspicious group scan reports assignable faces of unnamed groups', { skip: !dbUrl && 'SPLIT_TEST_DB_URL not set' }, async (t) => {
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  t.after(() => db.end());
  await setupDatabase(db);
  // add two more Anna look-alikes so the unnamed group reaches the minimum size of 6
  for (let i = 0; i < 2; i++) {
    const assetId = uuid('ffffffff', i + 1);
    const faceId = uuid('99999999', i + 1);
    await db.query('INSERT INTO asset (id, "ownerId", "localDateTime") VALUES ($1, $2, $3)', [assetId, OWNER, `${2016 + i * 5}-01-01T00:00:00Z`]);
    await db.query('INSERT INTO asset_face (id, "assetId", "personGroupId") VALUES ($1, $2, $3)', [faceId, assetId, GROUP]);
    await db.query('INSERT INTO face_search ("faceId", embedding) VALUES ($1, $2)', [faceId, `[1,0.1,0.0${i}]`]);
  }
  const people = [
    { id: ANNA, name: 'Anna', birthDate: '1990-01-01' },
    { id: BERT, name: 'Bert', birthDate: '2010-01-01' },
    { id: GROUP, name: '', isHidden: false },
  ];
  const mock = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (await mockAsset(db, req, res)) return;
    if (req.url.startsWith('/api/people?')) return res.end(JSON.stringify({ people, hasNextPage: false }));
    res.end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => { mock.closeAllConnections(); mock.close(); });
  const base = await startServer(t, {
    IMMICH_URL: `http://127.0.0.1:${mock.address().port}`, IMMICH_API_KEY: 'k', IMMICH_DB_URL: dbUrl,
    SPLIT_LOG_PATH: path.join(os.tmpdir(), `ipm-split-${process.pid}.jsonl`),
  });
  const started = await fetch(base + '/review-api/split/suspicious/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(started.status, 202);
  let state;
  for (let i = 0; i < 50; i++) {
    state = await (await fetch(base + '/review-api/split/suspicious')).json();
    if (!state.running) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(state.error, null);
  assert.equal(state.groups.length, 1);
  const [row] = state.groups;
  assert.equal(row.personId, GROUP);
  assert.equal(row.faces, 6);
  assert.equal(row.years, 2021 - 2000);
  assert.equal(row.assignable, 5);
  assert.equal(row.majorityName, 'Anna');
  assert.deepEqual(row.proposals.map((p) => [p.name, p.faces]), [['Anna', 4], ['Bert', 1]]);
  assert.ok(row.meanWidthShare > 0.09 && row.meanWidthShare < 0.11);
});
