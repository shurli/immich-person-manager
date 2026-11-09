function normalizedPersonName(person) {
  return String(person?.name || '').trim();
}

export function isKnownPerson(person) {
  return normalizedPersonName(person).length > 0;
}

export function comparePeopleKnownFirst(a, b) {
  const aKnown = isKnownPerson(a);
  const bKnown = isKnownPerson(b);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;

  const byName = normalizedPersonName(a).localeCompare(normalizedPersonName(b), 'de', {
    sensitivity: 'base',
    numeric: true,
  });
  if (byName) return byName;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}
