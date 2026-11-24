import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
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

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/split-groups.json', import.meta.url), 'utf8'));
const fixturePeople = new Map(Object.entries(fixture.people).map(([id, p]) => [id, { id, name: id, birthDate: p.birthDate }]));

function vote(face) {
  return voteForFace(face.neighbours.map(([personId, distance]) => ({ personId, distance })), {
    captureDate: face.date,
    people: fixturePeople,
  });
}

test('vote reproduces the reference script on three real mixed groups', () => {
  assert.deepEqual(fixture.groups.map((g) => g.label), ['profile-views', 'look-alikes', 'small-faces']);
  for (const group of fixture.groups) {
    const levels = {};
    for (const [index, face] of group.faces.entries()) {
      const result = vote(face);
      const where = `${group.label} face ${index}`;
      assert.equal(result.level, face.expected.level, where);
      assert.equal(result.proposalId, face.expected.proposal, where);
      assert.equal(result.votes, face.expected.votes, where);
      assert.equal(result.droppedByBirth, face.expected.droppedByBirth, where);
      assert.ok(Math.abs(result.meanDistance - face.expected.mean) < 1e-12, where);
      assert.deepEqual(result.candidates.map((c) => [c.personId, c.votes]), face.expected.candidates, where);
      levels[result.level] = (levels[result.level] || 0) + 1;
    }
    assert.deepEqual(levels, group.levels, group.label);
  }
});

test('the three groups show the known patterns', () => {
  const [profileViews, lookAlikes, smallFaces] = fixture.groups.map((g) => g.faces.map(vote));
  // profile views of mostly one named person: most faces have a confident proposal for that person
  const sure = profileViews.filter((r) => r.level === 'sure');
  assert.equal(sure.length, 128);
  const byPerson = Object.groupBy(sure, (r) => r.proposalId);
  assert.ok(Math.max(...Object.values(byPerson).map((x) => x.length)) >= 115);
  // side views and tiny faces of many people: almost nothing is assignable
  assert.equal(smallFaces.filter((r) => r.level !== 'unclear').length, 3);
  // the birth-date rule dropped votes on many faces (people proposed on photos taken before they were born)
  assert.ok(smallFaces.filter((r) => r.droppedByBirth > 0).length >= 80);
  // two look-alike people: both are proposed
  assert.equal(new Set(lookAlikes.map((r) => r.proposalId).filter(Boolean)).size, 2);
});

