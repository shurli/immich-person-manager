import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { buildVectorCluster, projectEmbeddingToCluster } from './cluster-math.mjs';
import { ASSET_FACE_PERSON_COLUMNS, assetFacePersonReference, selectAssetFacePersonColumn } from './asset-face-schema.mjs';
import {
  SPLIT_RULE,
  captureDay,
  chooseKeyOwner,
  compareSplitFaces,
  evenSample,
  findGroupConflicts,
  isBorderline,
  namedPeopleIndex,
  summarizeSplitVotes,
  voteForFace,
} from './split-vote.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const appVersion = packageInfo.version || 'unknown';
const port = Number(process.env.PORT || 3003);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer between 1 and 65535.');
  process.exit(1);
}
const immichUrl = (process.env.IMMICH_URL || '').replace(/\/$/, '');
const immichExternalUrl = (process.env.IMMICH_EXTERNAL_URL || immichUrl).replace(/\/$/, '');
const apiPrefixRaw = process.env.IMMICH_API_PREFIX ?? '/api';
const apiPrefix = apiPrefixRaw ? '/' + apiPrefixRaw.replace(/^\/+|\/+$/g, '') : '';
const apiKey = process.env.IMMICH_API_KEY || '';
const unnamedStatsCache = new Map();
const UNNAMED_STATS_TTL_MS = 5 * 60 * 1000;
const duplicateFaceScans = new Map();
const DUPLICATE_SCAN_TTL_MS = 15 * 60 * 1000;
const adjacentPersonCache = new Map();
const ADJACENT_PERSON_TTL_MS = 2 * 60 * 1000;

const immichDbUrl = process.env.IMMICH_DB_URL || '';
const immichDbHost = process.env.IMMICH_DB_HOST || process.env.DB_HOSTNAME || '';
const immichDbPort = Number(process.env.IMMICH_DB_PORT || process.env.DB_PORT || 5432);
const immichDbUser = process.env.IMMICH_DB_USER || process.env.DB_USERNAME || 'postgres';
const immichDbPassword = process.env.IMMICH_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '';
const immichDbName = process.env.IMMICH_DB_NAME || process.env.DB_DATABASE_NAME || 'immich';
const immichDbSsl = /^(1|true|yes|required)$/i.test(process.env.IMMICH_DB_SSL || '');
const vectorDbConfigured = Boolean(immichDbUrl || immichDbHost);
const vectorClusterMaxFacesValue = Number(process.env.VECTOR_CLUSTER_MAX_FACES || 30000);
const vectorClusterMaxFaces = Number.isFinite(vectorClusterMaxFacesValue) ? Math.max(100, vectorClusterMaxFacesValue) : 30000;
const vectorClusterMaxAdjacentPeopleValue = Number(process.env.VECTOR_CLUSTER_MAX_ADJACENT_PEOPLE || 50);
const vectorClusterMaxAdjacentPeople = Number.isFinite(vectorClusterMaxAdjacentPeopleValue)
  ? Math.min(200, Math.max(1, Math.floor(vectorClusterMaxAdjacentPeopleValue)))
  : 50;
const vectorClusterAdjacentCandidatePoolValue = Number(process.env.VECTOR_CLUSTER_ADJACENT_CANDIDATE_POOL || 500);
const vectorClusterAdjacentCandidatePool = Number.isFinite(vectorClusterAdjacentCandidatePoolValue)
  ? Math.min(1000, Math.max(vectorClusterMaxAdjacentPeople + 1, Math.floor(vectorClusterAdjacentCandidatePoolValue)))
  : 500;
const splitMaxFacesValue = Number(process.env.VECTOR_SPLIT_MAX_FACES || 3000);
const splitMaxFaces = Number.isFinite(splitMaxFacesValue) ? Math.max(50, Math.floor(splitMaxFacesValue)) : 3000;
const splitLogPath = process.env.SPLIT_LOG_PATH || path.join(__dirname, 'data', 'split-log.jsonl');
const vectorClusterDefaultRadiusRaw = process.env.VECTOR_CLUSTER_DEFAULT_RADIUS;
const vectorClusterDefaultRadius = vectorClusterDefaultRadiusRaw == null || vectorClusterDefaultRadiusRaw === ''
  ? undefined
  : Number(vectorClusterDefaultRadiusRaw);
const vectorPool = vectorDbConfigured
  ? new Pool({
      ...(immichDbUrl
        ? { connectionString: immichDbUrl }
        : {
            host: immichDbHost,
            port: Number.isFinite(immichDbPort) ? immichDbPort : 5432,
            user: immichDbUser,
            password: immichDbPassword,
            database: immichDbName,
          }),
      ssl: immichDbSsl ? { rejectUnauthorized: false } : undefined,
      application_name: 'immich-person-manager-vector-cluster',
      max: 3,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
      statement_timeout: 60000,
    })
  : null;

vectorPool?.on('error', (error) => console.error('Immich PostgreSQL pool error:', error));

let assetFacePersonColumnPromise = null;

async function detectAssetFacePersonColumn() {
  const pool = requireVectorDatabase();
  if (!assetFacePersonColumnPromise) {
    assetFacePersonColumnPromise = pool.query(
      `SELECT attname AS "columnName"
         FROM pg_attribute
        WHERE attrelid = to_regclass('asset_face')
          AND attname = ANY($1::text[])
          AND attnum > 0
          AND NOT attisdropped`,
      [ASSET_FACE_PERSON_COLUMNS],
    )
      .then((result) => selectAssetFacePersonColumn(result.rows.map((row) => row.columnName)))
      .catch((error) => {
        assetFacePersonColumnPromise = null;
        throw error;
      });
  }
  return assetFacePersonColumnPromise;
}

async function assetFacePersonRef(alias = 'af') {
  return assetFacePersonReference(await detectAssetFacePersonColumn(), alias);
}

if (!immichUrl || !apiKey) {
  console.error('IMMICH_URL and IMMICH_API_KEY are required.');
  process.exit(1);
}

function immichEndpoint(p) {
  return `${immichUrl}${apiPrefix}${p}`;
}

async function immichFetch(p, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('x-api-key', apiKey);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(immichEndpoint(p), { ...options, headers, redirect: 'follow' });
}

