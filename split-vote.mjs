// "Split group": per face, the nearest faces of *named* people vote for a person.
//
// Rule (tested on real mixed groups):
//   - take the k = 10 nearest named faces of the same account (cosine distance of the face embeddings);
//   - first drop the neighbours whose person was born after the photo (birth date vs. capture date);
//   - sure:         >= 7 votes for one person and their mean distance < 0.45 (Immich's own maxDistance);
//   - likely: >= 5 votes and mean distance < 0.50;
//   - unclear:         everything else.
// Only "sure" is meant to be preselected; the user decides the rest.

export const SPLIT_LEVELS = Object.freeze(['sure', 'likely', 'unclear']);

export const SPLIT_RULE = Object.freeze({
  neighbours: 10,
  sure: Object.freeze({ votes: 7, maxMeanDistance: 0.45 }),
  likely: Object.freeze({ votes: 5, maxMeanDistance: 0.5 }),
  // warnings that keep a "sure" face from being preselected (calibrated on real groups, 2026-11-24):
  // - borderline: mean distance at most this far below the threshold
  borderlineMargin: 0.01,
  // - conflict: faces of the group linked by distances below this value (single linkage) are probably one person;
  //   if their confident proposals name different people, the proposals contradict each other
  groupLinkDistance: 0.35,
});

const TEMPORARY_PERSON_PREFIX = '__immich_person_manager_';

