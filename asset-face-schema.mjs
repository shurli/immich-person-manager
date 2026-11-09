export const ASSET_FACE_PERSON_COLUMNS = ['personGroupId', 'personId'];

export function selectAssetFacePersonColumn(columnNames) {
  const available = new Set((columnNames || []).map(String));
  for (const column of ASSET_FACE_PERSON_COLUMNS) {
    if (available.has(column)) return column;
  }
  throw new Error('asset_face enthält weder "personGroupId" noch die ältere Spalte "personId". Diese Immich-Datenbankversion wird für Vektor-Cluster derzeit nicht unterstützt.');
}

export function assetFacePersonReference(columnName, alias = 'af') {
  if (!ASSET_FACE_PERSON_COLUMNS.includes(columnName)) {
    throw new Error(`Ungültige asset_face-Personenspalte: ${columnName}`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Ungültiger SQL-Alias: ${alias}`);
  }
  return `${alias}."${columnName}"`;
}
