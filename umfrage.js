// =====================================================================
// GipfelPfad Vorab-Seite – Umfrage „Würdest du wechseln?“
// Eine Frage pro Schritt, anonym, speichert in Supabase (Tabelle switch_survey,
// nur INSERT erlaubt) und zeigt den Zwischenstand über switch_survey_stats().
// Ohne supabase-js: zwei schlanke REST-Aufrufe. Setup: supabase/umfrage.sql
// =====================================================================
(function () {
  'use strict';

  const CFG = window.GP_SURVEY_CONFIG || {};
  const DONE_KEY = 'gp-umfrage-done';
  const MIN_FILL_MS = 6000;     // schneller ausgefüllt = sehr wahrscheinlich ein Bot
  const MIN_SAMPLE = 10;        // erst ab so vielen Antworten Prozentwerte zeigen
  const MAX_TEXT = 500;
  const AUTO_ADVANCE_MS = 260;
  const SRC_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

  const usesKomoot = (a) => (a.apps || []).includes('komoot');

  const STEPS = [
    { field: 'hikes_per_year', type: 'single', title: 'Wie viele Wandertouren machst du ungefähr im Jahr?',
      options: [['lt1', 'Weniger als eine'], ['1-3', '1 bis 3'], ['4-10', '4 bis 10'], ['10+', 'Mehr als 10']] },
    { field: 'hut_tours', type: 'single', title: 'Hast du schon Mehrtagestouren mit Hüttenübernachtung gemacht?',
      options: [['nie', 'Nein, interessiert mich nicht'], ['lust', 'Noch nicht, hätte aber Lust'],
        ['schon', 'Ein- oder zweimal'], ['regelmaessig', 'Ja, regelmäßig']] },
    { field: 'apps', type: 'multi', exclusive: 'keine', title: 'Womit planst du deine Touren?', hint: 'Mehrfachauswahl möglich.',
      options: [['komoot', 'komoot'], ['outdooractive', 'Outdooractive / alpenvereinaktiv'], ['bergfex', 'bergfex'],
        ['alltrails', 'AllTrails'], ['maps', 'Google Maps / Apple Karten'], ['papier', 'Karte, Wanderführer, Websites'],
        ['andere', 'Eine andere App'], ['keine', 'Ich plane gar nicht']] },
    { field: 'komoot_usage', type: 'single', showIf: usesKomoot, title: 'Wie nutzt du komoot?',
      options: [['free', 'Kostenlos'], ['regions', 'Mit gekauften Regionen / Weltpaket'], ['premium', 'Mit Premium-Abo']] },
    { field: 'barriers', type: 'multi', exclusive: 'nichts',
      title: (a) => usesKomoot(a) ? 'Was würde dich vom Wechsel abhalten?' : 'Was würde dich davon abhalten, GipfelPfad zu nutzen?',
      hint: 'Mehrfachauswahl möglich.',
      options: [['touren', 'Meine Touren liegen in meiner jetzigen App'], ['freunde', 'Meine Freunde nutzen eine andere App'],
        ['zufrieden', 'Ich bin mit meiner jetzigen Lösung zufrieden'], ['bezahlt', 'Ich habe dort schon bezahlt (Regionen, Abo)'],
        ['vertrauen', 'Ich weiß nicht, ob ich einer neuen App vertrauen kann'], ['aufwand', 'Keine Lust, eine neue App zu lernen'],
        ['nichts', 'Nichts davon']] },
    { field: 'reasons', type: 'multi', max: 3, exclusive: 'nichts', title: 'Was spricht für dich am meisten für GipfelPfad?',
      hint: 'Bis zu drei.',
      options: [['huetten', 'Hüttenplanung kostenlos'], ['community', 'Die App wird mit jeder Tour der Community besser'],
        ['schwierigkeit', 'Ehrliche Schwierigkeitsangaben'],
        ['kostenlos', 'Alles kostenlos, ohne Abo'], ['offen', 'Keine Werbung, kein Datenverkauf'],
        ['filter', 'Filter wie „Hütte am Weg“ oder „keine ausgesetzten Stellen“'], ['freunde', 'Touren der Freunde auf der Karte'],
        ['alpen', 'Fokus auf den Alpenraum'], ['nichts', 'Eigentlich nichts']] },
    { field: 'switch_likelihood', type: 'scale',
      title: (a) => usesKomoot(a)
        ? 'Wie wahrscheinlich ist es, dass du von komoot zu GipfelPfad wechselst?'
        : 'Wie wahrscheinlich ist es, dass du GipfelPfad für deine Touren nutzt?',
      hint: 'Stell dir vor, GipfelPfad gibt es mit allem, was du auf dieser Seite gesehen hast, komplett kostenlos.',
      options: [[5, 'Sehr wahrscheinlich'], [4, 'Eher wahrscheinlich'], [3, 'Unentschieden'],
        [2, 'Eher unwahrscheinlich'], [1, 'Sehr unwahrscheinlich']] },
    { field: 'final', type: 'final', title: 'Fast geschafft. Noch drei freiwillige Angaben.' },
  ];

  const AGE = [['', 'Keine Angabe'], ['u25', 'Unter 25'], ['25-39', '25 bis 39'], ['40-59', '40 bis 59'], ['60+', '60 oder älter']];
  const COUNTRY = [['', 'Keine Angabe'], ['de', 'Deutschland'], ['at', 'Österreich'], ['ch', 'Schweiz'], ['it', 'Italien'], ['andere', 'Anderes Land']];
  const REASON_LABEL = Object.fromEntries(STEPS.find((s) => s.field === 'reasons').options);

  let answers = {};
  let pos = 0;
  let startedAt = 0;
  let userNavigated = false;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const visibleSteps = () => STEPS.filter((s) => !s.showIf || s.showIf(answers));
  const textOf = (v) => (typeof v === 'function' ? v(answers) : v);
  const hasConfig = () => !!(CFG.SUPABASE_URL && CFG.SUPABASE_KEY);
  const headers = (extra) => ({ apikey: CFG.SUPABASE_KEY, Authorization: 'Bearer ' + CFG.SUPABASE_KEY, ...extra });
  const pct = (n, of) => (of > 0 ? Math.round((100 * n) / of) : 0);

  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach((c) => c && node.append(c));
    return node;
  }

  /* ---------- Antworten (immer neue Objekte, keine Mutation) ---------- */
  function setAnswer(field, value) {
    const next = { ...answers, [field]: value };
    if (field === 'apps' && !value.includes('komoot')) delete next.komoot_usage;
    answers = next;
  }

  function toggleMulti(step, value) {
    const current = answers[step.field] || [];
    if (current.includes(value)) return current.filter((v) => v !== value);
    if (value === step.exclusive) return [value];
    const without = current.filter((v) => v !== step.exclusive);
    return step.max && without.length >= step.max ? without : [...without, value];
  }

  /* ---------- Rendering eines Schritts ---------- */
  function optionTile(step, value, label) {
    const isMulti = step.type === 'multi';
    const chosen = isMulti ? (answers[step.field] || []).includes(value) : answers[step.field] === value;
    const input = el('input', {
      type: isMulti ? 'checkbox' : 'radio', name: step.field, value: String(value), checked: chosen,
      onchange: () => onPick(step, value),
    });
    return el('label', { class: 'opt' + (chosen ? ' is-on' : '') }, [input, el('span', { text: label })]);
  }

  function navRow(step, isFirst) {
    const canNext = step.type === 'multi' ? (answers[step.field] || []).length > 0 : answers[step.field] != null;
    const back = isFirst ? el('span') : el('button', { type: 'button', class: 'btn-ghost', text: '← Zurück', onclick: goBack });
    const next = step.type === 'final'
      ? el('button', { type: 'submit', class: 'btn btn-solid', text: 'Antworten absenden' })
      : el('button', { type: 'button', class: 'btn btn-solid', text: 'Weiter →', disabled: !canNext, onclick: goNext });
    return el('div', { class: 'step-nav' }, [back, next]);
  }

  function finalFields() {
    const select = (name, opts, label) => el('label', { class: 'field' }, [
      el('span', { text: label }),
      el('select', { name, onchange: (e) => setAnswer(name, e.target.value || null) },
        opts.map(([v, t]) => el('option', { value: v, text: t, selected: (answers[name] || '') === v }))),
    ]);
    const text = el('textarea', {
      name: 'pain_point', rows: '3', maxlength: String(MAX_TEXT),
      placeholder: 'Was nervt dich an deiner jetzigen Tourenplanung? (freiwillig)',
      oninput: (e) => setAnswer('pain_point', e.target.value.trim() || null),
    });
    text.value = answers.pain_point || '';
    const trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'hp', 'aria-hidden': 'true' });
    const consent = el('p', { class: 'consent' }, [
      'Anonym: Wir speichern keine Namen, E-Mail-Adressen oder IP-Adressen in der Umfrage. Mit dem Absenden stimmst du zu, dass wir deine Antworten für unser Projekt auswerten. ',
      el('a', { href: 'rechtliches.html#datenschutz', text: 'Datenschutz' }), '.',
    ]);
    return el('div', { class: 'final-fields' }, [text, el('div', { class: 'field-row' }, [
      select('age_group', AGE, 'Alter'), select('country', COUNTRY, 'Land')]), trap, consent]);
  }

  function renderStep() {
    const steps = visibleSteps();
    const step = steps[pos];
    const legend = el('legend', { class: 'q', tabindex: '-1', text: textOf(step.title) });
    const body = step.type === 'final'
      ? finalFields()
      : el('div', { class: 'opts opts-' + step.type }, step.options.map(([v, t]) => optionTile(step, v, t)));
    const fieldset = el('fieldset', {}, [legend, step.hint ? el('p', { class: 'hint', text: textOf(step.hint) }) : null, body]);
    $('[data-step]').replaceChildren(fieldset, navRow(step, pos === 0));
    $('[data-progress-text]').textContent = `Frage ${pos + 1} von ${steps.length}`;
    $('[data-progress-bar]').style.width = pct(pos + 1, steps.length) + '%';
    if (userNavigated) legend.focus({ preventScroll: true });
  }

  /* ---------- Navigation ---------- */
  function onPick(step, value) {
    if (!startedAt) startedAt = Date.now();
    userNavigated = true;
    setAnswer(step.field, step.type === 'multi' ? toggleMulti(step, value) : value);
    renderStep();
    if (step.type !== 'multi') setTimeout(() => { if (answers[step.field] === value) goNext(); }, AUTO_ADVANCE_MS);
  }

  function goNext() {
    const steps = visibleSteps();
    if (pos < steps.length - 1) { pos += 1; userNavigated = true; renderStep(); keepInView(); }
  }

  function goBack() {
    if (pos > 0) { pos -= 1; userNavigated = true; renderStep(); keepInView(); }
  }

  function keepInView() {
    const box = $('[data-survey]');
    if (box && box.getBoundingClientRect().top < 0) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- Absenden ---------- */
  function sourceParam() {
    const q = new URLSearchParams(location.search);
    const src = q.get('src') || q.get('utm_source');
    return src && SRC_PATTERN.test(src) ? src : null;
  }

  function buildPayload() {
    const a = answers;
    return {
      hikes_per_year: a.hikes_per_year, hut_tours: a.hut_tours, apps: a.apps,
      komoot_usage: usesKomoot(a) ? a.komoot_usage : null,
      switch_likelihood: a.switch_likelihood, reasons: a.reasons || [], barriers: a.barriers || [],
      pain_point: a.pain_point ? a.pain_point.slice(0, MAX_TEXT) : null,
      age_group: a.age_group || null, country: a.country || null, src: sourceParam(),
    };
  }

  function missingStep() {
    return visibleSteps().findIndex((s) => s.type !== 'final' &&
      (s.type === 'multi' ? !(answers[s.field] || []).length : answers[s.field] == null));
  }

  async function postAnswers(payload) {
    const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/switch_survey`, {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(res.status === 429 ? 'rate' : 'HTTP ' + res.status);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (visibleSteps()[pos].type !== 'final') return goNext();
    const missing = missingStep();
    if (missing >= 0) { pos = missing; renderStep(); return showError('Diese Frage fehlt noch.'); }
    const form = e.currentTarget;
    const trap = form.elements.website;
    const isBot = (trap && trap.value !== '') || Date.now() - startedAt < MIN_FILL_MS;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    button.textContent = 'Sende …';
    try {
      if (!isBot) await postAnswers(buildPayload());
      try { localStorage.setItem(DONE_KEY, '1'); } catch (_) { /* privater Modus: egal */ }
      showThanks();
      loadStats();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Antworten absenden';
      showError(err.message === 'rate'
        ? 'Gerade kommen sehr viele Antworten an. Bitte versuch es in ein paar Minuten nochmal.'
        : 'Das Senden hat nicht geklappt. Deine Antworten sind noch da, bitte versuch es nochmal.');
    }
  }

  function showError(msg) {
    const box = $('[data-survey-error]');
    box.textContent = msg;
    box.hidden = !msg;
  }

  /* ---------- Danke-Ansicht ---------- */
  async function share() {
    const url = location.origin + location.pathname + '#umfrage';
    const data = { title: 'GipfelPfad', text: 'Würdest du von deiner Wander-App zu GipfelPfad wechseln? 2-Minuten-Umfrage:', url };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(url); $('[data-share]').textContent = 'Link kopiert ✓'; }
    } catch (_) { /* Teilen abgebrochen */ }
  }

  function restart() {
    try { localStorage.removeItem(DONE_KEY); } catch (_) { /* egal */ }
    answers = {}; pos = 0; startedAt = 0; userNavigated = true;
    showForm();
  }

  function showThanks() {
    showError('');
    $('[data-survey-form]').hidden = true;
    $('[data-progress]').hidden = true;
    $('[data-thanks]').replaceChildren(
      el('p', { class: 'thanks-kicker', text: 'Gespeichert' }),
      el('h3', { text: 'Danke, das hilft uns wirklich.' }),
      el('p', { text: 'Je mehr Wandernde mitmachen, desto belastbarer wird das Ergebnis. Schick die Umfrage gern an deine Wandergruppe weiter.' }),
      el('div', { class: 'thanks-actions' }, [
        el('button', { type: 'button', class: 'btn btn-solid', 'data-share': true, text: 'Umfrage teilen', onclick: share }),
        el('button', { type: 'button', class: 'btn-ghost', text: 'Weitere Antwort abgeben', onclick: restart }),
      ]));
    $('[data-thanks]').hidden = false;
  }

  function showForm() {
    $('[data-thanks]').hidden = true;
    $('[data-survey-form]').hidden = false;
    $('[data-progress]').hidden = false;
    renderStep();
  }

  /* ---------- Zwischenstand ---------- */
  function statBlock(value, label, sub) {
    return el('div', { class: 'stat' }, [el('b', { text: value }), el('span', { text: label }), sub ? el('small', { text: sub }) : null]);
  }

  function renderStats(s) {
    const box = $('[data-results]');
    if (!box) return;
    const n = Number(s.total) || 0;
    if (n < MIN_SAMPLE) {
      box.replaceChildren(el('p', { class: 'results-empty',
        text: `Bisher ${n} ${n === 1 ? 'Antwort' : 'Antworten'}. Den Zwischenstand zeigen wir ab ${MIN_SAMPLE} Antworten, vorher wäre er Zufall.` }));
      return;
    }
    const k = Number(s.komoot) || 0;
    const komootStat = k >= MIN_SAMPLE
      ? statBlock(pct(s.komoot_likely, k) + ' %', 'der komoot-Nutzenden würden (eher) wechseln', `davon „sehr wahrscheinlich“: ${pct(s.komoot_sure, k)} %`)
      : statBlock(String(k), 'komoot-Nutzende bisher', `Prozentwert ab ${MIN_SAMPLE}`);
    const reasons = (s.top_reasons || []).map((r) => el('li', {}, [el('span', { text: REASON_LABEL[r.key] || r.key }), el('b', { text: pct(r.n, n) + ' %' })]));
    box.replaceChildren(
      el('div', { class: 'stats' }, [
        komootStat,
        statBlock(pct(s.all_likely, n) + ' %', 'aller Befragten würden GipfelPfad (eher) nutzen', `davon „sehr wahrscheinlich“: ${pct(s.all_sure, n)} %`),
        statBlock(String(n), 'Antworten bisher', `davon ${k} mit komoot`),
      ]),
      reasons.length ? el('div', { class: 'top-reasons' }, [el('p', { text: 'Was am meisten überzeugt' }), el('ol', {}, reasons)]) : null,
      el('p', { class: 'results-note', text: 'Live aus dieser Umfrage. Nicht repräsentativ: Hier antwortet, wer die Seite findet.' }));
  }

  async function loadStats() {
    if (!hasConfig()) return;
    try {
      const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/rpc/switch_survey_stats`, {
        method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: '{}',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      renderStats(await res.json());
    } catch (_) {
      const box = $('[data-results]');
      if (box) box.replaceChildren(el('p', { class: 'results-empty', text: 'Der Zwischenstand ist gerade nicht erreichbar.' }));
    }
  }

  /* ---------- Start ---------- */
  function init() {
    const form = $('[data-survey-form]');
    if (!form) return;
    form.addEventListener('submit', onSubmit);
    let done = false;
    try { done = localStorage.getItem(DONE_KEY) === '1'; } catch (_) { /* egal */ }
    if (done) showThanks(); else showForm();
    if (!hasConfig()) showError('Die Umfrage ist noch nicht verbunden (config.js fehlt).');
    loadStats();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
