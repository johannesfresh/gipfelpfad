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
  const CLIMB = { start: 800, summit: 2600 };   // Höhenmeter für die Aufstiegs-Anzeige
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const EN = window.GP_SURVEY_EN || {};

  // Sprache kommt von der Seite (<html lang>); Texte sind deutsch, englisch über umfrage-en.js
  const isEn = () => document.documentElement.lang === 'en';
  function T(key, vars) {
    const s = (isEn() && EN[key]) || key;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k])) : s;
  }

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
    { field: 'final', type: 'final', title: 'Fast oben! Trag dich ins Gipfelbuch ein.',
      hint: 'Alles auf dieser letzten Etappe ist freiwillig.' },
  ];

  const AGE = [['', 'Keine Angabe'], ['u25', 'Unter 25'], ['25-39', '25 bis 39'], ['40-59', '40 bis 59'], ['60+', '60 oder älter']];
  const COUNTRY = [['', 'Keine Angabe'], ['de', 'Deutschland'], ['at', 'Österreich'], ['ch', 'Schweiz'], ['it', 'Italien'], ['andere', 'Anderes Land']];
  const REASON_LABEL = Object.fromEntries(STEPS.find((s) => s.field === 'reasons').options);

  const MAX_EMAIL = 254;
  const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  let answers = {};
  let contact = { wants: false, email: '' };   // nie Teil der Umfrage-Antworten
  let thanksNote = null;                        // 'mail-ok' | 'mail-fail' | null
  let pos = 0;
  let startedAt = 0;
  let userNavigated = false;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const visibleSteps = () => STEPS.filter((s) => !s.showIf || s.showIf(answers));
  const textOf = (v) => T(typeof v === 'function' ? v(answers) : v);
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

  const locale = () => (isEn() ? 'en-GB' : 'de-DE');
  const fmt = (n) => n.toLocaleString(locale());

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }

  /* ---------- Aufstieg: Höhenprofil statt Fortschrittsbalken ---------- */
  function renderClimb(index, total, isSummit) {
    const box = $('[data-climb]');
    const path = $('[data-climb-path]');
    if (!box || !path) return;
    const t = isSummit ? 1 : index / total;
    const len = path.getTotalLength();
    const at = (f) => path.getPointAtLength(len * f);
    const here = at(t);
    path.style.strokeDashoffset = String(100 - t * 100);
    $('[data-climb-hiker]').style.transform = `translate(${here.x}px, ${here.y}px)`;
    $('[data-climb-points]').replaceChildren(...Array.from({ length: total }, (_, i) => {
      const p = at(i / total);
      const done = isSummit || i < index;
      return svgEl('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: '3.5', class: 'climb-pt' + (done ? ' done' : '') });
    }));
    const alt = Math.round((CLIMB.start + t * (CLIMB.summit - CLIMB.start)) / 10) * 10;
    box.classList.toggle('is-summit', isSummit);
    $('[data-progress-text]').textContent = isSummit
      ? T('Gipfel erreicht · {alt} m', { alt: fmt(alt) })
      : T('Etappe {i} von {n} · {alt} m', { i: index + 1, n: total, alt: fmt(alt) });
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
    return el('label', { class: 'opt' + (chosen ? ' is-on' : '') }, [input, el('span', { text: T(label) })]);
  }

  function navRow(step, isFirst) {
    const canNext = step.type === 'multi' ? (answers[step.field] || []).length > 0 : answers[step.field] != null;
    const back = isFirst ? el('span') : el('button', { type: 'button', class: 'btn-ghost', text: T('← Zurück'), onclick: goBack });
    const next = step.type === 'final'
      ? el('button', { type: 'submit', class: 'btn btn-solid', text: T('Antworten absenden') })
      : el('button', { type: 'button', class: 'btn btn-solid', text: T('Weiter →'), disabled: !canNext, onclick: goNext });
    return el('div', { class: 'step-nav' }, [back, next]);
  }

  function finalFields() {
    const select = (name, opts, label) => el('label', { class: 'field' }, [
      el('span', { text: T(label) }),
      el('select', { name, onchange: (e) => setAnswer(name, e.target.value || null) },
        opts.map(([v, t]) => el('option', { value: v, text: T(t), selected: (answers[name] || '') === v }))),
    ]);
    const text = el('textarea', {
      id: 'gp-book', name: 'pain_point', class: 'book-text', rows: '4', maxlength: String(MAX_TEXT),
      placeholder: T('Schreib einfach drauflos …'),
      oninput: (e) => setAnswer('pain_point', e.target.value.trim() || null),
    });
    text.value = answers.pain_point || '';
    const book = el('div', { class: 'book' }, [
      el('div', { class: 'book-head' }, [
        el('span', { class: 'book-title', text: T('Gipfelbuch') }),
        el('span', { class: 'book-date', text: `${new Date().toLocaleDateString(locale())} · ${fmt(CLIMB.summit)} m` }),
      ]),
      el('label', { class: 'book-label', for: 'gp-book', text: T('Was nervt dich an deiner jetzigen Tourenplanung? Oder was wünschst du dir?') }),
      text,
    ]);
    const trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'hp', 'aria-hidden': 'true' });
    const consent = el('p', { class: 'consent' }, [
      T('Deine Antworten sind anonym: Wir speichern dazu keine Namen, E-Mail-Adressen oder IP-Adressen. Mit dem Absenden stimmst du zu, dass wir deine Antworten für unser Projekt auswerten. '),
      el('a', { href: 'rechtliches.html#datenschutz', text: T('Datenschutz') }), '.',
    ]);
    return el('div', { class: 'final-fields' }, [book, el('div', { class: 'field-row' }, [
      select('age_group', AGE, 'Alter'), select('country', COUNTRY, 'Land')]), contactBox(), trap, consent]);
  }

  /* ---------- Freiwillige E-Mail für Updates (getrennt von den Antworten gespeichert) ---------- */
  function contactBox() {
    const email = el('input', {
      type: 'email', name: 'email', class: 'contact-email', autocomplete: 'email', inputmode: 'email',
      maxlength: String(MAX_EMAIL), placeholder: T('deine@email.de'), hidden: !contact.wants,
      'aria-label': T('E-Mail-Adresse'),
      oninput: (e) => { contact = { ...contact, email: e.target.value.trim() }; },
    });
    email.value = contact.email;
    const check = el('input', {
      type: 'checkbox', name: 'wants_updates', checked: contact.wants,
      onchange: (e) => {
        contact = { ...contact, wants: e.target.checked };
        email.hidden = !e.target.checked;
        if (e.target.checked) email.focus();
      },
    });
    return el('div', { class: 'contact' }, [
      el('label', { class: 'contact-opt' }, [check, el('span', {}, [
        el('b', { text: T('Halt mich auf dem Laufenden') }),
        el('small', { text: T('Freiwillig: Wir schreiben dir, wenn es Neuigkeiten zu GipfelPfad gibt. Deine E-Mail speichern wir getrennt von deinen Antworten, abmelden kannst du dich jederzeit.') }),
      ])]),
      email,
    ]);
  }

  const isValidEmail = (s) => s.length <= MAX_EMAIL && EMAIL_PATTERN.test(s);

  async function postNewsletter(email) {
    try {
      // Bewusst ein einfacher Insert: „Duplikate ignorieren“ (on_conflict) bräuchte Leserechte,
      // die Tabelle ist aber per RLS absichtlich nicht lesbar.
      const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/newsletter_signup`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body: JSON.stringify({ email: email.toLowerCase(), lang: isEn() ? 'en' : 'de' }),
      });
      return res.ok || res.status === 409;   // 409 = Adresse ist schon in der Liste → auch gut
    } catch (_) {
      return false;
    }
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
    renderClimb(pos, steps.length, false);
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
    if (missing >= 0) { pos = missing; renderStep(); return showError(T('Diese Frage fehlt noch.')); }
    const wantsMail = contact.wants && contact.email !== '';
    if (contact.wants && !isValidEmail(contact.email)) {
      return showError(T('Bitte gib eine gültige E-Mail-Adresse ein oder nimm den Haken raus.'));
    }
    const form = e.currentTarget;
    const trap = form.elements.website;
    const isBot = (trap && trap.value !== '') || Date.now() - startedAt < MIN_FILL_MS;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    button.textContent = T('Sende …');
    try {
      if (!isBot) await postAnswers(buildPayload());
      if (!isBot && wantsMail) thanksNote = (await postNewsletter(contact.email)) ? 'mail-ok' : 'mail-fail';
      try { localStorage.setItem(DONE_KEY, '1'); } catch (_) { /* privater Modus: egal */ }
      showThanks();
      loadStats();
    } catch (err) {
      button.disabled = false;
      button.textContent = T('Antworten absenden');
      showError(T(err.message === 'rate'
        ? 'Gerade kommen sehr viele Antworten an. Bitte versuch es in ein paar Minuten nochmal.'
        : 'Das Senden hat nicht geklappt. Deine Antworten sind noch da, bitte versuch es nochmal.'));
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
    const data = { title: 'GipfelPfad', text: T('Würdest du von deiner Wander-App zu GipfelPfad wechseln? 2-Minuten-Umfrage:'), url };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(url); $('[data-share]').textContent = T('Link kopiert ✓'); }
    } catch (_) { /* Teilen abgebrochen */ }
  }

  function restart() {
    try { localStorage.removeItem(DONE_KEY); } catch (_) { /* egal */ }
    answers = {}; pos = 0; startedAt = 0; userNavigated = true;
    contact = { wants: false, email: '' }; thanksNote = null;
    showForm();
  }

  function thanksNoteEl() {
    if (thanksNote === 'mail-ok') return el('p', { class: 'thanks-note', text: T('Du stehst auf unserer Liste. Wir melden uns per E-Mail, sobald es Neuigkeiten gibt.') });
    if (thanksNote === 'mail-fail') return el('p', { class: 'thanks-note is-warn', text: T('Deine Antworten sind gespeichert, deine E-Mail-Adresse leider nicht. Schreib uns gern direkt, die Adresse steht im Datenschutz.') });
    return null;
  }

  function showThanks() {
    showError('');
    $('[data-survey-form]').hidden = true;
    renderClimb(0, visibleSteps().length, true);
    $('[data-thanks]').replaceChildren(
      el('p', { class: 'thanks-kicker', text: T('{alt} m · Gipfelkreuz', { alt: fmt(CLIMB.summit) }) }),
      el('h3', { text: T('Gipfel erreicht! Danke dir.') }),
      el('p', { text: T('Je mehr Wandernde mitmachen, desto belastbarer wird das Ergebnis. Schick die Umfrage gern an deine Wandergruppe weiter.') }),
      thanksNoteEl(),
      el('div', { class: 'thanks-actions' }, [
        el('button', { type: 'button', class: 'btn btn-solid', 'data-share': true, text: T('Umfrage teilen'), onclick: share }),
        el('button', { type: 'button', class: 'btn-ghost', text: T('Weitere Antwort abgeben'), onclick: restart }),
      ]));
    $('[data-thanks]').hidden = false;
  }

  function showForm() {
    $('[data-thanks]').hidden = true;
    $('[data-survey-form]').hidden = false;
    renderStep();
  }

  /* ---------- Zwischenstand ---------- */
  function statBlock(value, label, sub) {
    return el('div', { class: 'stat' }, [el('b', { text: value }), el('span', { text: label }), sub ? el('small', { text: sub }) : null]);
  }

  let lastStats = null;

  function renderStats(s) {
    const box = $('[data-results]');
    if (!box) return;
    lastStats = s;
    const n = Number(s.total) || 0;
    if (n < MIN_SAMPLE) {
      const key = n === 1
        ? 'Bisher {n} Antwort. Den Zwischenstand zeigen wir ab {min} Antworten, vorher wäre er Zufall.'
        : 'Bisher {n} Antworten. Den Zwischenstand zeigen wir ab {min} Antworten, vorher wäre er Zufall.';
      box.replaceChildren(el('p', { class: 'results-empty', text: T(key, { n, min: MIN_SAMPLE }) }));
      return;
    }
    const k = Number(s.komoot) || 0;
    const komootStat = k >= MIN_SAMPLE
      ? statBlock(pct(s.komoot_likely, k) + ' %', T('der komoot-Nutzenden würden (eher) wechseln'), T('davon „sehr wahrscheinlich“: {p} %', { p: pct(s.komoot_sure, k) }))
      : statBlock(String(k), T('komoot-Nutzende bisher'), T('Prozentwert ab {min}', { min: MIN_SAMPLE }));
    const reasons = (s.top_reasons || []).map((r) => el('li', {}, [el('span', { text: T(REASON_LABEL[r.key] || r.key) }), el('b', { text: pct(r.n, n) + ' %' })]));
    box.replaceChildren(
      el('div', { class: 'stats' }, [
        komootStat,
        statBlock(pct(s.all_likely, n) + ' %', T('aller Befragten würden GipfelPfad (eher) nutzen'), T('davon „sehr wahrscheinlich“: {p} %', { p: pct(s.all_sure, n) })),
        statBlock(String(n), T('Antworten bisher'), T('davon {k} mit komoot', { k })),
      ]),
      reasons.length ? el('div', { class: 'top-reasons' }, [el('p', { text: T('Was am meisten überzeugt') }), el('ol', {}, reasons)]) : null,
      el('p', { class: 'results-note', text: T('Live aus dieser Umfrage. Nicht repräsentativ: Hier antwortet, wer die Seite findet.') }));
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
      if (box) box.replaceChildren(el('p', { class: 'results-empty', text: T('Der Zwischenstand ist gerade nicht erreichbar.') }));
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
    if (!hasConfig()) showError(T('Die Umfrage ist noch nicht verbunden (config.js fehlt).'));
    loadStats();
    document.addEventListener('gp:lang', onLangChange);
  }

  // Sprachwechsel: aktuelle Ansicht neu zeichnen, ohne Antworten oder Fokus zu verlieren
  function onLangChange() {
    showError('');
    const keepFocus = userNavigated;
    userNavigated = false;
    if ($('[data-thanks]').hidden) renderStep(); else showThanks();
    userNavigated = keepFocus;
    if (lastStats) renderStats(lastStats);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