async function vectorDatabaseInfo({ probe = false } = {}) {
  const info = {
    configured: vectorDbConfigured,
    reachable: null,
    host: immichDbUrl ? 'connection-string' : (immichDbHost || null),
    port: immichDbUrl ? null : (Number.isFinite(immichDbPort) ? immichDbPort : 5432),
    database: immichDbUrl ? null : immichDbName,
    maxFaces: vectorClusterMaxFaces,
    maxAdjacentPeople: vectorClusterMaxAdjacentPeople,
    adjacentCandidatePool: vectorClusterAdjacentCandidatePool,
  };
  if (!probe || !vectorPool) return info;
  try {
    const result = await vectorPool.query(`SELECT current_database() AS database, current_user AS "user"`);
    info.reachable = true;
    info.database = result.rows[0]?.database || info.database;
    info.user = result.rows[0]?.user || null;
    try {
      const personColumn = await detectAssetFacePersonColumn();
      const personRef = assetFacePersonReference(personColumn);
      await vectorPool.query(
        `SELECT af.id, af."assetId", ${personRef} AS "personId", fs.embedding::text, a."originalFileName"
           FROM asset_face af
           LEFT JOIN face_search fs ON fs."faceId" = af.id
           JOIN asset a ON a.id = af."assetId"
          LIMIT 0`,
      );
      info.assetFacePersonColumn = personColumn;
      info.schemaReady = true;
    } catch (schemaError) {
      info.schemaReady = false;
      info.schemaError = schemaError.message;
    }
  } catch (error) {
    info.reachable = false;
    info.schemaReady = false;
    info.error = error.message;
  }
  return info;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function requireVectorDatabase() {
  if (!vectorPool) {
    const error = new Error('PostgreSQL-Zugriff für Vektor-Cluster ist nicht konfiguriert. Setze IMMICH_DB_URL oder IMMICH_DB_HOST sowie die DB-Zugangsdaten.');
    error.status = 503;
    error.code = 'VECTOR_DB_NOT_CONFIGURED';
    throw error;
  }
  return vectorPool;
}

async function verifyPersonAccess(personId) {
  const response = await immichFetch(`/people/${encodeURIComponent(personId)}`);
  if (!response.ok) {
    const error = new Error(`Immich verweigert den Zugriff auf die Person (${response.status}).`);
    error.response = response;
    throw error;
  }
  return response.json();
}

async function loadPersonVectorRows(personId) {
  const pool = requireVectorDatabase();
  const personRef = await assetFacePersonRef();
  const countResult = await pool.query(
    `SELECT count(*)::int AS count
       FROM asset_face af
       JOIN asset a ON a.id = af."assetId"
      WHERE ${personRef} = $1::uuid
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
        AND a."deletedAt" IS NULL`,
    [personId],
  );
  const totalAssignedFaces = Number(countResult.rows[0]?.count || 0);
  if (totalAssignedFaces > vectorClusterMaxFaces) {
    const error = new Error(`Diese Person hat ${totalAssignedFaces} Faces. Das konfigurierte Cluster-Limit liegt bei ${vectorClusterMaxFaces}. Erhöhe VECTOR_CLUSTER_MAX_FACES bewusst, wenn genügend Arbeitsspeicher vorhanden ist.`);
    error.status = 413;
    error.code = 'VECTOR_CLUSTER_TOO_LARGE';
    throw error;
  }

  const result = await pool.query(
    `SELECT
        af.id AS "faceId",
        af."assetId",
        ${personRef} AS "personId",
        af."imageWidth",
        af."imageHeight",
        af."boundingBoxX1",
        af."boundingBoxY1",
        af."boundingBoxX2",
        af."boundingBoxY2",
        fs.embedding::text AS embedding,
        a."originalFileName",
        a."fileCreatedAt",
        a."localDateTime",
        a."createdAt"
       FROM asset_face af
       LEFT JOIN face_search fs ON fs."faceId" = af.id
       JOIN asset a ON a.id = af."assetId"
      WHERE ${personRef} = $1::uuid
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
        AND a."deletedAt" IS NULL
      ORDER BY a."fileCreatedAt" ASC, af.id ASC`,
    [personId],
  );
  return { rows: result.rows, totalAssignedFaces };
}

async function getPersonVectorCluster(personId) {
  const person = await verifyPersonAccess(personId);
  const { rows, totalAssignedFaces } = await loadPersonVectorRows(personId);
  const cluster = buildVectorCluster(rows, {
    seed: personId,
    defaultRadius: Number.isFinite(vectorClusterDefaultRadius) ? vectorClusterDefaultRadius : undefined,
  });
  return {
    person: { id: person.id, name: person.name || '' },
    totalAssignedFaces,
    facesWithEmbedding: cluster.points.length,
    facesWithoutEmbedding: Math.max(0, totalAssignedFaces - cluster.points.length),
    ...cluster,
    presets: {
      p90: cluster.stats.p90Distance,
      p95: cluster.stats.p95Distance,
      immichDefault: 0.5,
    },
  };
}

async function loadClosestPersonCandidates(personId) {
  const response = await immichFetch(
    `/people?page=1&size=${encodeURIComponent(vectorClusterAdjacentCandidatePool)}&withHidden=true&closestPersonId=${encodeURIComponent(personId)}`,
  );
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Angrenzende Personen konnten nicht von Immich geladen werden: HTTP ${response.status} ${text.slice(0, 250)}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const people = Array.isArray(data) ? data : (Array.isArray(data.people) ? data.people : []);
  return people.filter((person) => person?.id && person.id !== personId);
}

async function loadAdjacentPersonCentroids(personIds) {
  const pool = requireVectorDatabase();
  if (!personIds.length) return [];
  const personRef = await assetFacePersonRef();
  const result = await pool.query(
    `SELECT
        ${personRef} AS "personId",
        count(*)::int AS "faceCount",
        avg(fs.embedding)::text AS embedding
       FROM asset_face af
       JOIN face_search fs ON fs."faceId" = af.id
       JOIN asset a ON a.id = af."assetId"
      WHERE ${personRef} = ANY($1::uuid[])
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
        AND a."deletedAt" IS NULL
      GROUP BY ${personRef}`,
    [personIds],
  );
  return result.rows;
}

async function getAdjacentPeople(personId, requestedLimit, { force = false } = {}) {
  const now = Date.now();
  for (const [key, value] of adjacentPersonCache) {
    if (now - value.createdAt >= ADJACENT_PERSON_TTL_MS) adjacentPersonCache.delete(key);
  }
  const limit = Math.min(
    vectorClusterMaxAdjacentPeople,
    Math.max(1, Number.isFinite(Number(requestedLimit)) ? Math.floor(Number(requestedLimit)) : 8),
  );
  const cached = adjacentPersonCache.get(personId);
  if (!force && cached && now - cached.createdAt < ADJACENT_PERSON_TTL_MS) {
    return {
      person: cached.person,
      limit,
      candidatePool: cached.candidatePool,
      available: cached.people.length,
      people: cached.people.slice(0, limit),
      cached: true,
    };
  }

  const cluster = await getPersonVectorCluster(personId);
  if (!cluster.points.length) {
    return {
      person: cluster.person,
      limit,
      candidatePool: 0,
      available: 0,
      people: [],
      cached: false,
    };
  }

  const candidates = await loadClosestPersonCandidates(personId);
  const metadata = new Map(candidates.map((person) => [person.id, person]));
  const centroids = await loadAdjacentPersonCentroids([...metadata.keys()]);
  const people = [];
  for (const row of centroids) {
    const person = metadata.get(row.personId);
    if (!person || !row.embedding) continue;
    try {
      people.push(projectEmbeddingToCluster(row.embedding, cluster, {
        id: person.id,
        name: person.name || '',
        birthDate: person.birthDate || null,
        isHidden: Boolean(person.isHidden),
        isFavorite: Boolean(person.isFavorite),
        faceCount: Number(row.faceCount || 0),
      }));
    } catch (error) {
      console.warn(`Adjacent person ${person.id} skipped:`, error.message);
    }
  }
  people.sort((a, b) => a.distance - b.distance || String(a.name).localeCompare(String(b.name), 'de'));

  const cacheEntry = {
    createdAt: Date.now(),
    person: cluster.person,
    candidatePool: candidates.length,
    people,
  };
  adjacentPersonCache.set(personId, cacheEntry);
  while (adjacentPersonCache.size > 24) {
    adjacentPersonCache.delete(adjacentPersonCache.keys().next().value);
  }
  return {
    person: cluster.person,
    limit,
    candidatePool: candidates.length,
    available: people.length,
    people: people.slice(0, limit),
    cached: false,
  };
}

function invalidateAdjacentPeople() {
  adjacentPersonCache.clear();
}

async function validateClusterFaceIds(personId, faceIds) {
  const pool = requireVectorDatabase();
  const unique = [...new Set((faceIds || []).map(String))];
  if (!unique.length) return [];
  const personRef = await assetFacePersonRef();
  const result = await pool.query(
    `SELECT af.id, af."assetId"
       FROM asset_face af
      WHERE ${personRef} = $1::uuid
        AND id = ANY($2::uuid[])
        AND "deletedAt" IS NULL
        AND "isVisible" IS TRUE`,
    [personId, unique],
  );
  return result.rows.map((row) => ({ faceId: row.id, assetId: row.assetId }));
}

async function unassignFacesWithTemporaryPerson(items) {
  if (!items.length) return { requested: 0, moved: 0, detached: 0, failed: 0, failures: [], detachedFaceIds: [] };
  let temporaryPersonId = null;
  const movedFaceIds = [];
  const failures = [];
  try {
    const create = await immichFetch('/people', {
      method: 'POST',
      body: JSON.stringify({
        name: `__immich_person_manager_cluster_unassign_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        birthDate: null,
        isHidden: true,
        isFavorite: false,
      }),
    });
    if (!create.ok) {
      const text = await create.text();
      const error = new Error(`Temporäre Person konnte nicht erstellt werden: HTTP ${create.status} ${text.slice(0, 250)}`);
      error.status = create.status;
      throw error;
    }
    temporaryPersonId = (await create.json()).id;

    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          const move = await immichFetch(`/faces/${encodeURIComponent(temporaryPersonId)}`, {
            method: 'PUT',
            body: JSON.stringify({ id: item.faceId }),
          });
          if (!move.ok) {
            const text = await move.text();
            failures.push({ faceId: item.faceId, assetId: item.assetId, status: move.status, message: text.slice(0, 300) });
          } else {
            movedFaceIds.push(item.faceId);
          }
        } catch (error) {
          failures.push({ faceId: item.faceId, assetId: item.assetId, status: 0, message: error.message });
        }
      }
    });
    await Promise.all(workers);

    const removeTemporaryPerson = await immichFetch(`/people/${encodeURIComponent(temporaryPersonId)}`, { method: 'DELETE' });
    if (!removeTemporaryPerson.ok) {
      const text = await removeTemporaryPerson.text();
      const error = new Error(`Temporäre Person konnte nicht gelöscht werden. ${movedFaceIds.length} Faces sind ihr weiterhin zugeordnet: HTTP ${removeTemporaryPerson.status} ${text.slice(0, 250)}`);
      error.status = 502;
      throw error;
    }
    temporaryPersonId = null;

    let detachedFaceIds = movedFaceIds;
    if (vectorPool && movedFaceIds.length) {
      const personRef = await assetFacePersonRef();
      const verify = await vectorPool.query(
        `SELECT af.id FROM asset_face af WHERE af.id = ANY($1::uuid[]) AND ${personRef} IS NULL AND af."deletedAt" IS NULL`,
        [movedFaceIds],
      );
      detachedFaceIds = verify.rows.map((row) => row.id);
    }

    return {
      requested: items.length,
      moved: movedFaceIds.length,
      detached: detachedFaceIds.length,
      failed: failures.length + Math.max(0, movedFaceIds.length - detachedFaceIds.length),
      failures: failures.slice(0, 100),
      detachedFaceIds,
    };
  } catch (error) {
    if (temporaryPersonId) {
      try { await immichFetch(`/people/${encodeURIComponent(temporaryPersonId)}`, { method: 'DELETE' }); } catch {}
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// "Split group": per face the nearest faces of named people propose a person (rule in split-vote.mjs).
// Reads embeddings through the read-only database role; every change goes through the Immich API and is logged to
// a JSON lines file so that the last batch can be undone.
// ---------------------------------------------------------------------------------------------------------------

const SPLIT_QUERY_CHUNK = 100;
const SPLIT_QUERY_WORKERS = 2;
const SPLIT_APPLY_WORKERS = 4;
const SPLIT_MAX_ASSIGNMENTS = 5000;
const SPLIT_LINK_MAX_FACES = 2000;
const NAMED_PEOPLE_TTL_MS = 60 * 1000;
const SUSPICIOUS_MIN_FACES = 6;
const SUSPICIOUS_SAMPLE = 30;
const SUSPICIOUS_TTL_MS = 30 * 60 * 1000;
let namedPeopleCache = null;

async function loadNamedPeople({ force = false } = {}) {
  if (!force && namedPeopleCache && Date.now() - namedPeopleCache.at < NAMED_PEOPLE_TTL_MS) return namedPeopleCache.index;
  const index = namedPeopleIndex(await collectAllPeople());
  namedPeopleCache = { at: Date.now(), index };
  return index;
}

function invalidateNamedPeople() {
  namedPeopleCache = null;
}

// The account behind the API key. Groups can hold faces of several accounts, but the key can only show and reassign
// faces of its own account; the others are filtered out. Determined by reading one asset per account through the
// API (asset.read), no extra permission needed.
const KEY_OWNER_TTL_MS = 10 * 60 * 1000;
let keyOwnerCache = null;

async function resolveKeyOwner({ force = false } = {}) {
  if (!force && keyOwnerCache && Date.now() - keyOwnerCache.at < KEY_OWNER_TTL_MS) return keyOwnerCache.info;
  const pool = requireVectorDatabase();
  // up to 3 assets with faces per account: one unreadable asset (e.g. in a locked folder) must not hide an account
  const candidates = (await pool.query(
    `SELECT "ownerId", id
       FROM (
         SELECT a."ownerId", a.id, row_number() OVER (PARTITION BY a."ownerId" ORDER BY a.id) AS rn
           FROM asset a
          WHERE a."deletedAt" IS NULL
            AND EXISTS (SELECT 1 FROM asset_face af WHERE af."assetId" = a.id AND af."deletedAt" IS NULL)
       ) x
      WHERE rn <= 3`,
  )).rows;
  const byOwner = new Map();
  for (const row of candidates) {
    if (!byOwner.has(row.ownerId)) byOwner.set(row.ownerId, []);
    byOwner.get(row.ownerId).push(row.id);
  }
  const accessible = [];
  for (const [ownerId, assetIds] of byOwner) {
    for (const assetId of assetIds) {
      const response = await immichFetch(`/assets/${encodeURIComponent(assetId)}`);
      await response.arrayBuffer().catch(() => {});
      if (response.ok) {
        accessible.push(ownerId);
        break;
      }
    }
  }
  let counts = new Map();
  if (accessible.length > 1) {
    const people = await loadNamedPeople();
    const personRef = await assetFacePersonRef();
    const result = await pool.query(
      `SELECT a."ownerId", count(*)::int AS faces
         FROM asset_face af
         JOIN asset a ON a.id = af."assetId"
        WHERE ${personRef} = ANY($1::uuid[])
          AND af."deletedAt" IS NULL
        GROUP BY a."ownerId"`,
      [[...people.keys()]],
    );
    counts = new Map(result.rows.map((row) => [row.ownerId, row.faces]));
  }
  const info = { ownerId: chooseKeyOwner(accessible, counts), accounts: byOwner.size, readableAccounts: accessible.length };
  if (!info.ownerId) {
    const error = new Error('Das Konto des API-Keys ließ sich nicht bestimmen: kein Asset ist mit diesem Key lesbar (Recht asset.read?).');
    error.status = 503;
    error.code = 'SPLIT_KEY_OWNER_UNKNOWN';
    throw error;
  }
  keyOwnerCache = { at: Date.now(), info };
  return info;
}

async function loadSplitFaces(personId, ownerId) {
  const pool = requireVectorDatabase();
  const personRef = await assetFacePersonRef();
  const others = await pool.query(
    `SELECT count(*)::int AS count
       FROM asset_face af
       JOIN asset a ON a.id = af."assetId"
      WHERE ${personRef} = $1::uuid
        AND a."ownerId" <> $2::uuid
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
        AND a."deletedAt" IS NULL`,
    [personId, ownerId],
  );
  const result = await pool.query(
    `SELECT
        af.id AS "faceId",
        af."assetId",
        a."ownerId",
        af."imageWidth",
        af."imageHeight",
        af."boundingBoxX1",
        af."boundingBoxY1",
        af."boundingBoxX2",
        af."boundingBoxY2",
        a."originalFileName",
        a."localDateTime",
        (fs."faceId" IS NOT NULL) AS "hasEmbedding"
       FROM asset_face af
       JOIN asset a ON a.id = af."assetId"
       LEFT JOIN face_search fs ON fs."faceId" = af.id
      WHERE ${personRef} = $1::uuid
        AND a."ownerId" = $3::uuid
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
        AND a."deletedAt" IS NULL
      ORDER BY a."localDateTime" ASC, af.id ASC
      LIMIT $2`,
    [personId, splitMaxFaces + 1, ownerId],
  );
  if (result.rows.length > splitMaxFaces) {
    const error = new Error(`Diese Gruppe hat mehr als ${splitMaxFaces} Faces. Erhöhe VECTOR_SPLIT_MAX_FACES bewusst, wenn das Aufteilen trotzdem laufen soll (ca. 10 ms je Face).`);
    error.status = 413;
    error.code = 'SPLIT_TOO_LARGE';
    throw error;
  }
  return { rows: result.rows, otherAccountFaces: Number(others.rows[0]?.count || 0) };
}

/**
 * The nearest faces of named people for each face, nearest first, via the vector index. Only faces of the same
 * account (the face's own asset owner) count, never the face itself. Returns Map(faceId -> [{personId, distance}]).
 */
async function findNamedNeighbours(faceIds, namedIds, { onProgress } = {}) {
  const byFace = new Map(faceIds.map((id) => [id, []]));
  if (!faceIds.length || !namedIds.length) return byFace;
  const pool = requireVectorDatabase();
  const neighbourRef = await assetFacePersonRef('n');
  const chunks = [];
  for (let i = 0; i < faceIds.length; i += SPLIT_QUERY_CHUNK) chunks.push(faceIds.slice(i, i + SPLIT_QUERY_CHUNK));
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(SPLIT_QUERY_WORKERS, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const result = await pool.query(
        `SELECT g.id AS "faceId", nn."personId", nn.distance
           FROM (
             SELECT af.id, a."ownerId", fs.embedding
               FROM asset_face af
               JOIN asset a ON a.id = af."assetId"
               JOIN face_search fs ON fs."faceId" = af.id
              WHERE af.id = ANY($1::uuid[])
           ) g
           CROSS JOIN LATERAL (
             SELECT ${neighbourRef} AS "personId", (fs2.embedding <=> g.embedding)::float8 AS distance
               FROM face_search fs2
               JOIN asset_face n ON n.id = fs2."faceId"
               JOIN asset na ON na.id = n."assetId"
              WHERE na."ownerId" = g."ownerId"
                AND n.id <> g.id
                AND n."deletedAt" IS NULL
                AND n."isVisible" IS TRUE
                AND na."deletedAt" IS NULL
                -- compared as text on purpose: with an indexable uuid filter the planner prefers the btree on the
                -- person column and sorts all named faces (~260 ms per face); this way it streams the vector index
                -- and filters on the fly (~9 ms per face, measured on 46k faces)
                AND ${neighbourRef}::text = ANY($2::text[])
              ORDER BY fs2.embedding <=> g.embedding
              LIMIT $3
           ) nn
          ORDER BY g.id, nn.distance`,
        [chunk, namedIds, SPLIT_RULE.neighbours],
      );
      for (const row of result.rows) byFace.get(row.faceId)?.push({ personId: row.personId, distance: Number(row.distance) });
      done += chunk.length;
      onProgress?.(done, faceIds.length);
    }
  });
  await Promise.all(workers);
  return byFace;
}

/** Pairs of faces (from the given list) closer than `maxDistance`; quadratic, so only for groups up to a cap. */
async function loadGroupLinks(faceIds, maxDistance) {
  if (faceIds.length < 2) return [];
  const pool = requireVectorDatabase();
  const result = await pool.query(
    `SELECT a."faceId" AS a, b."faceId" AS b
       FROM face_search a
       JOIN face_search b ON a."faceId" < b."faceId"
      WHERE a."faceId" = ANY($1::uuid[])
        AND b."faceId" = ANY($1::uuid[])
        AND (a.embedding <=> b.embedding) < $2`,
    [faceIds, maxDistance],
  );
  return result.rows.map((row) => [row.a, row.b]);
}

function faceWidthShare(face) {
  const width = Number(face.boundingBoxX2) - Number(face.boundingBoxX1);
  const imageWidth = Number(face.imageWidth);
  return imageWidth > 0 && width > 0 ? width / imageWidth : 0;
}

async function getPersonSplit(personId) {
  const started = Date.now();
  const person = await verifyPersonAccess(personId);
  const people = await loadNamedPeople({ force: true });
  const keyOwner = await resolveKeyOwner();
  const { rows: faces, otherAccountFaces } = await loadSplitFaces(personId, keyOwner.ownerId);
  const withEmbedding = faces.filter((face) => face.hasEmbedding);
  const neighbours = await findNamedNeighbours(withEmbedding.map((face) => face.faceId), [...people.keys()]);
  const nameOf = (id) => people.get(id)?.name || '';
  const votes = new Map(withEmbedding.map((face) => [face.faceId, voteForFace(neighbours.get(face.faceId), { captureDate: face.localDateTime, people })]));
  const conflictCheck = withEmbedding.length <= SPLIT_LINK_MAX_FACES;
  const conflicts = conflictCheck
    ? findGroupConflicts(
      withEmbedding.map((face) => ({ faceId: face.faceId, level: votes.get(face.faceId).level, proposalId: votes.get(face.faceId).proposalId })),
      await loadGroupLinks(withEmbedding.map((face) => face.faceId), SPLIT_RULE.groupLinkDistance),
    )
    : new Map();
  const results = withEmbedding.map((face) => {
    const vote = votes.get(face.faceId);
    const stays = Boolean(vote.proposalId) && vote.proposalId === personId;
    const warnings = [];
    if (isBorderline(vote)) warnings.push({ type: 'borderline' });
    if (conflicts.has(face.faceId)) {
      // '' stands for this group itself when it has no name; the UI words it
      warnings.push({ type: 'conflict', with: conflicts.get(face.faceId).map((id) => (id === personId ? (person.name || '') : nameOf(id))) });
    }
    return {
      faceId: face.faceId,
      assetId: face.assetId,
      ownerId: face.ownerId,
      originalFileName: face.originalFileName || '',
      date: captureDay(face.localDateTime),
      imageWidth: face.imageWidth,
      imageHeight: face.imageHeight,
      boundingBoxX1: face.boundingBoxX1,
      boundingBoxY1: face.boundingBoxY1,
      boundingBoxX2: face.boundingBoxX2,
      boundingBoxY2: face.boundingBoxY2,
      widthShare: faceWidthShare(face),
      level: vote.level,
      proposalId: vote.proposalId,
      proposalName: nameOf(vote.proposalId),
      stays,
      warnings,
      preselect: vote.level === 'sure' && !stays && warnings.length === 0,
      votes: vote.votes,
      meanDistance: vote.meanDistance,
      droppedByBirth: vote.droppedByBirth,
      neighbours: vote.neighbours,
      candidates: vote.candidates.map((c) => ({ ...c, name: nameOf(c.personId) })),
    };
  }).sort(compareSplitFaces);
  const levels = { sure: 0, likely: 0, unclear: 0 };
  for (const face of results) levels[face.level]++;
  const warned = results.filter((face) => face.warnings.length);
  return {
    person: { id: person.id, name: person.name || '', isHidden: Boolean(person.isHidden), birthDate: person.birthDate || null },
    totalFaces: faces.length,
    otherAccountFaces,
    facesWithoutEmbedding: faces.length - withEmbedding.length,
    rule: SPLIT_RULE,
    levels,
    conflictCheck,
    warnings: {
      faces: warned.length,
      notPreselected: warned.filter((face) => face.level === 'sure' && !face.stays).length,
      borderline: warned.filter((face) => face.warnings.some((w) => w.type === 'borderline')).length,
      conflict: warned.filter((face) => face.warnings.some((w) => w.type === 'conflict')).length,
      conflictNames: [...new Set(results.filter((face) => face.warnings.some((w) => w.type === 'conflict') && !face.stays).map((face) => face.proposalName))],
    },
    people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')),
    faces: results,
    durationMs: Date.now() - started,
  };
}

async function loadFaceGroups(faceIds) {
  const pool = requireVectorDatabase();
  const personRef = await assetFacePersonRef();
  const result = await pool.query(
    `SELECT af.id AS "faceId", af."assetId", a."ownerId", ${personRef} AS "personId"
       FROM asset_face af
       JOIN asset a ON a.id = af."assetId"
      WHERE af.id = ANY($1::uuid[])
        AND af."deletedAt" IS NULL`,
    [faceIds],
  );
  return new Map(result.rows.map((row) => [row.faceId, row]));
}

async function ensureSplitLogWritable() {
  const dir = path.dirname(splitLogPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.access(dir, fs.constants.W_OK);
  } catch (cause) {
    const error = new Error(`Das Rückgängig-Log ${splitLogPath} ist nicht beschreibbar (${cause.code || cause.message}). Ohne Log wird nichts zugeordnet.`);
    error.status = 503;
    error.code = 'SPLIT_LOG_NOT_WRITABLE';
    throw error;
  }
}

async function splitLogStatus() {
  try {
    await ensureSplitLogWritable();
    return { path: splitLogPath, writable: true };
  } catch (error) {
    return { path: splitLogPath, writable: false, error: error.message };
  }
}

async function appendSplitLog(entries) {
  if (!entries.length) return;
  await fs.promises.appendFile(splitLogPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

async function readSplitLog() {
  let text;
  try {
    text = await fs.promises.readFile(splitLogPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a torn last line after a crash */ }
  }
  return entries;
}

function splitBatches(entries) {
  const batches = new Map();
  for (const entry of entries) {
    if (!entry?.batch) continue;
    if (!batches.has(entry.batch)) batches.set(entry.batch, { batch: entry.batch, time: entry.time, assignments: [], undone: false });
    const batch = batches.get(entry.batch);
    if (entry.type === 'batch') Object.assign(batch, { time: entry.time, sourcePersonId: entry.source || null, sourceName: entry.sourceName || '' });
    else if (entry.type === 'assign') batch.assignments.push(entry);
    else if (entry.type === 'undo-batch') Object.assign(batch, { undone: true, undoneAt: entry.time });
  }
  return [...batches.values()];
}

function describeBatch(batch) {
  if (!batch) return null;
  const ok = batch.assignments.filter((entry) => entry.ok);
  return {
    batch: batch.batch,
    time: batch.time,
    sourcePersonId: batch.sourcePersonId || null,
    sourceName: batch.sourceName || '',
    assigned: ok.length,
    failed: batch.assignments.length - ok.length,
    undone: batch.undone,
  };
}

async function lastSplitBatch() {
  const batches = splitBatches(await readSplitLog()).filter((batch) => !batch.undone && batch.assignments.some((entry) => entry.ok));
  return batches.at(-1) || null;
}

async function runWithWorkers(items, count, task) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (cursor < items.length) await task(items[cursor++]);
  }));
}

async function reassignFace(faceId, personId) {
  try {
    const response = await immichFetch(`/faces/${encodeURIComponent(personId)}`, {
      method: 'PUT',
      body: JSON.stringify({ id: faceId }),
    });
    if (response.ok) return { ok: true, status: response.status };
    return { ok: false, status: response.status, message: (await response.text()).slice(0, 300) };
  } catch (error) {
    return { ok: false, status: 0, message: error.message };
  }
}

function newBatchId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Assign and undo change faces one by one; two of them at the same time (two tabs, a double click) would mix their
// batches in the log, so only one runs at a time.
let splitWriteRunning = false;

async function exclusiveSplitWrite(task) {
  if (splitWriteRunning) {
    const error = new Error('Ein anderer Zuordnungs- oder Rückgängig-Durchgang läuft gerade. Bitte kurz warten.');
    error.status = 409;
    error.code = 'SPLIT_BUSY';
    throw error;
  }
  splitWriteRunning = true;
  try {
    return await task();
  } finally {
    splitWriteRunning = false;
  }
}

// The split writes require a JSON body: a form on another page can POST text/plain without a CORS preflight.
function isJsonRequest(req) {
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function applySplitAssignments(body) {
  const sourcePersonId = body?.sourcePersonId ? String(body.sourcePersonId) : null;
  if (sourcePersonId && !isUuid(sourcePersonId)) throw badRequest('sourcePersonId ist keine gültige ID.');
  if (!Array.isArray(body?.assignments) || !body.assignments.length) throw badRequest('assignments muss eine nicht leere Liste sein.');
  if (body.assignments.length > SPLIT_MAX_ASSIGNMENTS) {
    const error = new Error(`Maximal ${SPLIT_MAX_ASSIGNMENTS} Zuordnungen pro Durchgang.`);
    error.status = 413;
    throw error;
  }
  const wanted = new Map();
  for (const item of body.assignments) {
    // personId null = take the face away from its person
    if (!isUuid(item?.faceId) || !(item?.personId === null || isUuid(item?.personId))) throw badRequest('Jede Zuordnung braucht eine gültige faceId und personId (oder null zum Lösen).');
    wanted.set(String(item.faceId), item.personId === null ? null : String(item.personId));
  }

  await ensureSplitLogWritable();
  const current = await loadFaceGroups([...wanted.keys()]);
  const people = await loadNamedPeople();
  const keyOwner = await resolveKeyOwner();
  const items = [];
  const skipped = [];
  for (const [faceId, personId] of wanted) {
    const face = current.get(faceId);
    if (!face) skipped.push({ faceId, reason: 'Face nicht gefunden' });
    else if (face.ownerId !== keyOwner.ownerId) skipped.push({ faceId, reason: 'anderes Konto' });
    // the view may be stale (second tab, a merge in Immich): only take faces that are still in the source group
    else if (sourcePersonId && (face.personId || null) !== sourcePersonId) skipped.push({ faceId, reason: 'inzwischen anders zugeordnet' });
    else if ((face.personId || null) === personId) skipped.push({ faceId, reason: personId ? 'bereits zugeordnet' : 'bereits ohne Person' });
    else items.push({ faceId, assetId: face.assetId, from: face.personId || null, to: personId });
  }

  const batch = newBatchId();
  const source = sourcePersonId ? (people.get(sourcePersonId)?.name || '') : '';
  await appendSplitLog([{ type: 'batch', time: new Date().toISOString(), batch, source: sourcePersonId, sourceName: source, requested: wanted.size, toAssign: items.length }]);
  let assigned = 0;
  const failures = [];
  const logAssign = (item, result) => appendSplitLog([{
    type: 'assign',
    time: new Date().toISOString(),
    batch,
    faceId: item.faceId,
    assetId: item.assetId,
    from: item.from,
    to: item.to,
    toName: item.to ? (people.get(item.to)?.name || '') : '',
    ok: result.ok,
    ...(result.ok ? {} : { status: result.status, message: result.message }),
  }]);
  await runWithWorkers(items.filter((item) => item.to), SPLIT_APPLY_WORKERS, async (item) => {
    const result = await reassignFace(item.faceId, item.to);
    if (result.ok) assigned++;
    else failures.push({ faceId: item.faceId, assetId: item.assetId, status: result.status, message: result.message });
    await logAssign(item, result);
  });
  // remove the person (personId null): the temporary-person path, verified in the database
  const detach = items.filter((item) => !item.to);
  if (detach.length) {
    let detached = new Set();
    let error = null;
    try {
      detached = new Set((await unassignFacesWithTemporaryPerson(detach.map((item) => ({ faceId: item.faceId, assetId: item.assetId })))).detachedFaceIds);
    } catch (cause) {
      error = cause.message;
    }
    for (const item of detach) {
      const ok = detached.has(item.faceId);
      if (ok) assigned++;
      else failures.push({ faceId: item.faceId, assetId: item.assetId, status: 0, message: error || 'Zuordnung konnte nicht gelöst werden' });
      await logAssign(item, ok ? { ok } : { ok, status: 0, message: error || 'not detached' });
    }
  }

  if (assigned) {
    invalidateAdjacentPeople();
    unnamedStatsCache.clear();
    markSuspiciousScanStale();
  }
  return {
    ok: failures.length === 0,
    batch,
    requested: wanted.size,
    assigned,
    failed: failures.length,
    skipped: skipped.length,
    failures: failures.slice(0, 50),
    skippedFaces: skipped.slice(0, 50),
  };
}

async function undoSplitBatch(batchId) {
  await ensureSplitLogWritable();
  const batches = splitBatches(await readSplitLog());
  const batch = batchId ? batches.find((b) => b.batch === batchId) : (await lastSplitBatch());
  if (!batch) {
    const error = new Error('Kein Zuordnungs-Durchgang zum Rückgängigmachen gefunden.');
    error.status = 404;
    throw error;
  }
  if (batch.undone) {
    const error = new Error('Dieser Durchgang wurde bereits rückgängig gemacht.');
    error.status = 409;
    throw error;
  }
  const done = batch.assignments.filter((entry) => entry.ok);
  const current = await loadFaceGroups(done.map((entry) => entry.faceId));
  const restore = [];
  const skipped = [];
  for (const entry of done) {
    const face = current.get(entry.faceId);
    if (!face) skipped.push({ faceId: entry.faceId, reason: 'Face nicht mehr vorhanden' });
    else if (face.personId !== entry.to) skipped.push({ faceId: entry.faceId, reason: 'inzwischen anders zugeordnet' });
    else restore.push(entry);
  }

  let restored = 0;
  const failures = [];
  const logUndo = (entry, result) => appendSplitLog([{
    type: 'undo',
    time: new Date().toISOString(),
    batch: batch.batch,
    faceId: entry.faceId,
    assetId: entry.assetId,
    from: entry.to,
    to: entry.from,
    ok: result.ok,
    ...(result.ok ? {} : { status: result.status, message: result.message }),
  }]);

  await runWithWorkers(restore.filter((entry) => entry.from), SPLIT_APPLY_WORKERS, async (entry) => {
    const result = await reassignFace(entry.faceId, entry.from);
    if (result.ok) restored++;
    else failures.push({ faceId: entry.faceId, status: result.status, message: result.message });
    await logUndo(entry, result);
  });

  // faces that had no person before go back to "no person" (temporary-person path, verified in the database)
  const unassign = restore.filter((entry) => !entry.from);
  if (unassign.length) {
    let detached = new Set();
    let error = null;
    try {
      detached = new Set((await unassignFacesWithTemporaryPerson(unassign.map((entry) => ({ faceId: entry.faceId, assetId: entry.assetId })))).detachedFaceIds);
    } catch (cause) {
      error = cause.message;
    }
    for (const entry of unassign) {
      const ok = detached.has(entry.faceId);
      if (ok) restored++;
      else failures.push({ faceId: entry.faceId, status: 0, message: error || 'Zuordnung konnte nicht gelöst werden' });
      await logUndo(entry, ok ? { ok } : { ok, status: 0, message: error || 'not detached' });
    }
  }

  await appendSplitLog([{ type: 'undo-batch', time: new Date().toISOString(), batch: batch.batch, restored, failed: failures.length, skipped: skipped.length }]);
  if (restored) {
    invalidateAdjacentPeople();
    unnamedStatsCache.clear();
    markSuspiciousScanStale();
  }
  return {
    ok: failures.length === 0,
    batch: batch.batch,
    restored,
    failed: failures.length,
    skipped: skipped.length,
    failures: failures.slice(0, 50),
    skippedFaces: skipped.slice(0, 50),
  };
}

async function makeCatchAllGroup(personId, name) {
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 120) throw badRequest('Bitte einen Namen mit 1 bis 120 Zeichen angeben.');
  const response = await immichFetch(`/people/${encodeURIComponent(personId)}`, {
    method: 'PUT',
    body: JSON.stringify({ name: cleanName, isHidden: true }),
  });
  if (response.ok) {
    invalidateNamedPeople();
    unnamedStatsCache.delete(personId);
    invalidateAdjacentPeople();
    markSuspiciousScanStale();
  }
  return response;
}

// "Suspicious groups": a background scan over the unnamed groups with a sample of faces per group.
const suspiciousScan = {
  running: false,
  stale: false,
  startedAt: null,
  finishedAt: null,
  phase: '',
  done: 0,
  total: 0,
  error: null,
  minFaces: SUSPICIOUS_MIN_FACES,
  sample: SUSPICIOUS_SAMPLE,
  groupsConsidered: 0,
  groups: [],
};

function markSuspiciousScanStale() {
  if (suspiciousScan.finishedAt) suspiciousScan.stale = true;
}

function suspiciousScanState() {
  const expired = suspiciousScan.finishedAt && Date.now() - Date.parse(suspiciousScan.finishedAt) > SUSPICIOUS_TTL_MS;
  const { groups, ...rest } = suspiciousScan;
  return { ...rest, stale: Boolean(suspiciousScan.stale || expired), groups };
}

async function runSuspiciousScan() {
  Object.assign(suspiciousScan, {
    running: true, stale: false, startedAt: new Date().toISOString(), finishedAt: null, phase: 'Personen laden', done: 0, total: 0, error: null, groupsConsidered: 0,
  });
  try {
    const all = await collectAllPeople();
    const people = namedPeopleIndex(all);
    namedPeopleCache = { at: Date.now(), index: people };
    const unnamedIds = all.filter((p) => p?.id && !String(p.name || '').trim() && !p.isHidden).map((p) => p.id);

    suspiciousScan.phase = 'Gesichter der unbenannten Gruppen laden';
    const pool = requireVectorDatabase();
    const keyOwner = await resolveKeyOwner();
    const personRef = await assetFacePersonRef();
    const rows = unnamedIds.length
      ? (await pool.query(
        `SELECT ${personRef} AS "personId", af.id AS "faceId", a."localDateTime", af."imageWidth",
                af."boundingBoxX1", af."boundingBoxX2", (fs."faceId" IS NOT NULL) AS "hasEmbedding"
           FROM asset_face af
           JOIN asset a ON a.id = af."assetId"
           LEFT JOIN face_search fs ON fs."faceId" = af.id
          WHERE ${personRef} = ANY($1::uuid[])
            AND a."ownerId" = $2::uuid
            AND af."deletedAt" IS NULL
            AND af."isVisible" IS TRUE
            AND a."deletedAt" IS NULL
          ORDER BY ${personRef}, a."localDateTime", af.id`,
        [unnamedIds, keyOwner.ownerId],
      )).rows
      : [];
    const byGroup = new Map();
    for (const row of rows) {
      if (!byGroup.has(row.personId)) byGroup.set(row.personId, []);
      byGroup.get(row.personId).push(row);
    }
    const groups = [];
    for (const [personId, faces] of byGroup) {
      if (faces.length < SUSPICIOUS_MIN_FACES) continue;
      const days = faces.map((face) => captureDay(face.localDateTime)).filter(Boolean).sort();
      const widths = faces.map(faceWidthShare).filter((w) => w > 0);
      groups.push({
        personId,
        faces: faces.length,
        firstDate: days[0] || '',
        lastDate: days.at(-1) || '',
        years: days.length ? Number(days.at(-1).slice(0, 4)) - Number(days[0].slice(0, 4)) : 0,
        meanWidthShare: widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0,
        sample: evenSample(faces.filter((face) => face.hasEmbedding), SUSPICIOUS_SAMPLE),
      });
    }
    suspiciousScan.groupsConsidered = groups.length;

    suspiciousScan.phase = 'Nachbarn abfragen';
    const sampleIds = groups.flatMap((group) => group.sample.map((face) => face.faceId));
    suspiciousScan.total = sampleIds.length;
    const neighbours = await findNamedNeighbours(sampleIds, [...people.keys()], {
      onProgress: (done) => { suspiciousScan.done = done; },
    });
    const nameOf = (id) => people.get(id)?.name || '';
    suspiciousScan.groups = groups.map((group) => {
      const votes = group.sample.map((face) => voteForFace(neighbours.get(face.faceId), { captureDate: face.localDateTime, people }));
      const summary = summarizeSplitVotes(votes, { groupId: group.personId });
      const { sample, ...rest } = group;
      return {
        ...rest,
        ...summary,
        majorityName: nameOf(summary.majorityId),
        proposals: summary.proposals.map((p) => ({ ...p, name: nameOf(p.personId) })),
      };
    }).sort((a, b) => b.assignableShare - a.assignableShare || b.disagreementShare - a.disagreementShare || b.faces - a.faces);
    suspiciousScan.phase = 'fertig';
  } catch (error) {
    console.error('Suspicious group scan failed:', error);
    suspiciousScan.error = error.message;
    suspiciousScan.phase = 'Fehler';
  } finally {
    suspiciousScan.running = false;
    suspiciousScan.finishedAt = new Date().toISOString();
  }
}

function vectorRouteError(res, error, what) {
  if (error.response) return proxyJson(res, error.response);
  if (error.status) return json(res, error.status, { message: error.message, code: error.code });
  if (error.code && String(error.code).startsWith('42')) {
    return json(res, 503, { message: `${what}: Immich-Datenbankschema oder Leserechte passen nicht: ${error.message}`, code: 'VECTOR_DB_SCHEMA_ERROR' });
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'SELF_SIGNED_CERT_IN_CHAIN', '28P01', '3D000'].includes(error.code)) {
    return json(res, 503, { message: `${what}: PostgreSQL ist nicht erreichbar: ${error.message}`, code: 'VECTOR_DB_CONNECTION_ERROR' });
  }
  throw error;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function proxyJson(res, response) {
  const text = await response.text();
  if (response.status === 204 || !text) {
    res.writeHead(response.status, { 'cache-control': 'no-store' });
    return res.end();
  }
  res.writeHead(response.status, {
    'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function collectPersonAssets(personId) {
  const items = [];
  let page = 1;
  while (page != null) {
    const r = await immichFetch('/search/metadata', {
      method: 'POST',
      body: JSON.stringify({ personIds: [personId], page, size: 100, order: 'asc', withPeople: false, withExif: false }),
    });
    if (!r.ok) {
      const error = new Error(`Immich asset search failed with HTTP ${r.status}`);
      error.response = r;
      throw error;
    }
    const data = await r.json();
    const assets = data.assets || {};
    items.push(...(assets.items || []));
    const rawNext = assets.nextPage;
    const next = rawNext == null || rawNext === '' ? null : Number(rawNext);
    page = Number.isFinite(next) ? next : null;
  }
  return items;
}

function assetDay(asset) {
  const value = asset.localDateTime || asset.fileCreatedAt || asset.createdAt;
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10) || null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getUnnamedPersonStats(personId) {
  const cached = unnamedStatsCache.get(personId);
  if (cached && Date.now() - cached.at < UNNAMED_STATS_TTL_MS) return cached.data;

  const assets = await collectPersonAssets(personId);
  const days = new Set(assets.map(assetDay).filter(Boolean));
  let faces = 0;
  let bestFaceAssetId = null;
  let bestFacePixels = -1;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, Math.max(1, assets.length)) }, async () => {
    while (cursor < assets.length) {
      const asset = assets[cursor++];
      const r = await immichFetch(`/faces?id=${encodeURIComponent(asset.id)}`);
      if (!r.ok) continue;
      const list = await r.json();
      const matching = list.filter((face) => face.person?.id === personId || face.personId === personId);
      faces += matching.length;
      for (const face of matching) {
        const width = Math.max(0, Number(face.boundingBoxX2) - Number(face.boundingBoxX1));
        const height = Math.max(0, Number(face.boundingBoxY2) - Number(face.boundingBoxY1));
        const pixels = width * height;
        if (Number.isFinite(pixels) && pixels > bestFacePixels) {
          bestFacePixels = pixels;
          bestFaceAssetId = asset.id;
        }
      }
    }
  });
  await Promise.all(workers);
  const data = { faces, days: days.size, assets: assets.length, bestFaceAssetId, bestFacePixels: Math.max(0, bestFacePixels) };
  unnamedStatsCache.set(personId, { at: Date.now(), data });
  return data;
}


function facePersonId(face) {
  return face?.person?.id || face?.personId || null;
}

function faceBoxPixels(face) {
  const width = Math.max(0, Number(face?.boundingBoxX2) - Number(face?.boundingBoxX1));
  const height = Math.max(0, Number(face?.boundingBoxY2) - Number(face?.boundingBoxY1));
  const pixels = width * height;
  return Number.isFinite(pixels) ? pixels : 0;
}

async function collectAllPeople() {
  const people = [];
  let page = 1;
  while (page < 10000) {
    const r = await immichFetch(`/people?page=${page}&size=250&withHidden=true`);
    if (!r.ok) {
      const error = new Error(`Immich people search failed with HTTP ${r.status}`);
      error.response = r;
      throw error;
    }
    const data = await r.json();
    people.push(...(data.people || []));
    if (!data.hasNextPage) break;
    page++;
  }
  return people;
}

async function scanDuplicatePersonFaces() {
  const people = await collectAllPeople();
  const faceCache = new Map();
  const assetMeta = new Map();
  const matches = [];
  let personCursor = 0;

  async function getFaces(assetId) {
    if (!faceCache.has(assetId)) {
      faceCache.set(assetId, (async () => {
        const r = await immichFetch(`/faces?id=${encodeURIComponent(assetId)}`);
        if (!r.ok) {
          const error = new Error(`Immich face lookup failed with HTTP ${r.status}`);
          error.response = r;
          throw error;
        }
        return r.json();
      })());
    }
    return faceCache.get(assetId);
  }

  const workers = Array.from({ length: Math.min(4, Math.max(1, people.length)) }, async () => {
    while (personCursor < people.length) {
      const person = people[personCursor++];
      const assets = await collectPersonAssets(person.id);
      for (const asset of assets) {
        assetMeta.set(asset.id, asset);
        const faces = await getFaces(asset.id);
        const samePerson = faces.filter((face) => facePersonId(face) === person.id);
        if (samePerson.length <= 1) continue;
        const sorted = samePerson.slice().sort((a, b) => faceBoxPixels(a) - faceBoxPixels(b));
        const keep = sorted[0];
        const remove = sorted.slice(1);
        matches.push({
          assetId: asset.id,
          assetName: asset.originalFileName || '',
          personId: person.id,
          personName: person.name || '',
          keepFaceId: keep.id,
          keepPixels: faceBoxPixels(keep),
          remove: remove.map((face) => ({ faceId: face.id, pixels: faceBoxPixels(face) })),
        });
      }
    }
  });
  await Promise.all(workers);

  const scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const removals = matches.flatMap((match) => match.remove.map((item) => ({
    ...item,
    assetId: match.assetId,
    assetName: match.assetName,
    personId: match.personId,
    personName: match.personName,
  })));
  const scan = { createdAt: Date.now(), matches, removals };
  duplicateFaceScans.set(scanId, scan);
  for (const [id, value] of duplicateFaceScans) {
    if (Date.now() - value.createdAt > DUPLICATE_SCAN_TTL_MS) duplicateFaceScans.delete(id);
  }
  return {
    scanId,
    peopleScanned: people.length,
    assetsScanned: faceCache.size,
    duplicateAssets: new Set(matches.map((m) => m.assetId)).size,
    duplicateGroups: matches.length,
    facesToRemove: removals.length,
    preview: matches.slice(0, 20).map((m) => ({
      assetId: m.assetId,
      assetName: m.assetName,
      personId: m.personId,
      personName: m.personName,
      markedFaces: m.remove.length + 1,
      keepPixels: m.keepPixels,
      removePixels: m.remove.map((x) => x.pixels),
    })),
  };
}

async function applyDuplicatePersonFaceScan(scanId) {
  const scan = duplicateFaceScans.get(scanId);
  if (!scan || Date.now() - scan.createdAt > DUPLICATE_SCAN_TTL_MS) {
    duplicateFaceScans.delete(scanId);
    const error = new Error('Scan ist abgelaufen. Bitte erneut scannen.');
    error.status = 410;
    throw error;
  }
  let cursor = 0;
  let removed = 0;
  const failures = [];
  const workers = Array.from({ length: Math.min(4, Math.max(1, scan.removals.length)) }, async () => {
    while (cursor < scan.removals.length) {
      const item = scan.removals[cursor++];
      try {
        const r = await immichFetch(`/faces/${encodeURIComponent(item.faceId)}`, {
          method: 'DELETE',
          body: JSON.stringify({ force: true }),
        });
        if (!r.ok) {
          const text = await r.text();
          failures.push({ faceId: item.faceId, assetId: item.assetId, status: r.status, message: text.slice(0, 300) });
        } else {
          removed++;
        }
      } catch (error) {
        failures.push({ faceId: item.faceId, assetId: item.assetId, status: 0, message: error.message });
      }
    }
  });
  await Promise.all(workers);
  duplicateFaceScans.delete(scanId);
  return { ok: failures.length === 0, requested: scan.removals.length, removed, failed: failures.length, failures: failures.slice(0, 30) };
}

async function streamImmich(res, response, cache = true) {
  if (!response.ok) return proxyJson(res, response);
  const headers = {
    'content-type': response.headers.get('content-type') || 'application/octet-stream',
    'cache-control': cache ? 'private, max-age=3600' : 'no-store',
  };
  const length = response.headers.get('content-length');
  if (length) headers['content-length'] = length;
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/review-api/status') {
      const r = await immichFetch('/api-keys/me');
      if (!r.ok) return proxyJson(res, r);
      const keyInfo = await r.json();
      return json(res, 200, {
        ok: true,
        keyName: keyInfo.name || 'API key',
        immichExternalUrl,
        // Backward-compatible field for older frontends. It intentionally contains the browser URL, not the internal API URL.
        immichUrl: immichExternalUrl,
        version: appVersion,
        vectorDatabase: await vectorDatabaseInfo({ probe: true }),
        split: {
          maxFaces: splitMaxFaces,
          rule: SPLIT_RULE,
          log: await splitLogStatus(),
          // only what is already known: the status check must stay cheap (resolving reads assets through the API)
          keyOwner: keyOwnerCache?.info || null,
        },
      });
    }

    const splitWrite = url.pathname.startsWith('/review-api/split/') || /\/catch-all$/.test(url.pathname);
    if (req.method !== 'GET' && splitWrite && !isJsonRequest(req)) {
      return json(res, 415, { message: 'Erwartet wird ein JSON-Body (content-type: application/json).' });
    }

    const splitMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/split$/i);
    if (req.method === 'GET' && splitMatch) {
      if (!isUuid(splitMatch[1])) return json(res, 400, { message: 'Ungültige Personen-ID' });
      try {
        return json(res, 200, await getPersonSplit(splitMatch[1]));
      } catch (error) {
        return vectorRouteError(res, error, 'Gruppe aufteilen');
      }
    }

    if (req.method === 'POST' && url.pathname === '/review-api/split/apply') {
      let body;
      try { body = await parseBody(req); } catch { return json(res, 400, { message: 'Ungültiges JSON' }); }
      try {
        return json(res, 200, await exclusiveSplitWrite(() => applySplitAssignments(body)));
      } catch (error) {
        return vectorRouteError(res, error, 'Zuordnen');
      }
    }

    if (req.method === 'GET' && url.pathname === '/review-api/split/last') {
      return json(res, 200, { last: describeBatch(await lastSplitBatch()) });
    }

    if (req.method === 'POST' && url.pathname === '/review-api/split/undo') {
      let body;
      try { body = await parseBody(req); } catch { return json(res, 400, { message: 'Ungültiges JSON' }); }
      try {
        return json(res, 200, await exclusiveSplitWrite(() => undoSplitBatch(body?.batch ? String(body.batch) : '')));
      } catch (error) {
        return vectorRouteError(res, error, 'Rückgängig');
      }
    }

    if (req.method === 'POST' && url.pathname === '/review-api/split/new-person') {
      let body;
      try { body = await parseBody(req); } catch { return json(res, 400, { message: 'Ungültiges JSON' }); }
      const name = String(body?.name || '').trim();
      if (name.length > 120) return json(res, 400, { message: 'Name zu lang (höchstens 120 Zeichen).' });
      // an empty name gives an unnamed, visible person that can be named in Immich later
      const response = await immichFetch('/people', {
        method: 'POST',
        body: JSON.stringify({ ...(name ? { name } : {}), isHidden: false }),
      });
      if (response.ok) invalidateNamedPeople();
      return proxyJson(res, response);
    }

    const catchAllMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/catch-all$/i);
    if (req.method === 'POST' && catchAllMatch) {
      if (!isUuid(catchAllMatch[1])) return json(res, 400, { message: 'Ungültige Personen-ID' });
      let body;
      try { body = await parseBody(req); } catch { return json(res, 400, { message: 'Ungültiges JSON' }); }
      try {
        return proxyJson(res, await makeCatchAllGroup(catchAllMatch[1], body?.name));
      } catch (error) {
        if (error.status) return json(res, error.status, { message: error.message });
        throw error;
      }
    }

    if (req.method === 'POST' && url.pathname === '/review-api/split/suspicious/scan') {
      if (!vectorDbConfigured) return json(res, 503, { message: 'PostgreSQL-Zugriff ist nicht konfiguriert.', code: 'VECTOR_DB_NOT_CONFIGURED' });
      if (!suspiciousScan.running) runSuspiciousScan();
      return json(res, 202, suspiciousScanState());
    }

    if (req.method === 'GET' && url.pathname === '/review-api/split/suspicious') {
      return json(res, 200, suspiciousScanState());
    }





    if (req.method === 'POST' && url.pathname === '/review-api/maintenance/duplicate-person-faces/scan') {
      try {
        return json(res, 200, await scanDuplicatePersonFaces());
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        throw error;
      }
    }

    if (req.method === 'POST' && url.pathname === '/review-api/maintenance/duplicate-person-faces/apply') {
      const body = await parseBody(req);
      if (!body.scanId) return json(res, 400, { message: 'scanId is required' });
      try {
        const result = await applyDuplicatePersonFaceScan(body.scanId);
        if (result.removed) invalidateAdjacentPeople();
        return json(res, 200, result);
      } catch (error) {
        if (error.status) return json(res, error.status, { message: error.message });
        throw error;
      }
    }

    if (req.method === 'GET' && url.pathname === '/review-api/people') {
      const page = url.searchParams.get('page') || '1';
      const size = url.searchParams.get('size') || '100';
      const withHidden = url.searchParams.get('withHidden') || 'false';
      return proxyJson(res, await immichFetch(`/people?page=${encodeURIComponent(page)}&size=${encodeURIComponent(size)}&withHidden=${encodeURIComponent(withHidden)}`));
    }

    if (req.method === 'GET' && url.pathname === '/review-api/people/search') {
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) return json(res, 200, []);
      return proxyJson(res, await immichFetch(`/search/person?name=${encodeURIComponent(q)}&withHidden=true`));
    }

    const vectorClusterMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/vector-cluster$/i);
    if (req.method === 'GET' && vectorClusterMatch) {
      if (!isUuid(vectorClusterMatch[1])) return json(res, 400, { message: 'Ungültige Personen-ID' });
      try {
        return json(res, 200, await getPersonVectorCluster(vectorClusterMatch[1]));
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        if (error.status) return json(res, error.status, { message: error.message, code: error.code });
        if (error.code && String(error.code).startsWith('42')) {
          return json(res, 503, { message: `Immich-Datenbankschema oder Leseberechtigungen konnten nicht verwendet werden: ${error.message}`, code: 'VECTOR_DB_SCHEMA_ERROR' });
        }
        if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'SELF_SIGNED_CERT_IN_CHAIN', '28P01', '3D000'].includes(error.code)) {
          return json(res, 503, { message: `PostgreSQL ist für den Vektor-Cluster nicht erreichbar: ${error.message}`, code: 'VECTOR_DB_CONNECTION_ERROR' });
        }
        throw error;
      }
    }

    const vectorNeighborsMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/vector-neighbors$/i);
    if (req.method === 'GET' && vectorNeighborsMatch) {
      const personId = vectorNeighborsMatch[1];
      if (!isUuid(personId)) return json(res, 400, { message: 'Ungültige Personen-ID' });
      const limit = Number(url.searchParams.get('limit') || 8);
      const force = /^(1|true|yes)$/i.test(url.searchParams.get('force') || '');
      try {
        return json(res, 200, await getAdjacentPeople(personId, limit, { force }));
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        if (error.status && error.status < 500) return json(res, error.status, { message: error.message, code: error.code });
        if (error.code && String(error.code).startsWith('42')) {
          return json(res, 503, { message: `Personenmittelpunkte konnten mit dem Immich-Datenbankschema oder den Leserechten nicht berechnet werden: ${error.message}`, code: 'VECTOR_DB_SCHEMA_ERROR' });
        }
        if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'SELF_SIGNED_CERT_IN_CHAIN', '28P01', '3D000'].includes(error.code)) {
          return json(res, 503, { message: `PostgreSQL ist für angrenzende Personen nicht erreichbar: ${error.message}`, code: 'VECTOR_DB_CONNECTION_ERROR' });
        }
        throw error;
      }
    }

    const vectorClusterUnassignMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/vector-cluster\/unassign$/i);
    if (req.method === 'POST' && vectorClusterUnassignMatch) {
      const personId = vectorClusterUnassignMatch[1];
      if (!isUuid(personId)) return json(res, 400, { message: 'Ungültige Personen-ID' });
      const body = await parseBody(req);
      if (!Array.isArray(body.faceIds) || !body.faceIds.length) return json(res, 400, { message: 'faceIds must be a non-empty array' });
      if (body.faceIds.length > 5000) return json(res, 413, { message: 'Maximal 5000 Face-Zuordnungen pro Batch' });
      if (body.faceIds.some((faceId) => !isUuid(faceId))) return json(res, 400, { message: 'Mindestens eine Face-ID ist ungültig.' });
      try {
        await verifyPersonAccess(personId);
        const validated = await validateClusterFaceIds(personId, body.faceIds);
        const requestedUnique = new Set(body.faceIds.map(String));
        if (!validated.length) return json(res, 409, { message: 'Keines der ausgewählten Faces ist dieser Person noch zugeordnet.' });
        const result = await unassignFacesWithTemporaryPerson(validated);
        invalidateAdjacentPeople();
        return json(res, 200, {
          ...result,
          ok: result.failed === 0 && validated.length === requestedUnique.size,
          requested: requestedUnique.size,
          processed: result.requested,
          validated: validated.length,
          skipped: Math.max(0, requestedUnique.size - validated.length),
        });
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        if (error.status) return json(res, error.status, { message: error.message, code: error.code });
        throw error;
      }
    }

    const personMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)$/i);
    if (req.method === 'GET' && personMatch) {
      return proxyJson(res, await immichFetch(`/people/${personMatch[1]}`));
    }

    const unnamedStatsMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/review-stats$/i);
    if (req.method === 'GET' && unnamedStatsMatch) {
      try {
        return json(res, 200, await getUnnamedPersonStats(unnamedStatsMatch[1]));
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        throw error;
      }
    }

    const refreshPersonThumbMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/refresh-thumbnail$/i);
    if (req.method === 'POST' && refreshPersonThumbMatch) {
      const id = refreshPersonThumbMatch[1];
      let stats;
      try {
        stats = await getUnnamedPersonStats(id);
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        throw error;
      }
      if (!stats.bestFaceAssetId) return json(res, 404, { message: 'Kein zugeordnetes Face für diese Person gefunden' });

      // featureFaceAssetId is the official Immich API field for selecting the person's feature thumbnail.
      // As of the current API it is exposed on PUT /people/{id}.
      const r = await immichFetch(`/people/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ featureFaceAssetId: stats.bestFaceAssetId }),
      });
      if (!r.ok) return proxyJson(res, r);
      unnamedStatsCache.delete(id);
      const result = await r.json();
      return json(res, 200, { ok: true, person: result, assetId: stats.bestFaceAssetId, facePixels: stats.bestFacePixels });
    }

    const hidePersonMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/hide$/i);
    if (req.method === 'PUT' && hidePersonMatch) {
      const id = hidePersonMatch[1];
      const r = await immichFetch('/people', {
        method: 'PUT',
        body: JSON.stringify({ people: [{ id, isHidden: true }] }),
      });
      if (r.ok) unnamedStatsCache.delete(id);
      return proxyJson(res, r);
    }

    const mergePersonMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/merge$/i);
    if (req.method === 'POST' && mergePersonMatch) {
      const sourceId = mergePersonMatch[1];
      const body = await parseBody(req);
      if (!body.targetPersonId) return json(res, 400, { message: 'targetPersonId is required' });
      if (body.targetPersonId === sourceId) return json(res, 400, { message: 'Quelle und Ziel duerfen nicht identisch sein' });
      const r = await immichFetch(`/people/${encodeURIComponent(body.targetPersonId)}/merge`, {
        method: 'POST',
        body: JSON.stringify({ ids: [sourceId] }),
      });
      if (r.ok) {
        unnamedStatsCache.delete(sourceId);
        unnamedStatsCache.delete(body.targetPersonId);
        invalidateAdjacentPeople();
      }
      return proxyJson(res, r);
    }

    const assetsMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/assets$/i);
    if (req.method === 'GET' && assetsMatch) {
      const personId = assetsMatch[1];
      const requestedPage = Number(url.searchParams.get('page') || '1');
      const requestedSize = Number(url.searchParams.get('size') || '40');
      const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const size = Number.isInteger(requestedSize) && requestedSize > 0 ? Math.min(requestedSize, 100) : 40;

      const takenBefore = url.searchParams.get('takenBefore');
      const searchBody = {
        personIds: [personId],
        page,
        size,
        order: 'asc',
        withPeople: false,
        withExif: false,
      };
      if (takenBefore) searchBody.takenBefore = takenBefore;

      const r = await immichFetch('/search/metadata', {
        method: 'POST',
        body: JSON.stringify(searchBody),
      });
      if (!r.ok) return proxyJson(res, r);

      const data = await r.json();
      const assets = data.assets || {};
      const items = assets.items || [];
      const rawNextPage = assets.nextPage;
      const nextPage = rawNextPage == null || rawNextPage === '' ? null : Number(rawNextPage);
      const total = Number.isFinite(Number(assets.total)) ? Number(assets.total) : null;

      return json(res, 200, {
        items,
        page,
        size,
        nextPage: Number.isFinite(nextPage) ? nextPage : null,
        total,
      });
    }

    const facesMatch = url.pathname.match(/^\/review-api\/assets\/([0-9a-f-]+)\/faces$/i);
    if (req.method === 'GET' && facesMatch) {
      // Immich GET /faces expects the asset UUID in the required `id` query parameter.
      return proxyJson(res, await immichFetch(`/faces?id=${encodeURIComponent(facesMatch[1])}`));
    }

    const thumbMatch = url.pathname.match(/^\/review-api\/assets\/([0-9a-f-]+)\/thumbnail$/i);
    if (req.method === 'GET' && thumbMatch) {
      const size = url.searchParams.get('size') || 'preview';
      return streamImmich(res, await immichFetch(`/assets/${thumbMatch[1]}/thumbnail?size=${encodeURIComponent(size)}`));
    }

    const pthumbMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/thumbnail$/i);
    if (req.method === 'GET' && pthumbMatch) {
      return streamImmich(res, await immichFetch(`/people/${pthumbMatch[1]}/thumbnail`));
    }

    const reassignMatch = url.pathname.match(/^\/review-api\/faces\/([0-9a-f-]+)\/reassign$/i);
    if (req.method === 'PUT' && reassignMatch) {
      const body = await parseBody(req);
      if (!body.personId) return json(res, 400, { message: 'personId is required' });
      const response = await immichFetch(`/faces/${body.personId}`, {
        method: 'PUT',
        body: JSON.stringify({ id: reassignMatch[1] }),
      });
      if (response.ok) invalidateAdjacentPeople();
      return proxyJson(res, response);
    }

    const unassignFaceMatch = url.pathname.match(/^\/review-api\/faces\/([0-9a-f-]+)\/unassign$/i);
    if (req.method === 'POST' && unassignFaceMatch) {
      const faceId = unassignFaceMatch[1];
      const body = await parseBody(req);
      if (!body.assetId) return json(res, 400, { message: 'assetId is required' });

      // Immich currently has no public endpoint that directly sets one face's person to null.
      // API-only workaround: move the face to a temporary hidden person, then delete that person.
      // Immich keeps the face record and clears its person relationship when the person is deleted.
      let temporaryPersonId = null;
      try {
        const create = await immichFetch('/people', {
          method: 'POST',
          body: JSON.stringify({
            name: `__immich_person_manager_unassign_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            birthDate: null,
            isHidden: true,
            isFavorite: false,
          }),
        });
        if (!create.ok) return proxyJson(res, create);
        const temporaryPerson = await create.json();
        temporaryPersonId = temporaryPerson.id;

        const move = await immichFetch(`/faces/${temporaryPersonId}`, {
          method: 'PUT',
          body: JSON.stringify({ id: faceId }),
        });
        if (!move.ok) {
          await immichFetch(`/people/${temporaryPersonId}`, { method: 'DELETE' });
          temporaryPersonId = null;
          return proxyJson(res, move);
        }

        const removeTemporaryPerson = await immichFetch(`/people/${temporaryPersonId}`, { method: 'DELETE' });
        temporaryPersonId = null;
        if (!removeTemporaryPerson.ok) return proxyJson(res, removeTemporaryPerson);

        const verify = await immichFetch(`/faces?id=${encodeURIComponent(body.assetId)}`);
        if (!verify.ok) return proxyJson(res, verify);
        const faces = await verify.json();
        const detached = faces.find((face) => face.id === faceId);
        if (!detached) return json(res, 409, { message: 'Zuordnung gelöst, aber Immich liefert die Face-Markierung danach nicht mehr zurück.' });
        if (detached.person != null || detached.personId != null) return json(res, 409, { message: 'Face ist noch einer Person zugeordnet.' });
        invalidateAdjacentPeople();
        return json(res, 200, { ok: true, face: detached });
      } catch (error) {
        if (temporaryPersonId) {
          try { await immichFetch(`/people/${temporaryPersonId}`, { method: 'DELETE' }); } catch {}
        }
        throw error;
      }
    }

    const deleteFaceMatch = url.pathname.match(/^\/review-api\/faces\/([0-9a-f-]+)$/i);
    if (req.method === 'DELETE' && deleteFaceMatch) {
      // Immich has no stable "unassign person" endpoint. Deleting the face removes
      // this face marker/association from the asset without assigning another person.
      const response = await immichFetch(`/faces/${deleteFaceMatch[1]}`, {
        method: 'DELETE',
        body: JSON.stringify({ force: true }),
      });
      if (response.ok) invalidateAdjacentPeople();
      return proxyJson(res, response);
    }

    if (req.method === 'POST' && url.pathname === '/review-api/people') {
      const body = await parseBody(req);
      if (!body.name?.trim()) return json(res, 400, { message: 'name is required' });
      return proxyJson(res, await immichFetch('/people', {
        method: 'POST',
        body: JSON.stringify({ name: body.name.trim(), birthDate: body.birthDate || null, isHidden: false, isFavorite: false }),
      }));
    }

    return json(res, 404, { message: 'Not found' });
  } catch (error) {
    console.error(error);
    return json(res, 500, { message: error.message || 'Internal error' });
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = path.normalize(rel).replace(/^\.\.(\/|\\|$)/, '');
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir)) return json(res, 403, { message: 'Forbidden' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      const fallback = path.join(publicDir, 'index.html');
      return fs.createReadStream(fallback).pipe(res.writeHead(200, { 'content-type': mime['.html'] }));
    }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, app: packageInfo.name, version: appVersion });
  }
  if (url.pathname.startsWith('/review-api/')) return handleApi(req, res, url);
  return serveStatic(req, res, url);
}).listen(port, '0.0.0.0', () => {
  console.log(`immich-person-manager v${appVersion}`);
  console.log(`Listening on :${port}`);
  console.log(`Immich API endpoint: ${immichUrl}${apiPrefix}`);
  console.log(`Immich external URL: ${immichExternalUrl || 'not configured'}`);
  console.log(`Vector database: ${vectorDbConfigured ? 'configured' : 'not configured'}`);
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  try { await vectorPool?.end(); } catch (error) { console.error('Could not close PostgreSQL pool:', error); }
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
