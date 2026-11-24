// "Gruppe aufteilen": per face a proposal from the nearest named faces; the user confirms by block or by face and
// the chosen faces are reassigned through the server (which logs every move for "Rückgängig").
// Also the "Verdächtige Gruppen" list in the "Unbenannte Personen" tab.
import {
  collectAssignments,
  defaultChoice,
  followingToFill,
  formatShare,
  orderPeopleForPicker,
  rememberRecent,
  splitBlocks,
  warningTexts,
} from './split-helpers.js';

const RECENT_KEY = 'ipm-split-recent-v1';
const choicesKey = (personId) => `ipm-split-choices-v1-${personId}`;
const CHOICES_INDEX_KEY = 'ipm-split-choices-index-v1';
const CHOICES_KEEP = 50;
const BLOCK_PAGE = 60;
const DEFAULT_CATCH_ALL = '_Unbekannt (seitlich/klein)';
// the API uses English level names; the UI (like the rest of the app) is German
const LEVEL_LABELS = { sure: 'sicher', likely: 'wahrscheinlich', unclear: 'unklar' };
// special picker values: take the face away from its person / create a new person for it
const NONE = '__none__';
const NEW = '__new__';

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or disabled */ }
}

function formatDistance(value) {
  return Number(value).toFixed(3).replace('.', ',');
}

