// Pure helpers of the "Split group" view (tested in split-helpers.test.mjs).

/**
 * Name order for the dropdowns: alphabetical by initial letter, and within one letter the most recently used names
 * first. Typing a letter in a <select> jumps to the first option with that letter, i.e. the last name used with it.
 */
export function orderPeopleForPicker(people, recentIds = []) {
  const rank = new Map(recentIds.map((id, index) => [id, index]));
  const initial = (p) => String(p.name || '').trim().charAt(0).toLocaleLowerCase('de');
  return [...people].sort((a, b) => {
    const la = initial(a);
    const lb = initial(b);
    if (la !== lb) return la.localeCompare(lb, 'de');
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    if (ra !== rb) return ra < rb ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), 'de');
  });
}

export function rememberRecent(recentIds, id, max = 200) {
  if (!id) return recentIds.slice();
  return [id, ...recentIds.filter((x) => x !== id)].slice(0, max);
}

/** Block key of a face: level plus proposal; faces whose proposal is the group itself form a "stays" block. */
export function splitBlockKey(face) {
  if (face.level === 'unclear') return 'unclear';
  return `${face.level}|${face.stays ? 'stays' : face.proposalId}`;
}

/** Blocks in the order of the (already sorted) faces. */
export function splitBlocks(faces) {
  const blocks = new Map();
  for (const face of faces) {
    const key = splitBlockKey(face);
    if (!blocks.has(key)) {
      blocks.set(key, { key, level: face.level, stays: Boolean(face.stays), proposalId: face.level === 'unclear' ? '' : face.proposalId, proposalName: face.level === 'unclear' ? '' : face.proposalName, faces: [] });
    }
    blocks.get(key).faces.push(face);
  }
  return [...blocks.values()];
}

/**
 * Initial choice: only "sure" proposals for another person are preselected, and not those the server flagged
 * (face.preselect false: borderline distance or contradicting proposals inside the group).
 */
export function defaultChoice(face) {
  const proposal = face.stays ? '' : (face.proposalId || '');
  const preselect = face.preselect ?? face.level === 'sure';
  return { on: preselect && face.level === 'sure' && Boolean(proposal), personId: proposal };
}

/** Short German reasons for the warnings of a face (the UI is German like the rest of the app). */
export function warningTexts(face) {
  return (face.warnings || []).map((w) => (w.type === 'borderline'
    ? 'knapp an der Grenze'
    : w.type === 'conflict'
      ? `ähnelt Gesichtern dieser Gruppe mit Vorschlag ${(w.with || []).map((name) => name || 'diese Gruppe').join(', ') || 'einer anderen Person'}`
      : w.type));
}

/** The assignments to send: chosen faces with a target that is not the group itself. */
export function collectAssignments(faces, choices, groupId) {
  const out = [];
  for (const face of faces) {
    const choice = choices.get(face.faceId);
    if (choice?.on && choice.personId && choice.personId !== groupId) out.push({ faceId: face.faceId, personId: choice.personId });
  }
  return out;
}

export function formatShare(value) {
  return `${Math.round((Number(value) || 0) * 100)} %`;
}

/**
 * Faces after `startFaceId` in the block that "fill down" would change to `personId`: every following face except
 * those named by hand (`manual`) and those already chosen for that person.
 */
export function followingToFill(blockFaces, startFaceId, personId, choices, manual = new Set()) {
  const start = blockFaces.findIndex((face) => face.faceId === startFaceId);
  if (start < 0 || !personId) return [];
  return blockFaces.slice(start + 1)
    .map((face) => face.faceId)
    .filter((id) => !manual.has(id))
    .filter((id) => {
      const choice = choices.get(id);
      return !(choice?.on && choice.personId === personId);
    });
}
