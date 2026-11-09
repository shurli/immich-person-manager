import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_FACE_PERSON_COLUMNS,
  assetFacePersonReference,
  selectAssetFacePersonColumn,
} from './asset-face-schema.mjs';

test('current Immich personGroupId is preferred', () => {
  assert.equal(selectAssetFacePersonColumn(['personId', 'personGroupId']), 'personGroupId');
  assert.equal(selectAssetFacePersonColumn(['personGroupId']), 'personGroupId');
});

test('legacy Immich personId remains supported', () => {
  assert.equal(selectAssetFacePersonColumn(['personId']), 'personId');
});

test('unsupported asset_face schemas fail clearly', () => {
  assert.throws(
    () => selectAssetFacePersonColumn(['assetId']),
    /weder "personGroupId" noch die ältere Spalte "personId"/,
  );
});

test('SQL person reference only accepts detected supported columns and safe aliases', () => {
  for (const column of ASSET_FACE_PERSON_COLUMNS) {
    assert.equal(assetFacePersonReference(column), `af."${column}"`);
  }
  assert.equal(assetFacePersonReference('personGroupId', 'asset_face'), 'asset_face."personGroupId"');
  assert.throws(() => assetFacePersonReference('unexpected'), /Ungültige asset_face-Personenspalte/);
  assert.throws(() => assetFacePersonReference('personId', 'af;drop'), /Ungültiger SQL-Alias/);
});