function countByTarget(assignments, nameOf) {
  const counts = new Map();
  for (const item of assignments) {
    const name = nameOf(item.personId) || '?';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

export function createSplitView(deps) {
  const { $, api, toast, esc, thumbAsset, thumbPerson, cropRect, immichAssetUrl, hasImmichUrl, getPerson, onChanged, onPersonRenamed, openPersonSplit } = deps;
  const s = {
    data: null,
    loadedFor: null,
    loading: false,
    applying: false,
    token: 0,
    choices: new Map(),
    touched: new Set(),
    manual: new Set(),
    extraTargets: new Map(),
    peopleById: new Map(),
    pickerPeople: [],
    recent: readJson(RECENT_KEY, []),
    pickerVersion: 0,
    images: new Map(),
    observer: null,
    last: null,
  };

  function message(text, isError = false) {
    const el = $('#splitMessage');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
    el.classList.toggle('error', isError);
  }

  function reset() {
    s.token++;
    s.data = null;
    s.loadedFor = null;
    s.loading = false;
    s.choices.clear();
    s.touched.clear();
    s.manual.clear();
    s.images.clear();
    s.observer?.disconnect();
    $('#splitBlocks').innerHTML = '';
    $('#splitSummary').textContent = '';
    $('#splitActions').classList.add('hidden');
    message('');
  }

  function invalidate() {
    s.loadedFor = null;
  }

  async function load({ force = false } = {}) {
    const person = getPerson();
    if (!person) return;
    refreshLast();
    if (!force && s.data && s.loadedFor === person.id) return;
    const token = ++s.token;
    s.loading = true;
    s.observer?.disconnect();
    $('#splitBlocks').innerHTML = '';
    $('#splitActions').classList.add('hidden');
    $('#splitSummary').textContent = '';
    message('Gesichter und ihre nächsten benannten Nachbarn werden aus der Immich-Datenbank geladen… (etwa 1 Sekunde je 100 Gesichter)');
    try {
      const data = await api(`/review-api/people/${person.id}/split`);
      if (token !== s.token) return;
      s.data = data;
      s.loadedFor = person.id;
      s.peopleById = new Map(data.people.map((p) => [p.id, p]));
      restoreChoices();
      render();
    } catch (error) {
      if (token === s.token) message(error.message, true);
    } finally {
      if (token === s.token) s.loading = false;
    }
  }

  function restoreChoices() {
    const stored = readJson(choicesKey(s.loadedFor), {});
    s.choices.clear();
    s.touched.clear();
    s.manual.clear();
    for (const face of s.data.faces) {
      const saved = stored[face.faceId];
      if (saved && (!saved.personId || saved.personId === NONE || s.peopleById.has(saved.personId) || s.extraTargets.has(saved.personId))) {
        s.choices.set(face.faceId, { on: Boolean(saved.on && saved.personId), personId: saved.personId || '' });
        s.touched.add(face.faceId);
        if (saved.manual) s.manual.add(face.faceId);
      } else {
        s.choices.set(face.faceId, defaultChoice(face));
      }
    }
  }

  function saveChoices() {
    const out = {};
    for (const faceId of s.touched) out[faceId] = { ...s.choices.get(faceId), manual: s.manual.has(faceId) };
    writeJson(choicesKey(s.loadedFor), out);
    // remember the most recently edited groups and drop the stored choices of older ones
    const index = [s.loadedFor, ...readJson(CHOICES_INDEX_KEY, []).filter((id) => id !== s.loadedFor)];
    for (const id of index.slice(CHOICES_KEEP)) {
      try { localStorage.removeItem(choicesKey(id)); } catch { /* ignore */ }
    }
    writeJson(CHOICES_INDEX_KEY, index.slice(0, CHOICES_KEEP));
  }

  const nameOf = (personId) => (personId === NONE
    ? 'keine Person'
    : s.peopleById.get(personId)?.name || s.extraTargets.get(personId) || '');

  function render() {
    const { person, faces, levels, facesWithoutEmbedding, durationMs, warnings, conflictCheck, otherAccountFaces } = s.data;
    message(faces.length ? '' : 'Diese Gruppe hat keine Gesichter mit Embedding.');
    $('#splitSummary').innerHTML = `${faces.length} Gesichter · <b>${levels.sure}</b> sicher · <b>${levels.likely}</b> wahrscheinlich · <b>${levels.unclear}</b> unklar${facesWithoutEmbedding ? ` · ${facesWithoutEmbedding} ohne Embedding` : ''} · berechnet in ${(durationMs / 1000).toFixed(1).replace('.', ',')} s`;
    const notes = [];
    if (warnings?.conflict) notes.push(`<b>Widersprüchliche Vorschläge:</b> ${warnings.conflict} Gesichter hängen in dieser Gruppe eng zusammen (Abstand unter 0,35), bekommen aber verschiedene Personen vorgeschlagen (${esc(warnings.conflictNames.join(', '))}). Vermutlich ist ein Teil davon falsch, etwa weil die richtige Person kaum benannte Gesichter in dieser Ansicht hat.`);
    if (warnings?.borderline) notes.push(`<b>Knapp:</b> ${warnings.borderline} Gesichter liegen höchstens 0,01 unter der Grenze ihrer Stufe.`);
    if (warnings?.notPreselected) notes.push(`${warnings.notPreselected} „sicher“-Gesichter mit ⚠ sind deshalb nicht vorgewählt.`);
    if (conflictCheck === false) notes.push('Die Gruppe ist zu groß für die Prüfung auf widersprüchliche Vorschläge.');
    if (otherAccountFaces) notes.push(`${otherAccountFaces} Gesicht${otherAccountFaces === 1 ? '' : 'er'} dieser Gruppe ${otherAccountFaces === 1 ? 'gehört' : 'gehören'} zu einem anderen immich-Konto (z. B. einer anderen Bibliothek) und ${otherAccountFaces === 1 ? 'ist' : 'sind'} ausgeblendet: mit diesem API-Key nicht sichtbar und nicht zuordenbar.`);
    $('#splitWarnings').innerHTML = notes.map((n) => `<p>⚠ ${n}</p>`).join('');
    $('#splitWarnings').classList.toggle('hidden', !notes.length);
    s.pickerPeople = s.data.people.filter((p) => p.id !== person.id);
    s.pickerVersion++;
    s.observer?.disconnect();
    s.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        s.observer.unobserve(entry.target);
        paintCrop(entry.target);
      }
    }, { rootMargin: '600px 0px' });
    const root = $('#splitBlocks');
    root.innerHTML = '';
    for (const block of splitBlocks(faces)) root.append(renderBlock(block, person));
    $('#splitActions').classList.toggle('hidden', !faces.length);
    updateApply();
  }

  function blockTitle(block, person) {
    const n = block.faces.length;
    if (block.level === 'unclear') return `Unklar (${n})`;
    if (block.stays) return `bleibt bei ${person.name || 'dieser Gruppe'} · ${LEVEL_LABELS[block.level] || block.level} (${n})`;
    return `${block.proposalName} · ${LEVEL_LABELS[block.level] || block.level} (${n})`;
  }

  function renderBlock(block, person) {
    const section = document.createElement('section');
    section.className = `split-block level-${block.level}${block.stays ? ' stays' : ''}`;
    section.innerHTML = `<div class="split-block-head"><h3>${esc(blockTitle(block, person))}</h3>
      <div class="split-block-tools"><button type="button" class="btn ghost small" data-all>alle wählen</button><button type="button" class="btn ghost small" data-none>keine</button></div></div>
      <div class="split-grid"></div>
      <div class="split-more hidden"><button type="button" class="btn ghost small"></button></div>`;
    const grid = section.querySelector('.split-grid');
    const more = section.querySelector('.split-more');
    let shown = 0;
    const showMore = () => {
      const next = block.faces.slice(shown, shown + BLOCK_PAGE);
      for (const face of next) grid.append(renderCard(face, block, grid));
      shown += next.length;
      more.classList.toggle('hidden', shown >= block.faces.length);
      more.querySelector('button').textContent = `Weitere anzeigen (${block.faces.length - shown})`;
    };
    more.querySelector('button').onclick = showMore;
    section.querySelector('[data-all]').onclick = () => setBlock(block, true, grid);
    section.querySelector('[data-none]').onclick = () => setBlock(block, false, grid);
    showMore();
    return section;
  }

  function setBlock(block, on, grid) {
    let withoutPerson = 0;
    for (const face of block.faces) {
      const choice = s.choices.get(face.faceId);
      if (on && !choice.personId && !block.stays) choice.personId = block.proposalId || '';
      if (on && !choice.personId) withoutPerson++;
      choice.on = on && Boolean(choice.personId);
      s.touched.add(face.faceId);
    }
    for (const card of grid.querySelectorAll('.split-card')) updateCard(card);
    saveChoices();
    updateApply();
    if (withoutPerson) toast(`${withoutPerson} Gesicht${withoutPerson === 1 ? '' : 'er'} ohne Person: erst im Auswahlfeld eine Person wählen.`);
  }

  // "Fill down": after a name was picked for one face, offer it for the following faces of the same block.
  function showFill(card, block, grid, personId) {
    for (const button of document.querySelectorAll('#splitBlocks .split-fill:not(.hidden)')) button.classList.add('hidden');
    const ids = followingToFill(block.faces, card._face.faceId, personId, s.choices, s.manual);
    if (!ids.length) return;
    const button = card.querySelector('.split-fill');
    button.textContent = `↓ ${nameOf(personId)} auch für die nächsten ${ids.length}`;
    button.title = `Setzt alle folgenden Gesichter dieses Blocks auf ${nameOf(personId)} und wählt sie an; von Hand gewählte Namen bleiben.`;
    button.classList.remove('hidden');
    button.onclick = (event) => {
      event.stopPropagation();
      for (const id of followingToFill(block.faces, card._face.faceId, personId, s.choices, s.manual)) {
        s.choices.set(id, { on: true, personId });
        s.touched.add(id);
      }
      for (const other of grid.querySelectorAll('.split-card')) updateCard(other);
      saveChoices();
      updateApply();
      button.classList.add('hidden');
      toast(`${ids.length} Gesicht${ids.length === 1 ? '' : 'er'} auf ${nameOf(personId)} gesetzt`);
    };
  }

  function renderCard(face, block, grid) {
    const card = document.createElement('figure');
    const warnings = warningTexts(face);
    card.className = `split-card${warnings.length ? ' warn' : ''}`;
    card.dataset.face = face.faceId;
    card._face = face;
    const votes = face.votes
      ? `${face.votes}/${face.neighbours} Stimmen · Abstand ${formatDistance(face.meanDistance)}`
      : 'keine Stimmen';
    const detail = [
      ...face.candidates.map((c) => `${c.name || '?'}: ${c.votes}`),
      face.droppedByBirth ? `${face.droppedByBirth} Stimme${face.droppedByBirth === 1 ? '' : 'n'} wegen Geburtsdatum verworfen` : '',
      ...warningTexts(face).map((w) => `⚠ ${w}`),
      face.originalFileName,
    ].filter(Boolean).join('\n');
    const link = hasImmichUrl()
      ? `<a class="split-open" href="${esc(immichAssetUrl(face.assetId))}" target="_blank" rel="noopener noreferrer">ganzes Bild ↗</a>`
      : '';
    card.innerHTML = `<canvas width="240" height="240" title="${esc(detail)}"></canvas>
      <figcaption><b class="split-target"></b><span class="split-meta" title="${esc(detail)}">${esc(face.date || 'ohne Datum')} · ${esc(votes)}${face.droppedByBirth ? ` · ${face.droppedByBirth} verworfen (Geburt)` : ''}</span>${warnings.map((w) => `<span class="split-warning">⚠ ${esc(w)}</span>`).join('')}${link}</figcaption>
      <select aria-label="Person für dieses Gesicht"></select>
      <button type="button" class="split-fill hidden"></button>`;
    const canvas = card.querySelector('canvas');
    canvas._face = face;
    s.observer.observe(canvas);
    canvas.onclick = () => {
      const choice = s.choices.get(face.faceId);
      if (!choice.on && !choice.personId) choice.personId = face.stays ? '' : (face.proposalId || '');
      if (!choice.on && !choice.personId) {
        toast('Erst im Auswahlfeld eine Person wählen.');
        return;
      }
      choice.on = !choice.on;
      s.touched.add(face.faceId);
      updateCard(card);
      saveChoices();
      updateApply();
    };
    const select = card.querySelector('select');
    select.addEventListener('mousedown', () => fillPicker(select));
    select.addEventListener('focus', () => fillPicker(select));
    const choose = (personId) => {
      const choice = s.choices.get(face.faceId);
      choice.personId = personId;
      choice.on = Boolean(personId);
      s.touched.add(face.faceId);
      if (personId) {
        s.manual.add(face.faceId);
        if (personId !== NONE) rememberPerson(personId);
      } else {
        s.manual.delete(face.faceId);
      }
      updateCard(card);
      saveChoices();
      updateApply();
      showFill(card, block, grid, personId);
    };
    select.onchange = async () => {
      if (select.value !== NEW) return choose(select.value);
      const previous = s.choices.get(face.faceId).personId || '';
      select.value = previous;
      const personId = await createPerson();
      if (!personId) return;
      fillPicker(select);
      select.value = personId;
      choose(personId);
    };
    card.querySelector('.split-open')?.addEventListener('click', (event) => event.stopPropagation());
    updateCard(card);
    return card;
  }

  // A new person for faces of someone not named yet. An empty name gives an unnamed person to be named in Immich later.
  async function createPerson() {
    const name = window.prompt('Name der neuen Person (leer lassen: unbenannte Person, die du später in immich benennst).\n\nDie Person wird sofort angelegt; die Gesichter kommen erst mit „Zuordnen“ dazu. Bleibt sie leer, räumt immich sie später selbst weg.', '');
    if (name === null) return '';
    try {
      const person = await api('/review-api/split/new-person', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      if (person.name) {
        const entry = { id: person.id, name: person.name, birthDate: null, isHidden: false };
        s.peopleById.set(entry.id, entry);
        s.pickerPeople.push(entry);
      } else {
        s.extraTargets.set(person.id, `Neue Person (unbenannt) ${s.extraTargets.size + 1}`);
      }
      s.pickerVersion++;
      toast(`„${nameOf(person.id)}“ angelegt`);
      return person.id;
    } catch (error) {
      toast(error.message);
      return '';
    }
  }

  // "Stays": the face keeps its current group; for a named person that means it already belongs to that person.
  const groupName = () => String(s.data?.person?.name || '').trim();
  const stayLabel = () => (groupName() ? `bleibt bei ${groupName()}` : 'bleibt');
  const stayOption = () => (groupName() ? `— bleibt bei ${groupName()} —` : '— bleibt in dieser Gruppe —');

  // Selects start with just the chosen option; the full, MRU-ordered list is built when a select is opened.
  function setPickerMinimal(select, personId) {
    select.innerHTML = `<option value="">${esc(stayOption())}</option>`
      + (personId ? `<option value="${esc(personId)}">${esc(nameOf(personId) || '?')}</option>` : '');
    select.value = personId || '';
    select.dataset.filled = '';
  }

  function fillPicker(select) {
    if (select.dataset.filled === String(s.pickerVersion)) return;
    const value = select.value;
    const options = orderPeopleForPicker(s.pickerPeople, s.recent)
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.isHidden ? ' (ausgeblendet)' : ''}</option>`).join('');
    const extra = [...s.extraTargets].map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
    const from = groupName() ? ` aus ${groupName()}` : '';
    select.innerHTML = `<option value="">${esc(stayOption())}</option>`
      + `<option value="${NEW}">＋ Neue Person…</option>`
      + `<option value="${NONE}">✕ Zuordnung${esc(from)} lösen (keine Person)</option>`
      + extra + options;
    select.value = value;
    select.dataset.filled = String(s.pickerVersion);
  }

  function rememberPerson(personId) {
    s.recent = rememberRecent(s.recent, personId);
    writeJson(RECENT_KEY, s.recent);
    s.pickerVersion++;
  }

  function updateCard(card) {
    const face = card._face;
    const choice = s.choices.get(face.faceId);
    const on = Boolean(choice.on && choice.personId);
    card.classList.toggle('on', on);
    const target = card.querySelector('.split-target');
    target.textContent = on && choice.personId === NONE ? `✕ ${groupName() ? `aus ${groupName()} ` : ''}lösen`
      : on ? `→ ${nameOf(choice.personId)}` : (choice.personId ? `${nameOf(choice.personId)}?` : stayLabel());
    const select = card.querySelector('select');
    if (select.value !== (choice.personId || '')) {
      if (select.dataset.filled) select.value = choice.personId || '';
      else setPickerMinimal(select, choice.personId);
    } else if (!select.options.length) {
      setPickerMinimal(select, choice.personId);
    }
  }

  function loadImage(assetId) {
    if (!s.images.has(assetId)) {
      s.images.set(assetId, new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Thumbnail konnte nicht geladen werden'));
        image.src = thumbAsset(assetId);
      }));
    }
    return s.images.get(assetId);
  }

  async function paintCrop(canvas) {
    const face = canvas._face;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try {
      const image = await loadImage(face.assetId);
      if (!canvas.isConnected) return;
      const rect = cropRect(face);
      const sx = image.naturalWidth / Math.max(1, Number(face.imageWidth));
      const sy = image.naturalHeight / Math.max(1, Number(face.imageHeight));
      ctx.drawImage(image, rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy, 0, 0, canvas.width, canvas.height);
    } catch {
      ctx.fillStyle = '#6b7280';
      ctx.font = '14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Kein Bild', canvas.width / 2, canvas.height / 2);
    }
  }

  function currentAssignments() {
    return s.data ? collectAssignments(s.data.faces, s.choices, s.loadedFor) : [];
  }

  function updateApply() {
    const list = currentAssignments();
    const button = $('#splitApplyBtn');
    if (!s.applying) button.textContent = `Zuordnen (${list.length})`;
    button.disabled = !list.length || s.applying;
    const counts = countByTarget(list, nameOf);
    $('#splitSelectionInfo').textContent = list.length
      ? counts.slice(0, 5).map(([name, n]) => `${name} ${n}`).join(' · ') + (counts.length > 5 ? ' · …' : '')
      : 'Nichts gewählt. Grün umrandete Gesichter werden der Person darunter zugeordnet.';
  }

  async function apply() {
    const list = currentAssignments();
    if (!list.length || s.applying) return;
    const summary = countByTarget(list, nameOf).map(([name, n]) => `${name}: ${n}`).join('\n');
    const detaching = list.filter((item) => item.personId === NONE).length;
    const note = detaching ? `\n\n${detaching} Gesicht${detaching === 1 ? ' wird' : 'er werden'} keiner Person mehr zugeordnet. immich kann solche Gesichter bei der nächsten Gesichtserkennung wieder gruppieren; „＋ Neue Person…“ hält sie dagegen fest.` : '';
    if (!window.confirm(`${list.length} Gesicht${list.length === 1 ? '' : 'er'} zuordnen?\n\n${summary}${note}\n\nDer Durchgang wird protokolliert und lässt sich mit „Rückgängig“ zurücknehmen.`)) return;
    s.applying = true;
    const button = $('#splitApplyBtn');
    button.disabled = true;
    button.textContent = `Ordne ${list.length} zu…`;
    try {
      const result = await api('/review-api/split/apply', {
        method: 'POST',
        body: JSON.stringify({ sourcePersonId: s.loadedFor, assignments: list.map((item) => (item.personId === NONE ? { ...item, personId: null } : item)) }),
      });
      toast(`${result.assigned} zugeordnet${result.skipped ? ` · ${result.skipped} übersprungen` : ''}${result.failed ? ` · ${result.failed} Fehler` : ''}`);
      if (result.failed) console.warn('Split apply failures', result.failures);
      try { localStorage.removeItem(choicesKey(s.loadedFor)); } catch { /* ignore */ }
      s.touched.clear();
      onChanged();
      s.applying = false;
      await load({ force: true });
    } catch (error) {
      toast(error.message);
    } finally {
      s.applying = false;
      updateApply();
    }
  }

  async function refreshLast() {
    try {
      s.last = (await api('/review-api/split/last')).last;
    } catch {
      s.last = null;
    }
    const button = $('#splitUndoBtn');
    button.classList.toggle('hidden', !s.last);
    if (!s.last) return;
    const time = new Date(s.last.time);
    button.textContent = `Rückgängig: ${s.last.assigned} Zuordnung${s.last.assigned === 1 ? '' : 'en'} (${time.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })})`;
    button.title = `Letzter Durchgang${s.last.sourceName ? ` aus „${s.last.sourceName}“` : ''} vom ${time.toLocaleString('de-AT')}`;
  }

  async function undo() {
    if (!s.last) return;
    const elsewhere = s.last.sourcePersonId && s.last.sourcePersonId !== getPerson()?.id;
    const where = elsewhere ? `\n\nAchtung: Der Durchgang stammt aus einer anderen Gruppe${s.last.sourceName ? ` („${s.last.sourceName}“)` : ''}.` : '';
    if (!window.confirm(`Letzten Durchgang rückgängig machen?\n\n${s.last.assigned} Gesichter gehen zurück in ihre alte Gruppe. Gesichter, die seitdem anders zugeordnet wurden, bleiben, wo sie sind.${where}`)) return;
    const button = $('#splitUndoBtn');
    button.disabled = true;
    try {
      const result = await api('/review-api/split/undo', { method: 'POST', body: JSON.stringify({ batch: s.last.batch }) });
      toast(`${result.restored} zurückgelegt${result.skipped ? ` · ${result.skipped} übersprungen` : ''}${result.failed ? ` · ${result.failed} Fehler` : ''}`);
      onChanged();
      await load({ force: true });
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function catchAll() {
    const person = getPerson();
    if (!person) return;
    const name = window.prompt('Name der Sammelgruppe. Die restlichen Gesichter bleiben in dieser Gruppe; sie wird umbenannt und ausgeblendet, damit ähnliche unklare Gesichter nicht in echte Personen wandern.', DEFAULT_CATCH_ALL);
    if (name == null || !name.trim()) return;
    const pending = currentAssignments().length;
    const warnings = [];
    if (pending) warnings.push(`${pending} gewählte Gesichter sind noch nicht zugeordnet (erst „Zuordnen“).`);
    if (person.name && !person.name.startsWith('_')) warnings.push(`Die Gruppe heißt bereits „${person.name}“.`);
    if (!window.confirm(`Gruppe in „${name.trim()}“ umbenennen und ausblenden?${warnings.length ? `\n\n${warnings.join('\n')}` : ''}`)) return;
    try {
      const updated = await api(`/review-api/people/${person.id}/catch-all`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      onPersonRenamed(updated);
      toast(`Gruppe heißt jetzt „${updated.name}“ und ist ausgeblendet.`);
      if (s.data) s.data.person = { ...s.data.person, name: updated.name, isHidden: true };
    } catch (error) {
      toast(error.message);
    }
  }

  // ---- Verdächtige Gruppen ----
  const sus = { open: false, timer: 0, state: null, sortKey: 'assignableShare', sortDir: -1 };

  async function toggleSuspicious() {
    sus.open = !sus.open;
    $('#suspiciousPanel').classList.toggle('hidden', !sus.open);
    $('#suspiciousBtn').classList.toggle('active', sus.open);
    clearTimeout(sus.timer);
    if (!sus.open) return;
    try {
      const state = await api('/review-api/split/suspicious');
      if (!state.running && (!state.finishedAt || state.stale || state.error)) await startScan();
      else showScan(state);
    } catch (error) {
      $('#suspiciousStatus').textContent = error.message;
    }
  }

  async function startScan() {
    clearTimeout(sus.timer);
    try {
      showScan(await api('/review-api/split/suspicious/scan', { method: 'POST', body: '{}' }));
    } catch (error) {
      $('#suspiciousStatus').textContent = error.message;
    }
  }

  async function pollScan() {
    if (!sus.open) return;
    try {
      showScan(await api('/review-api/split/suspicious'));
    } catch (error) {
      $('#suspiciousStatus').textContent = error.message;
    }
  }

  function showScan(state) {
    sus.state = state;
    const status = $('#suspiciousStatus');
    if (state.running) {
      status.textContent = `${state.phase}${state.total ? `: ${state.done} von ${state.total} Gesichtern` : ''} …`;
      sus.timer = setTimeout(pollScan, 1000);
    } else if (state.error) {
      status.textContent = `Fehler: ${state.error}`;
    } else {
      const when = state.finishedAt ? new Date(state.finishedAt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) : '';
      status.textContent = `${state.groups.length} unbenannte Gruppen mit mindestens ${state.minFaces} Gesichtern, je bis zu ${state.sample} Gesichter geprüft · Stand ${when}${state.stale ? ' · inzwischen geändert, „Neu scannen“' : ''}`;
    }
    renderSuspicious();
  }

  const SUSPICIOUS_COLUMNS = [
    { key: 'faces', label: 'Gesichter' },
    { key: 'years', label: 'Zeitraum' },
    { key: 'meanWidthShare', label: 'Ø Breite', title: 'mittlere Gesichtsbreite in Prozent der Bildbreite' },
    { key: 'assignableShare', label: 'zuordenbar', title: 'Anteil der geprüften Gesichter mit einem sicheren oder wahrscheinlichen Vorschlag' },
    { key: 'disagreementShare', label: 'uneinig', title: 'Anteil der Gesichter, deren Abstimmung nicht die Mehrheitsperson der Gruppe nennt' },
  ];

  function renderSuspicious() {
    const groups = [...(sus.state?.groups || [])].sort((a, b) => sus.sortDir * ((a[sus.sortKey] || 0) - (b[sus.sortKey] || 0)) || b.faces - a.faces);
    const head = `<tr><th></th>${SUSPICIOUS_COLUMNS.map((c) => `<th><button type="button" data-sort="${c.key}" title="${esc(c.title || '')}" class="${sus.sortKey === c.key ? 'active' : ''}">${esc(c.label)}${sus.sortKey === c.key ? (sus.sortDir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`).join('')}<th>Vorschläge</th><th></th></tr>`;
    const rows = groups.map((g) => `<tr data-person="${esc(g.personId)}">
      <td><img src="${esc(thumbPerson(g.personId))}" alt="" loading="lazy"></td>
      <td>${g.faces}</td>
      <td>${esc(g.firstDate.slice(0, 4))}–${esc(g.lastDate.slice(0, 4))} <span class="muted">(${g.years} J.)</span></td>
      <td>${(g.meanWidthShare * 100).toFixed(1).replace('.', ',')} %</td>
      <td><b>${formatShare(g.assignableShare)}</b> <span class="muted">(${g.assignable}/${g.sampled})</span></td>
      <td>${formatShare(g.disagreementShare)}</td>
      <td>${g.proposals.map((p) => `${esc(p.name || '?')} ${p.faces}`).join(' · ') || '<span class="muted">–</span>'}</td>
      <td><button type="button" class="btn ghost small">Aufteilen →</button></td>
    </tr>`).join('');
    $('#suspiciousTable').innerHTML = `<thead>${head}</thead><tbody>${rows || `<tr><td colspan="8" class="muted">${sus.state?.running ? 'Scan läuft…' : 'Keine Gruppen.'}</td></tr>`}</tbody>`;
    for (const button of $('#suspiciousTable').querySelectorAll('[data-sort]')) {
      button.onclick = () => {
        if (sus.sortKey === button.dataset.sort) sus.sortDir = -sus.sortDir;
        else { sus.sortKey = button.dataset.sort; sus.sortDir = -1; }
        renderSuspicious();
      };
    }
    for (const row of $('#suspiciousTable').querySelectorAll('tr[data-person]')) row.onclick = () => openPersonSplit(row.dataset.person);
  }

  $('#splitApplyBtn').onclick = apply;
  $('#splitUndoBtn').onclick = undo;
  $('#splitReloadBtn').onclick = () => load({ force: true });
  $('#splitCatchAllBtn').onclick = catchAll;
  $('#suspiciousBtn').onclick = toggleSuspicious;
  $('#suspiciousScanBtn').onclick = startScan;

  return { load, reset, invalidate };
}