test('vote rule edges', () => {
  const people = namedPeopleIndex([
    { id: 'a', name: 'Anna', birthDate: '2010-05-01' },
    { id: 'b', name: 'Bert', birthDate: null },
    { id: 'c', name: 'Carl', birthDate: '1950-01-01' },
    { id: 'u', name: '' },
    { id: 't', name: '__immich_person_manager_cluster_unassign_1' },
    { id: 'h', name: '_Unknown', isHidden: true },
  ]);
  assert.deepEqual([...people.keys()], ['a', 'b', 'c', 'h']);
  const n = (ids, d = 0.4) => ids.map((personId) => ({ personId, distance: d }));

  // 7 votes below 0.45 -> sure; 0.45 itself is not below the threshold
  assert.equal(voteForFace(n(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'c']), { people }).level, 'sure');
  assert.equal(voteForFace(n(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'c'], 0.45), { people }).level, 'likely');
  assert.equal(voteForFace(n(['a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'c', 'c'], 0.49), { people }).level, 'likely');
  assert.equal(voteForFace(n(['a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'c', 'c'], 0.5), { people }).level, 'unclear');
  const unclear = voteForFace(n(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'c']), { people });
  assert.equal(unclear.level, 'unclear');
  assert.equal(unclear.proposalId, '');
  assert.equal(unclear.topId, 'a');

  // unnamed and temporary people do not vote, and only the first 10 named neighbours count
  const mixed = voteForFace(n(['u', 't', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'c', 'c']), { people });
  assert.equal(mixed.neighbours, 10);
  assert.equal(mixed.votes, 7);

  // born after the photo: dropped; born on the day of the photo: kept; unknown capture date: no filter
  const born = n(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'c', 'c', 'c']);
  const before = voteForFace(born, { people, captureDate: '1999-07-01' });
  assert.equal(before.droppedByBirth, 7);
  assert.equal(before.topId, 'c');
  assert.equal(voteForFace(born, { people, captureDate: '2010-05-01' }).droppedByBirth, 0);
  assert.equal(voteForFace(born, { people, captureDate: null }).droppedByBirth, 0);
  assert.equal(voteForFace(born, { people, captureDate: new Date('2000-01-01T00:00:00Z') }).droppedByBirth, 7);

  // ties go to the nearer person (the one seen first)
  assert.equal(voteForFace(n(['b', 'a', 'a', 'b']), { people }).topId, 'b');
  // no named neighbour at all
  const none = voteForFace([], { people });
  assert.deepEqual([none.level, none.votes, none.meanDistance], ['unclear', 0, 1]);
});

test('capture day uses the stored wall-clock date', () => {
  assert.equal(captureDay(new Date('1966-03-01T23:30:00.000Z')), '1966-03-01');
  assert.equal(captureDay('2023-12-24T18:00:00.000Z'), '2023-12-24');
  assert.equal(captureDay(''), '');
  assert.equal(captureDay('garbage'), '');
  assert.equal(captureDay(new Date('invalid')), '');
});

test('faces are ordered by level, proposal name and distance', () => {
  const faces = [
    { faceId: '1', level: 'unclear', proposalName: '', meanDistance: 0.3 },
    { faceId: '2', level: 'sure', proposalName: 'Victor', meanDistance: 0.4 },
    { faceId: '3', level: 'sure', proposalName: 'Max', meanDistance: 0.42 },
    { faceId: '4', level: 'sure', proposalName: 'Victor', meanDistance: 0.35 },
    { faceId: '5', level: 'likely', proposalName: 'Anna', meanDistance: 0.46 },
  ];
  assert.deepEqual(faces.sort(compareSplitFaces).map((f) => f.faceId), ['3', '4', '2', '5', '1']);
});

test('group summary flags assignable and disagreeing faces', () => {
  const r = (level, topId, proposalId = level === 'unclear' ? '' : topId) => ({ level, topId, proposalId });
  const summary = summarizeSplitVotes([
    r('sure', 'v'), r('sure', 'v'), r('likely', 'm'), r('unclear', 'v'), r('unclear', 'x'), r('unclear', ''),
  ], { groupId: 'g' });
  assert.equal(summary.sampled, 6);
  assert.equal(summary.assignable, 3);
  assert.equal(summary.assignableShare, 0.5);
  assert.equal(summary.majorityId, 'v');
  assert.equal(summary.disagreementShare, 2 / 5);
  assert.deepEqual(summary.proposals, [{ personId: 'v', faces: 2 }, { personId: 'm', faces: 1 }]);
  // a proposal for the group itself (a named group) is "stays", not assignable
  assert.equal(summarizeSplitVotes([r('sure', 'g')], { groupId: 'g' }).assignable, 0);
});

test('even sample spreads over the whole list', () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(evenSample(items, 4), [0, 25, 50, 75]);
  assert.deepEqual(evenSample([1, 2], 5), [1, 2]);
});

test('borderline: only just below the threshold of the level', () => {
  assert.equal(isBorderline({ level: 'sure', meanDistance: 0.4465 }), true);
  assert.equal(isBorderline({ level: 'sure', meanDistance: 0.44 }), true);
  assert.equal(isBorderline({ level: 'sure', meanDistance: 0.4399 }), false);
  assert.equal(isBorderline({ level: 'likely', meanDistance: 0.495 }), true);
  assert.equal(isBorderline({ level: 'unclear', meanDistance: 0.6 }), false);
});

test('group conflicts: linked faces with different confident proposals', () => {
  // structure of a real group (2026-11-24): one face proposed for F, the rest for V; F's face is linked to two
  // V faces (0.29, 0.33), the other V faces form a separate tight cluster, one unclear face stands alone
  const faces = [
    ['f43', 'sure', 'F'], ['f85', 'sure', 'V'], ['f0f', 'sure', 'V'], ['fd7', 'likely', 'V'],
    ['fd0', 'likely', 'V'], ['f50', 'likely', 'V'], ['f8e', 'likely', 'V'],
    ['f2b', 'likely', 'V'], ['f8a', 'likely', 'V'], ['f3e', 'likely', 'V'], ['fdf', 'unclear', ''],
  ].map(([faceId, level, proposalId]) => ({ faceId, level, proposalId }));
  const links = [['f43', 'f2b'], ['f85', 'f2b'], ['f0f', 'fd7'], ['f0f', 'fd0'], ['f0f', 'f50'], ['f0f', 'f8e'],
    ['fd7', 'fd0'], ['fd0', 'f50'], ['f8e', 'f8a'], ['f8e', 'f3e'], ['f8a', 'f3e']];
  const conflicts = findGroupConflicts(faces, links);
  assert.deepEqual([...conflicts.keys()].sort(), ['f2b', 'f43', 'f85']);
  assert.deepEqual(conflicts.get('f43'), ['V']);
  assert.deepEqual(conflicts.get('f85'), ['F']);
  // one person per component, or links to unknown faces: no conflict
  assert.equal(findGroupConflicts(faces.filter((f) => f.proposalId !== 'F'), links).size, 0);
  assert.equal(findGroupConflicts(faces, [['f43', 'zzz']]).size, 0);
  // an unclear face links but does not propose
  assert.equal(findGroupConflicts([{ faceId: 'a', level: 'sure', proposalId: 'V' }, { faceId: 'b', level: 'unclear', proposalId: '' }], [['a', 'b']]).size, 0);
});

test('key owner: the readable account, or the one with most named faces', () => {
  assert.equal(chooseKeyOwner(['simon']), 'simon');
  assert.equal(chooseKeyOwner([]), null);
  assert.equal(chooseKeyOwner(['tati', 'simon'], new Map([['simon', 8426], ['tati', 309]])), 'simon');
  assert.equal(chooseKeyOwner(['simon', 'simon']), 'simon');
});
