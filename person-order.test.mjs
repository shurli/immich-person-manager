import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePeopleKnownFirst, isKnownPerson } from './public/person-order.js';

test('known people sort before unnamed people', () => {
  const people = [
    { id: 'u1', name: '' },
    { id: 'b', name: 'Berta' },
    { id: 'u2', name: '   ' },
    { id: 'a', name: 'Anton' },
  ].sort(comparePeopleKnownFirst);

  assert.deepEqual(people.map((person) => person.id), ['a', 'b', 'u1', 'u2']);
});

test('known-person detection trims whitespace and named people stay alphabetical', () => {
  assert.equal(isKnownPerson({ name: '  Maria  ' }), true);
  assert.equal(isKnownPerson({ name: '   ' }), false);
  assert.equal(isKnownPerson({}), false);

  const people = [
    { id: 'z', name: 'Zoe' },
    { id: 'a', name: 'Änne' },
    { id: 'm', name: 'Maria' },
  ].sort(comparePeopleKnownFirst);
  assert.deepEqual(people.map((person) => person.id), ['a', 'm', 'z']);
});
