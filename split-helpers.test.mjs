import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAssignments,
  defaultChoice,
  formatShare,
  orderPeopleForPicker,
  rememberRecent,
  followingToFill,
  splitBlocks,
  warningTexts,
} from './public/split-helpers.js';

test('picker order: by initial letter, most recently used first within a letter', () => {
  const people = [
    { id: 'v1', name: 'Victor' }, { id: 'v2', name: 'Viola' }, { id: 'm', name: 'Max' },
    { id: 's1', name: 'Sam' }, { id: 's2', name: 'Sabine' }, { id: 'u', name: '_Unknown' },
  ];
  assert.deepEqual(orderPeopleForPicker(people).map((p) => p.id), ['u', 'm', 's2', 's1', 'v1', 'v2']);
  let recent = rememberRecent([], 'v2');
  recent = rememberRecent(recent, 's1');
  assert.deepEqual(orderPeopleForPicker(people, recent).map((p) => p.id), ['u', 'm', 's1', 's2', 'v2', 'v1']);
  recent = rememberRecent(recent, 'v2');
  assert.deepEqual(recent, ['v2', 's1']);
  assert.equal(rememberRecent(Array.from({ length: 5 }, (_, i) => `p${i}`), 'x', 3).length, 3);
});

test('blocks follow the sorted faces; the group itself is a "stays" block', () => {
  const faces = [
    { faceId: '1', level: 'sure', proposalId: 'v', proposalName: 'Victor' },
    { faceId: '2', level: 'sure', proposalId: 'v', proposalName: 'Victor' },
    { faceId: '3', level: 'sure', proposalId: 'g', proposalName: 'Group', stays: true },
    { faceId: '4', level: 'likely', proposalId: 'm', proposalName: 'Max' },
    { faceId: '5', level: 'unclear', proposalId: '', proposalName: '' },
  ];
  const blocks = splitBlocks(faces);
  assert.deepEqual(blocks.map((b) => [b.key, b.faces.length]), [['sure|v', 2], ['sure|stays', 1], ['likely|m', 1], ['unclear', 1]]);

  const choices = new Map(faces.map((f) => [f.faceId, defaultChoice(f)]));
  assert.deepEqual([...choices.values()].map((c) => c.on), [true, true, false, false, false]);
  assert.equal(choices.get('3').personId, '');
  choices.set('5', { on: true, personId: 'm' });
  choices.set('4', { on: true, personId: 'g' });
  assert.deepEqual(collectAssignments(faces, choices, 'g'), [
    { faceId: '1', personId: 'v' }, { faceId: '2', personId: 'v' }, { faceId: '5', personId: 'm' },
  ]);
  assert.equal(formatShare(0.426), '43 %');
});

test('flagged sure faces are not preselected and say why', () => {
  const face = { faceId: '1', level: 'sure', proposalId: 'v', preselect: false, warnings: [{ type: 'borderline' }, { type: 'conflict', with: ['Felix'] }] };
  assert.deepEqual(defaultChoice(face), { on: false, personId: 'v' });
  assert.deepEqual(defaultChoice({ ...face, preselect: true, warnings: [] }), { on: true, personId: 'v' });
  assert.deepEqual(warningTexts(face), ['knapp an der Grenze', 'ähnelt Gesichtern dieser Gruppe mit Vorschlag Felix']);
  assert.deepEqual(warningTexts({}), []);
  assert.deepEqual(warningTexts({ warnings: [{ type: 'conflict', with: ['', 'Max'] }] }), ['ähnelt Gesichtern dieser Gruppe mit Vorschlag diese Gruppe, Max']);
});

test('fill down: following faces of the block, not those named by hand', () => {
  const faces = ['a', 'b', 'c', 'd', 'e'].map((faceId) => ({ faceId }));
  const choices = new Map([
    ['a', { on: true, personId: 'F' }], ['b', { on: false, personId: '' }], ['c', { on: true, personId: 'F' }],
    ['d', { on: true, personId: 'V' }], ['e', { on: false, personId: '' }],
  ]);
  assert.deepEqual(followingToFill(faces, 'a', 'F', choices), ['b', 'd', 'e']);
  assert.deepEqual(followingToFill(faces, 'a', 'F', choices, new Set(['d'])), ['b', 'e']);
  assert.deepEqual(followingToFill(faces, 'c', 'F', choices), ['d', 'e']);
  assert.deepEqual(followingToFill(faces, 'e', 'F', choices), []);
  assert.deepEqual(followingToFill(faces, 'x', 'F', choices), []);
  assert.deepEqual(followingToFill(faces, 'a', '', choices), []);
});