/** Calendar day (YYYY-MM-DD) of a capture time. Immich stores localDateTime as wall-clock time in UTC. */
export function captureDay(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

/**
 * Named people that may receive votes, keyed by id (the person group id in Immich 3.x).
 * Unnamed people and the manager's own temporary helper people are left out; hidden named people stay in
 * (a hidden catch-all such as "_Unknown (side/small faces)" is a valid target).
 */
export function namedPeopleIndex(people) {
  const index = new Map();
  for (const person of people || []) {
    const name = String(person?.name || '').trim();
    if (!person?.id || !name || name.startsWith(TEMPORARY_PERSON_PREFIX)) continue;
    index.set(person.id, {
      id: person.id,
      name,
      birthDate: captureDay(person.birthDate) || null,
      isHidden: Boolean(person.isHidden),
    });
  }
  return index;
}

/**
 * Vote for one face.
 * @param {Array<{personId: string, distance: number}>} neighbours nearest first; only named people count
 * @param {{captureDate?: string|Date|null, people: Map<string, {birthDate?: string|null}>, rule?: object}} options
 */
export function voteForFace(neighbours, { captureDate = '', people, rule = SPLIT_RULE } = {}) {
  const day = captureDay(captureDate);
  const named = [];
  for (const neighbour of neighbours || []) {
    if (!people?.has(neighbour.personId)) continue;
    named.push({ personId: neighbour.personId, distance: Number(neighbour.distance) });
    if (named.length >= rule.neighbours) break;
  }
  const kept = named.filter((n) => {
    const birth = people.get(n.personId)?.birthDate;
    return !(day && birth && birth > day);
  });

  // Count in neighbour order so that ties go to the person seen first, i.e. the nearer one.
  const counts = new Map();
  for (const n of kept) counts.set(n.personId, (counts.get(n.personId) || 0) + 1);
  let top = '';
  let votes = 0;
  for (const [personId, count] of counts) {
    if (count > votes) { top = personId; votes = count; }
  }
  let sum = 0;
  for (const n of kept) if (n.personId === top) sum += n.distance;
  const meanDistance = votes ? sum / votes : 1;

  const level = votes >= rule.sure.votes && meanDistance < rule.sure.maxMeanDistance
    ? 'sure'
    : votes >= rule.likely.votes && meanDistance < rule.likely.maxMeanDistance
      ? 'likely'
      : 'unclear';

  const candidates = [...counts]
    .map(([personId, count], order) => ({ personId, votes: count, order }))
    .sort((a, b) => b.votes - a.votes || a.order - b.order)
    .slice(0, 3)
    .map(({ personId, votes: count }) => ({ personId, votes: count }));

  return {
    level,
    proposalId: level === 'unclear' ? '' : top,
    topId: top,
    votes,
    meanDistance,
    neighbours: named.length,
    droppedByBirth: named.length - kept.length,
    candidates,
  };
}

/** A proposal whose mean distance is only just below its level's threshold. */
export function isBorderline(vote, rule = SPLIT_RULE) {
  const limit = vote.level === 'sure' ? rule.sure.maxMeanDistance : vote.level === 'likely' ? rule.likely.maxMeanDistance : null;
  return limit != null && vote.meanDistance >= limit - rule.borderlineMargin;
}

/**
 * Contradicting proposals inside one group.
 * @param {Array<{faceId: string, level: string, proposalId: string}>} faces  proposalId of the group itself = "stays"
 * @param {Array<[string, string]>} links  pairs of faces of the group closer than rule.groupLinkDistance
 * @returns {Map<string, string[]>} faceId -> the other proposed person ids, for faces with a confident proposal
 *   whose linked component also holds confident proposals for someone else
 */
export function findGroupConflicts(faces, links) {
  const parent = new Map(faces.map((face) => [face.faceId, face.faceId]));
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  for (const [a, b] of links) {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  }
  const proposalsByRoot = new Map();
  const confident = faces.filter((face) => face.level !== 'unclear' && face.proposalId);
  for (const face of confident) {
    const root = find(face.faceId);
    if (!proposalsByRoot.has(root)) proposalsByRoot.set(root, new Set());
    proposalsByRoot.get(root).add(face.proposalId);
  }
  const conflicts = new Map();
  for (const face of confident) {
    const proposals = proposalsByRoot.get(find(face.faceId));
    if (proposals.size > 1) conflicts.set(face.faceId, [...proposals].filter((id) => id !== face.proposalId));
  }
  return conflicts;
}

const LEVEL_ORDER = new Map(SPLIT_LEVELS.map((level, index) => [level, index]));

/** Order for the review blocks: level, then proposal name, then the closest faces first. */
export function compareSplitFaces(a, b) {
  return (LEVEL_ORDER.get(a.level) - LEVEL_ORDER.get(b.level))
    || String(a.proposalName || '').localeCompare(String(b.proposalName || ''), 'de')
    || a.meanDistance - b.meanDistance
    || String(a.faceId).localeCompare(String(b.faceId));
}

/**
 * Suspicion figures for one group from the votes of (a sample of) its faces.
 *   assignableShare:    share of faces with a "sure" or "likely" proposal for another person
 *   disagreementShare:  among faces with any vote, share whose top person differs from the group's majority
 */
export function summarizeSplitVotes(results, { groupId = '' } = {}) {
  const sampled = results.length;
  const assignable = results.filter((r) => r.level !== 'unclear' && r.proposalId && r.proposalId !== groupId);
  const withVotes = results.filter((r) => r.topId);
  const majorityCounts = new Map();
  for (const r of withVotes) majorityCounts.set(r.topId, (majorityCounts.get(r.topId) || 0) + 1);
  let majorityId = '';
  let majorityVotes = 0;
  for (const [personId, count] of majorityCounts) {
    if (count > majorityVotes) { majorityId = personId; majorityVotes = count; }
  }
  const proposals = new Map();
  for (const r of assignable) proposals.set(r.proposalId, (proposals.get(r.proposalId) || 0) + 1);
  return {
    sampled,
    assignable: assignable.length,
    assignableShare: sampled ? assignable.length / sampled : 0,
    disagreementShare: withVotes.length ? (withVotes.length - majorityVotes) / withVotes.length : 0,
    majorityId,
    proposals: [...proposals].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([personId, faces]) => ({ personId, faces })),
  };
}

/** Pick up to `size` items spread evenly over a (date-sorted) list. */
export function evenSample(items, size) {
  if (items.length <= size) return items.slice();
  const out = [];
  for (let i = 0; i < size; i++) out.push(items[Math.floor((i * items.length) / size)]);
  return out;
}

/**
 * The account whose faces this API key can see and change. `accessible`: owner ids for which the key could read an
 * asset; `namedFaceCounts`: Map(ownerId -> faces in the key's named people). With partner sharing several accounts
 * can be readable; the one holding most faces of the key's own named people is the key's account.
 */
export function chooseKeyOwner(accessible, namedFaceCounts = new Map()) {
  const candidates = [...new Set(accessible)];
  if (candidates.length <= 1) return candidates[0] || null;
  return candidates.sort((a, b) => (namedFaceCounts.get(b) || 0) - (namedFaceCounts.get(a) || 0))[0];
}
