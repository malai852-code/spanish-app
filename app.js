// ============================================================
// app.js — Español Studio
//
// SETUP: Replace WORKER_URL with your Cloudflare Worker URL
// ============================================================

const WORKER_URL = 'https://spanish-app-proxy.marshall-lai.workers.dev';

// ============================================================
// ACCENT BAR
// ============================================================
const ACCENTS = ['á','é','í','ó','ú','ü','ñ','¿','¡','Á','É','Í','Ó','Ú','Ñ'];

function buildAccentBar(barId, targetId) {
  const bar = document.getElementById(barId);
  if (!bar) return;
  bar.innerHTML = ACCENTS.map(ch =>
    '<button class="accent-key" type="button" onclick="insertAccent(\'' + targetId + '\',\'' + ch + '\')">' + ch + '</button>'
  ).join('');
}

function insertAccent(targetId, ch) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const s = el.selectionStart, e = el.selectionEnd;
  el.value = el.value.slice(0, s) + ch + el.value.slice(e);
  el.selectionStart = el.selectionEnd = s + ch.length;
  el.focus();
}

// Stores {el, start, end} — updated on every input interaction
// This survives focus changes completely since it's stored by reference + index
let savedConjCursor = null;

function buildConjAccentBar() {
  const bar = document.getElementById('conj-accent-bar');
  if (!bar) return;
  bar.innerHTML = '';
  ACCENTS.forEach(ch => {
    const btn = document.createElement('button');
    btn.className   = 'inline-accent-key';
    btn.type        = 'button';
    btn.textContent = ch;
    btn.addEventListener('mousedown',   e => e.preventDefault());
    btn.addEventListener('pointerdown', e => e.preventDefault());
    btn.addEventListener('click', () => insertIntoFocusedConj(ch));
    bar.appendChild(btn);
  });
}

// Call this after every loadVerb() to attach cursor-save listeners to the new inputs
function attachConjCursorTracking() {
  savedConjCursor = null;
  PRONOUNS.forEach((p, i) => {
    const inp = document.getElementById('ci-' + i);
    if (!inp) return;
    const save = () => {
      savedConjCursor = { el: inp, start: inp.selectionStart, end: inp.selectionEnd };
    };
    inp.addEventListener('focus',   save);
    inp.addEventListener('click',   save);
    inp.addEventListener('keyup',   save);
    inp.addEventListener('keydown', save);
    inp.addEventListener('select',  save);
  });
}

function insertIntoFocusedConj(ch) {
  // First preference: document.activeElement still has the input (mousedown preventDefault worked)
  let el    = null;
  let start = 0;
  let end   = 0;

  if (document.activeElement && document.activeElement.classList.contains('conj-input')) {
    el    = document.activeElement;
    start = el.selectionStart;
    end   = el.selectionEnd;
  } else if (savedConjCursor && savedConjCursor.el && document.contains(savedConjCursor.el)) {
    // Fall back to the last saved cursor position
    el    = savedConjCursor.el;
    start = savedConjCursor.start;
    end   = savedConjCursor.end;
  } else {
    return; // Nothing to insert into
  }

  el.value = el.value.slice(0, start) + ch + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + ch.length;
  el.focus();
  // Update saved cursor after insert
  savedConjCursor = { el, start: start + ch.length, end: start + ch.length };
}

// ============================================================
// INIT — runs as soon as the DOM is ready
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  buildAccentBar('setup-accent-bar', 'custom-vocab-input');
  loadSavedState();
});

// ============================================================
// STATE
// ============================================================
let userName = '', dailyMinutes = 20, selectedTopics = [], customWords = [], activeVocab = [];
let planActivities = [], completedActivities = new Set();
let xp = 0, streak = 1, quizCorrect = 0, quizTotal = 0, learnedSet = new Set();
let fcIdx = 0, fcCat = 'All', fcFlipped = false;
let quizReverse = false, currentQuizItem = null;
let verbIdx = 0, tense = 'pres';
let recognition = null, isRecording = false;
let currentActivity = null;
let timerInterval = null, timerSeconds = 0, timerMax = 0;

// AI content queues — pre-fetched batches so there's no wait between questions
let aiQuizQueue   = [];  // [{type, question, correct, distractors, vocab_es}]
let aiListenQueue = [];  // [{es, question, answer, hint}]
let aiSpeakQueue  = [];  // [{en, es, hint}]
let currentListenItem = null;
let currentSpeakItem  = null;

// Prevent duplicate in-flight fetches
let fetchingQuiz   = false;
let fetchingListen = false;
let fetchingSpeak  = false;

// Performance tracking
let perfData = {
  vocab:  {},  // category -> {correct, total}
  verbs:  {},  // verbInf  -> {correct, total}
  listen: { correct: 0, total: 0 },
  speak:  { correct: 0, total: 0 },
};

const PRONOUNS  = ['yo', 'tú', 'él/ella', 'nosotros', 'vosotros', 'ellos'];
const P_KEYS    = ['yo', 'tú', 'él', 'nosotros', 'vosotros', 'ellos'];
const TENSES    = ['pres', 'pret', 'fut'];
const TENSE_LBL = { pres: 'Present', pret: 'Preterite (past)', fut: 'Future' };

const ACTIVITY_DEFS = [
  { id: 'flashcards',  label: 'Vocabulary Flashcards',   icon: '🃏', desc: 'Build your word bank — tap to flip!' },
  { id: 'quiz',        label: 'Multiple Choice Quiz',    icon: '✏️', desc: 'AI-generated questions from your vocab' },
  { id: 'conjugation', label: 'Verb Conjugation Drill',  icon: '🔄', desc: 'Fill in all six forms — key to fluency' },
  { id: 'listen',      label: 'Listening Comprehension', icon: '👂', desc: 'AI-generated phrases targeting your weak spots' },
  { id: 'speak',       label: 'Speaking Practice',       icon: '🎤', desc: 'AI-generated sentences to say aloud' },
];

// ============================================================
// PERSIST STATE
// ============================================================
function saveState() {
  try {
    localStorage.setItem('espanol_v3', JSON.stringify({
      userName, dailyMinutes, selectedTopics, customWords,
      xp, streak, quizCorrect, quizTotal,
      learnedSet: [...learnedSet], perfData,
    }));
  } catch (e) {}
}

function resetApp() {
  // confirm() is blocked in sandboxed iframes (GitHub Pages etc.)
  // Use inline confirmation instead
  const card = document.getElementById('reset-confirm-card');
  if (card) card.style.display = 'block';
}

function resetAppConfirmed() {
  const card = document.getElementById('reset-confirm-card');
  if (card) card.style.display = 'none';

  // Wipe localStorage then reload the page — this is the only guaranteed
  // way to clear all JS state, DOM values, and cached variables at once
  try { localStorage.removeItem('espanol_v3'); } catch (e) {}
  location.reload();
}

function resetAppCancel() {
  const card = document.getElementById('reset-confirm-card');
  if (card) card.style.display = 'none';
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem('espanol_v3');
    if (!raw) return;
    const s = JSON.parse(raw);
    userName       = s.userName       || '';
    dailyMinutes   = s.dailyMinutes   || 20;
    selectedTopics = s.selectedTopics || [];
    customWords    = s.customWords    || [];
    xp             = s.xp             || 0;
    streak         = s.streak         || 1;
    quizCorrect    = s.quizCorrect    || 0;
    quizTotal      = s.quizTotal      || 0;
    learnedSet     = new Set(s.learnedSet || []);
    perfData       = s.perfData       || perfData;

    if (userName) document.getElementById('setup-name').value = userName;
    document.querySelectorAll('.topic-chip').forEach(c => {
      c.classList.toggle('sel', selectedTopics.includes(c.dataset.topic));
    });
    document.querySelectorAll('.time-opt').forEach(o => {
      o.classList.toggle('sel', parseInt(o.dataset.mins) === dailyMinutes);
    });
    renderVocabTags();

    if (userName && selectedTopics.length) {
      buildActiveVocab();
      buildDailyPlan();
      renderPlan();
      goPage('plan');
    }
  } catch (e) {}
}

// ============================================================
// WEAKNESS ANALYSIS
// ============================================================
function getWeaknesses() {
  const weak = [], strong = [];
  Object.entries(perfData.vocab).forEach(([cat, d]) => {
    if (d.total >= 3) {
      const r = d.correct / d.total;
      if (r < 0.6)  weak.push({ label: cat, rate: r });
      if (r >= 0.8) strong.push({ label: cat, rate: r });
    }
  });
  Object.entries(perfData.verbs).forEach(([verb, d]) => {
    if (d.total >= 2 && d.correct / d.total < 0.5)
      weak.push({ label: verb, rate: d.correct / d.total });
  });
  if (perfData.listen.total >= 3 && perfData.listen.correct / perfData.listen.total < 0.55)
    weak.push({ label: 'Listening', rate: perfData.listen.correct / perfData.listen.total });
  if (perfData.speak.total >= 3 && perfData.speak.correct / perfData.speak.total < 0.55)
    weak.push({ label: 'Speaking', rate: perfData.speak.correct / perfData.speak.total });
  weak.sort((a, b) => a.rate - b.rate);
  return { weak: weak.slice(0, 4), strong: strong.slice(0, 3) };
}

function recordVocabPerf(cat, correct) {
  if (!perfData.vocab[cat]) perfData.vocab[cat] = { correct: 0, total: 0 };
  perfData.vocab[cat].total++;
  if (correct) perfData.vocab[cat].correct++;
  saveState();
}

function recordVerbPerf(inf, correct) {
  if (!perfData.verbs[inf]) perfData.verbs[inf] = { correct: 0, total: 0 };
  perfData.verbs[inf].total++;
  if (correct) perfData.verbs[inf].correct++;
  saveState();
}

function recordListenPerf(c) { perfData.listen.total++; if (c) perfData.listen.correct++; saveState(); }
function recordSpeakPerf(c)  { perfData.speak.total++;  if (c) perfData.speak.correct++;  saveState(); }

function updateWeaknessUI() {
  const { weak, strong } = getWeaknesses();
  const card = document.getElementById('weakness-card');
  if (!weak.length && !strong.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  document.getElementById('weakness-text').textContent =
    weak.length ? 'AI has spotted areas to focus on — your plan is adjusted!' : 'Great progress! Keep it up!';
  document.getElementById('weakness-chips').innerHTML =
    weak.map(w => '<span class="weakness-chip">⚠ ' + w.label + '</span>').join('') +
    strong.map(s => '<span class="strength-chip">✓ ' + s.label + '</span>').join('');
}

// ============================================================
// AI CALLS (via Cloudflare Worker)
// ============================================================
async function workerCall(system, prompt, maxTokens) {
  const resp = await fetch(WORKER_URL + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, prompt, max_tokens: maxTokens || 600 }),
  });
  if (!resp.ok) throw new Error('Worker error ' + resp.status);
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return data.text || '';
}

function parseJSON(text) {
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// Build a context string describing the student's current state for AI prompts
function buildContext() {
  const { weak } = getWeaknesses();
  const vocabSample = activeVocab.slice(0, 30).map(v => v.es + ' = ' + v.en).join(', ');
  const weakStr = weak.length
    ? 'Student weak areas: ' + weak.map(w => w.label).join(', ') + '.'
    : 'No weak areas identified yet.';
  return 'Topics: ' + selectedTopics.join(', ') + '. ' + weakStr + ' Vocabulary in rotation: ' + vocabSample + '.';
}

// ---- Fetch a batch of AI quiz questions ----
async function fetchAIQuizBatch() {
  if (fetchingQuiz || activeVocab.length < 4) return;
  fetchingQuiz = true;

  const { weak } = getWeaknesses();
  const weakCats = weak.map(w => w.label);
  let pool = activeVocab;
  if (weakCats.length) {
    const wp = activeVocab.filter(v => weakCats.includes(v.cat));
    if (wp.length >= 4) pool = wp;
  }
  const sample = pool.slice(0, 20).map(v => v.es + ' = ' + v.en).join('\n');

  const system = 'You are a Spanish teacher for 8th grade. Respond ONLY with valid JSON array. No markdown, no explanation, no code fences.';
  const prompt = buildContext() +
    '\n\nGenerate 5 multiple-choice Spanish quiz questions using ONLY vocabulary from this list:\n' + sample +
    '\n\nMix these question types:\n' +
    '- "translate_es": show a Spanish word, student picks the English meaning\n' +
    '- "translate_en": show an English word, student picks the Spanish translation\n' +
    '- "fill_blank": show a Spanish sentence with one word replaced by ___, student picks the missing word\n' +
    '\nReturn a JSON array of exactly 5 objects with these fields:\n' +
    '{"type":"translate_es","question":"la tarea","correct":"homework","distractors":["teacher","library","pencil"],"vocab_es":"la tarea"}\n' +
    'Distractors must be plausible but wrong. Use only words from the list above.';

  try {
    const text = await workerCall(system, prompt, 1000);
    const items = parseJSON(text);
    if (Array.isArray(items)) {
      aiQuizQueue.push(...items.filter(q => q.question && q.correct && Array.isArray(q.distractors)));
    }
  } catch (e) {
    console.warn('AI quiz fetch failed:', e.message);
  }
  fetchingQuiz = false;
}

// ---- Fetch a batch of AI listening phrases ----
async function fetchAIListenBatch() {
  if (fetchingListen) return;
  fetchingListen = true;

  const system = 'You are a Spanish teacher for 8th grade. Respond ONLY with valid JSON array. No markdown, no explanation, no code fences.';
  const prompt = buildContext() +
    '\n\nGenerate 4 listening comprehension exercises for an 8th grade Spanish student. ' +
    'Each should be a natural Spanish sentence the student needs to listen to and understand. ' +
    'Focus heavily on weak areas if listed. Vary difficulty — some simple, some slightly complex with connectors like "pero", "porque", "antes de".' +
    '\n\nReturn a JSON array of exactly 4 objects:\n' +
    '{"es":"Tengo que hacer mi tarea antes de cenar.","question":"What must the speaker do before dinner?","answer":"homework","hint":"tarea = homework, antes de = before"}';

  try {
    const text = await workerCall(system, prompt, 900);
    const items = parseJSON(text);
    if (Array.isArray(items)) {
      aiListenQueue.push(...items.filter(i => i.es && i.question && i.answer));
    }
  } catch (e) {
    console.warn('AI listen fetch failed:', e.message);
    aiListenQueue.push(...LISTENING_BANK.slice(0, 4));
  }
  fetchingListen = false;
}

// ---- Fetch a batch of AI speaking phrases ----
async function fetchAISpeakBatch() {
  if (fetchingSpeak) return;
  fetchingSpeak = true;

  const system = 'You are a Spanish teacher for 8th grade. Respond ONLY with valid JSON array. No markdown, no explanation, no code fences.';
  const prompt = buildContext() +
    '\n\nGenerate 4 speaking practice sentences for an 8th grade Spanish student. ' +
    'Show the student an English sentence to translate and say aloud in Spanish. ' +
    'Use vocabulary relevant to their topics and weak areas. ' +
    'Sentences should be 6-12 words in Spanish — natural and at 8th grade level.' +
    '\n\nReturn a JSON array of exactly 4 objects:\n' +
    '{"en":"I have to do my homework before dinner.","es":"Tengo que hacer mi tarea antes de cenar.","hint":"tengo que... antes de..."}';

  try {
    const text = await workerCall(system, prompt, 900);
    const items = parseJSON(text);
    if (Array.isArray(items)) {
      aiSpeakQueue.push(...items.filter(i => i.en && i.es));
    }
  } catch (e) {
    console.warn('AI speak fetch failed:', e.message);
    aiSpeakQueue.push(...SPEAKING_BANK.slice(0, 4));
  }
  fetchingSpeak = false;
}

// ---- Coaching AI calls ----
async function aiExpandVocab() {
  const statusEl = document.getElementById('ai-expand-status');
  const btn      = document.getElementById('expand-btn');

  if (!customWords.length) {
    statusEl.textContent = 'Add some words first, then I can expand on them!';
    return;
  }

  btn.classList.add('loading');
  btn.innerHTML = '<span>⏳</span> Expanding…';
  statusEl.textContent = 'AI is finding related vocabulary…';

  const sample = customWords.slice(0, 10).map(w => w.es + ' = ' + w.en).join('\n');
  const system = 'You are a Spanish teacher for 8th grade. Respond ONLY with a valid JSON array. No explanation, no markdown, no code fences, no extra text — just the raw JSON array.';
  const prompt = 'A student entered these Spanish vocabulary words:\n' + sample +
    '\n\nIdentify the topic/theme of these words and generate 8 NEW related Spanish vocabulary words that the student has NOT already entered. ' +
    'Return ONLY a JSON array with no other text:\n' +
    '[{"es":"la camisa","en":"shirt","cat":"Clothing","pron":"lah kah-MEE-sah","ex":"La camisa es azul."}]';

  try {
    const text = await workerCall(system, prompt, 1000);

    // Strip any accidental markdown fences or leading/trailing whitespace
    const clean = text.replace(/```json|```/g, '').trim();

    // Find the JSON array even if there's stray text around it
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('AI did not return a JSON array. Response: ' + clean.slice(0, 100));

    const words = JSON.parse(match[0]);
    if (!Array.isArray(words)) throw new Error('Parsed result is not an array.');

    const added = words.filter(w => w.es && w.en);
    if (added.length === 0) throw new Error('AI returned an array but no valid word objects.');

    // Avoid adding duplicates
    const existing = new Set(customWords.map(w => w.es.toLowerCase().trim()));
    const fresh = added.filter(w => !existing.has(w.es.toLowerCase().trim()));

    customWords.push(...fresh);
    renderVocabTags();
    statusEl.textContent = '✨ AI added ' + fresh.length + ' related words!';
    saveState();

  } catch (e) {
    console.error('aiExpandVocab error:', e);
    statusEl.textContent = '⚠ Error: ' + e.message + '. Please try again.';
  }

  // Always reset the button whether we succeeded or failed
  btn.classList.remove('loading');
  btn.innerHTML = '<span>✨</span> AI: Expand These Topics';
}

async function aiEncouragement(activityName, score, weaknesses) {
  const panel = document.getElementById('ai-panel');
  const panelText = document.getElementById('ai-panel-text');
  panel.style.display = 'block';
  panelText.innerHTML = '<div class="ai-thinking"><div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div></div>';
  const weakStr = weaknesses.length
    ? 'Weak areas: ' + weaknesses.map(w => w.label).join(', ') + '.'
    : 'No major weak areas yet.';
  const system = 'You are an encouraging Spanish tutor for a middle school student. Be warm, brief (2-3 sentences max), positive and specific. Plain text only — no lists, no markdown.';
  const prompt = userName + ' just completed ' + activityName + ' with result: ' + score + '. ' + weakStr +
    ' Give specific personalized encouragement and one quick tip. Address them by name.';
  try {
    panelText.textContent = await workerCall(system, prompt, 200);
  } catch (e) {
    panelText.textContent = '¡Muy bien, ' + userName + '! You are making great progress. Keep going!';
  }
}

async function aiHint(spanishWord, correctAnswer, studentAnswer) {
  const panel = document.getElementById('ai-panel');
  const panelText = document.getElementById('ai-panel-text');
  panel.style.display = 'block';
  panelText.innerHTML = '<div class="ai-thinking"><div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div></div>';
  const system = 'You are a friendly Spanish tutor for a middle school student. Give a very short memory tip (1-2 sentences, plain text only). Be encouraging.';
  const prompt = 'Student confused "' + spanishWord + '" (correct answer: "' + correctAnswer + '") with "' + studentAnswer + '". Give a quick mnemonic or memory trick to remember the right answer.';
  try {
    panelText.textContent = await workerCall(system, prompt, 150);
  } catch (e) {
    panel.style.display = 'none';
  }
}

// ============================================================
// SETUP
// ============================================================
document.querySelectorAll('.topic-chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('sel')));
document.querySelectorAll('.time-opt').forEach(o => o.addEventListener('click', () => {
  document.querySelectorAll('.time-opt').forEach(x => x.classList.remove('sel'));
  o.classList.add('sel');
}));

function parseCustomVocab() {
  const raw = document.getElementById('custom-vocab-input').value.trim();
  if (!raw) return;
  raw.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    if (line.includes('=')) {
      const [es, en] = line.split('=').map(s => s.trim());
      if (es && en) customWords.push({ es, en, cat: 'Custom', pron: '', ex: '' });
    } else {
      customWords.push({ es: line, en: '(tap to reveal)', cat: 'Custom', pron: '', ex: '' });
    }
  });
  document.getElementById('custom-vocab-input').value = '';
  renderVocabTags();
  saveState();
}

function renderVocabTags() {
  document.getElementById('vocab-tags').innerHTML = customWords.map((w, i) =>
    '<div class="vocab-tag" onclick="removeCustomWord(' + i + ')"><span>' + w.es + '</span><span class="rm">×</span></div>'
  ).join('');
}

function removeCustomWord(i) { customWords.splice(i, 1); renderVocabTags(); saveState(); }

function startApp() {
  userName       = document.getElementById('setup-name').value.trim() || 'Student';
  selectedTopics = Array.from(document.querySelectorAll('.topic-chip.sel')).map(c => c.dataset.topic);
  dailyMinutes   = parseInt(document.querySelector('.time-opt.sel').dataset.mins) || 20;
  if (!selectedTopics.length) { alert('Please select at least one topic!'); return; }
  buildActiveVocab();
  buildDailyPlan();
  renderPlan();
  saveState();
  goPage('plan');
}

function buildActiveVocab() {
  activeVocab = [];
  selectedTopics.forEach(t => {
    if (ALL_VOCAB[t]) activeVocab.push(...ALL_VOCAB[t].map(w => ({ ...w, cat: t })));
  });
  activeVocab.push(...customWords);
}

// ============================================================
// DAILY PLAN
// ============================================================
function buildDailyPlan() {
  planActivities = []; completedActivities = new Set();
  const { weak } = getWeaknesses();
  const weakActIds = weak.map(w => {
    if (w.label === 'Listening') return 'listen';
    if (w.label === 'Speaking')  return 'speak';
    return null;
  }).filter(Boolean);

  let plan;
  if      (dailyMinutes <= 10) plan = [{ id: 'flashcards', mins: 3 }, { id: 'quiz', mins: 4 }, { id: 'conjugation', mins: 3 }];
  else if (dailyMinutes <= 20) plan = [{ id: 'flashcards', mins: 4 }, { id: 'quiz', mins: 4 }, { id: 'conjugation', mins: 4 }, { id: 'listen', mins: 4 }, { id: 'speak', mins: 4 }];
  else if (dailyMinutes <= 30) plan = [{ id: 'flashcards', mins: 6 }, { id: 'quiz', mins: 6 }, { id: 'conjugation', mins: 6 }, { id: 'listen', mins: 6 }, { id: 'speak', mins: 6 }];
  else                         plan = [{ id: 'flashcards', mins: 9 }, { id: 'quiz', mins: 9 }, { id: 'conjugation', mins: 9 }, { id: 'listen', mins: 9 }, { id: 'speak', mins: 9 }];

  plan.forEach((p, i) => {
    const def = ACTIVITY_DEFS.find(d => d.id === p.id);
    planActivities.push({ ...def, ...p, order: i + 1, focus: weakActIds.includes(p.id) });
  });
}

function renderPlan() {
  const hour = new Date().getHours();
  document.getElementById('plan-greeting').textContent =
    hour < 12 ? '¡Buenos días, ' + userName + '! 🌅' :
    hour < 17 ? '¡Buenas tardes, ' + userName + '! ☀️' :
                '¡Buenas noches, ' + userName + '! 🌙';
  document.getElementById('plan-sub').textContent =
    dailyMinutes + '-min plan · ' + selectedTopics.length + ' topics · ' + activeVocab.length + ' words · AI-powered ✨';

  const enc = ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)];
  document.getElementById('enc-quote').textContent = enc.q;
  document.getElementById('enc-attr').textContent  = enc.a;

  updateWeaknessUI();
  renderPlanGrid();
  updateStats();

  // Pre-fetch AI content in the background while student reads the plan
  fetchAIQuizBatch();
  fetchAIListenBatch();
  fetchAISpeakBatch();
}

function renderPlanGrid() {
  document.getElementById('plan-grid').innerHTML = planActivities.map((act, i) => {
    const done   = completedActivities.has(act.id);
    const isNext = !done && planActivities.slice(0, i).every(a => completedActivities.has(a.id));
    const cls    = done ? 'done' : act.focus ? 'focus-task' : isNext ? 'active-task' : '';
    return '<div class="plan-card ' + cls + '" onclick="startActivity(\'' + act.id + '\')">' +
      '<div class="plan-icon">' + act.icon + '</div>' +
      '<div class="plan-info">' +
        '<div class="plan-title">' + act.order + '. ' + act.label +
          (act.focus ? '<span class="focus-badge">AI Focus</span>' : '') + '</div>' +
        '<div class="plan-desc">' + act.desc +
          (done ? ' — ✅ Done!' : isNext ? ' — 👈 Start here!' : '') + '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0;">' +
        '<div class="plan-time-lbl">' + act.mins + ' min</div>' +
        '<button class="plan-start-btn ' + (done ? 'done-btn' : 'go') + '" ' +
          'onclick="event.stopPropagation();startActivity(\'' + act.id + '\')">' +
          (done ? 'Review ↺' : 'Start →') + '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function updateStats() {
  const done = completedActivities.size, total = planActivities.length;
  const pct  = total ? Math.round(done / total * 100) : 0;
  document.getElementById('dprog-fill').style.width = pct + '%';
  document.getElementById('dprog-lbl').textContent  = done + ' of ' + total + ' complete — ' + pct + '%';
  ['s-streak', 'h-streak'].forEach(id => { document.getElementById(id).textContent = streak; });
  ['s-xp',     'h-xp'    ].forEach(id => { document.getElementById(id).textContent = xp; });
  document.getElementById('s-score').textContent   = quizTotal ? Math.round(quizCorrect / quizTotal * 100) + '%' : '—';
  document.getElementById('s-learned').textContent = learnedSet.size;
}

// ============================================================
// NAVIGATION
// ============================================================
function goPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  window.scrollTo(0, 0);
}

function goBack() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (isRecording) stopRec();
  document.getElementById('ai-panel').style.display = 'none';
  renderPlanGrid();
  updateStats();
  goPage('plan');
}

function startActivity(id) {
  currentActivity = id;
  const act = planActivities.find(a => a.id === id);
  document.getElementById('act-title').textContent = act.icon + ' ' + act.label;
  document.getElementById('act-sub').textContent   = act.desc;
  document.getElementById('ai-panel').style.display = 'none';
  document.querySelectorAll('[id^="act-"]').forEach(el => el.style.display = 'none');
  document.getElementById('act-' + id).style.display = 'block';
  startTimer(act.mins * 60);

  if      (id === 'flashcards')  { buildFCCatFilter(); loadCard(); }
  else if (id === 'quiz')        { quizReverse = false; loadQuiz(); }
  else if (id === 'conjugation') { buildTenseTabs(); loadVerb(); }
  else if (id === 'listen')      { loadListen(); }
  else if (id === 'speak')       { loadSpeak(); }

  goPage('activity');
}

async function finishActivity() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (isRecording) stopRec();
  const wasNew = !completedActivities.has(currentActivity);
  completedActivities.add(currentActivity);
  saveState();

  const { weak } = getWeaknesses();
  const actLabel = planActivities.find(a => a.id === currentActivity)?.label || currentActivity;
  const score    = (currentActivity === 'quiz' && quizTotal)
    ? Math.round(quizCorrect / quizTotal * 100) + '%'
    : 'completed';

  if (wasNew) {
    addXP(50);
    // Refill AI queues in background
    if (currentActivity === 'quiz')   fetchAIQuizBatch();
    if (currentActivity === 'listen') fetchAIListenBatch();
    if (currentActivity === 'speak')  fetchAISpeakBatch();

    await aiEncouragement(actLabel, score, weak);
    if (planActivities.every(a => completedActivities.has(a.id))) {
      showPopup('🏆', '¡Lo lograste!',
        'Amazing work, ' + userName + '! You completed your full daily plan! ' +
        'Your Spanish is getting stronger every day. ¡Hasta mañana!');
    }
  } else {
    goBack();
  }
}

// ============================================================
// TIMER
// ============================================================
function startTimer(seconds) {
  if (timerInterval) clearInterval(timerInterval);
  timerSeconds = seconds; timerMax = seconds;
  updateTimerUI();
  timerInterval = setInterval(() => {
    timerSeconds = Math.max(0, timerSeconds - 1);
    updateTimerUI();
    if (timerSeconds === 0) { clearInterval(timerInterval); timerInterval = null; }
  }, 1000);
}

function updateTimerUI() {
  const m = Math.floor(timerSeconds / 60), s = timerSeconds % 60;
  document.getElementById('timer-disp').textContent = m + ':' + (s < 10 ? '0' : '') + s;
  const pct  = timerMax ? Math.round(timerSeconds / timerMax * 100) : 0;
  const fill = document.getElementById('timer-fill');
  fill.style.width      = pct + '%';
  fill.style.background = pct > 40 ? 'var(--green)' : pct > 15 ? 'var(--gold)' : 'var(--orange)';
  document.getElementById('timer-lbl').textContent = timerSeconds > 0 ? 'remaining' : "Time's up!";
}

// ============================================================
// POPUP
// ============================================================
function showPopup(emoji, title, msg) {
  document.getElementById('popup-emoji').textContent = emoji;
  document.getElementById('popup-title').textContent = title;
  document.getElementById('popup-msg').textContent   = msg;
  document.getElementById('popup').classList.add('show');
}
function closePopup() { document.getElementById('popup').classList.remove('show'); goBack(); }

// ============================================================
// UTILS
// ============================================================
function speakTTS(txt, lang, rate) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(txt);
  u.lang = lang || 'es-ES'; u.rate = rate || 1;
  window.speechSynthesis.speak(u);
}

function addXP(n) {
  xp += n;
  document.getElementById('s-xp').textContent = xp;
  document.getElementById('h-xp').textContent = xp;
  saveState();
}

function showFB(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '<div class="feedback ' + (type || 'good') + '">' + msg + '</div>';
  setTimeout(() => { if (el) el.innerHTML = ''; }, 3500);
}

function normalize(s) {
  return s.toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9 ]/g, '').trim();
}

function showLoadingInEl(el) {
  el.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;padding:1rem 0;color:var(--muted);font-size:13px;">' +
    '<div class="ai-thinking"><div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div></div>' +
    'AI is generating your question…</div>';
}

// ============================================================
// FLASHCARDS
// ============================================================
function buildFCCatFilter() {
  const cats = ['All', ...new Set(activeVocab.map(v => v.cat))];
  document.getElementById('fc-cat-filter').innerHTML = cats.map(c =>
    '<button class="cat-btn ' + (c === fcCat ? 'active' : '') + '" onclick="setFCCat(\'' + c + '\')">' + c + '</button>'
  ).join('');
}

function setFCCat(c) { fcCat = c; fcIdx = 0; buildFCCatFilter(); loadCard(); }
function filteredVocab() { return fcCat === 'All' ? activeVocab : activeVocab.filter(v => v.cat === fcCat); }

function loadCard() {
  const list = filteredVocab();
  if (!list.length) return;
  const { weak } = getWeaknesses();
  const weakCats = weak.map(w => w.label);
  let item;
  if (weakCats.length && Math.random() < 0.55) {
    const weakItems = list.filter(v => weakCats.includes(v.cat));
    item = weakItems.length ? weakItems[Math.floor(Math.random() * weakItems.length)] : list[fcIdx % list.length];
  } else {
    item = list[fcIdx % list.length];
  }
  document.getElementById('fc-es').textContent   = item.es;
  document.getElementById('fc-pron').textContent = item.pron || '';
  document.getElementById('fc-cat').textContent  = item.cat;
  document.getElementById('fc-cat2').textContent = item.cat;
  document.getElementById('fc-en').textContent   = item.en;
  document.getElementById('fc-ex').textContent   = item.ex || '';
  const n = fcIdx % list.length + 1;
  document.getElementById('fc-counter').textContent = 'Card ' + n + ' of ' + list.length;
  document.getElementById('fc-prog').style.width    = Math.round(n / list.length * 100) + '%';
  if (fcFlipped) { document.getElementById('flashcard').classList.remove('flipped'); fcFlipped = false; }
  document.getElementById('flashcard')._item = item;
}

function flipCard() { fcFlipped = !fcFlipped; document.getElementById('flashcard').classList.toggle('flipped', fcFlipped); }
function speakCurrent() { const item = document.getElementById('flashcard')._item; if (item) speakTTS(item.es); }

function rateCard(rating) {
  const item = document.getElementById('flashcard')._item;
  const pts  = { easy: 15, ok: 8, hard: 3 }[rating];
  addXP(pts);
  if (item) {
    recordVocabPerf(item.cat, rating === 'easy');
    if (rating === 'easy') { learnedSet.add(item.es); saveState(); }
  }
  fcIdx++;
  loadCard();
  const msgs  = { easy: '¡Excelente! +' + pts + ' XP 🌟', ok: 'Good try! +' + pts + ' XP', hard: 'Keep going! +' + pts + ' XP 💪' };
  const types = { easy: 'good', ok: 'info', hard: 'bad' };
  showFB('fc-fb', msgs[rating], types[rating]);
}

// ============================================================
// QUIZ — AI-generated with static fallback
// ============================================================
async function loadQuiz() {
  document.getElementById('q-fb').innerHTML = '';
  document.getElementById('ai-panel').style.display = 'none';

  if (aiQuizQueue.length === 0) {
    // Show loading state while we fetch
    document.getElementById('q-word').textContent      = '…';
    document.getElementById('q-dir-label').textContent = 'Loading AI question…';
    showLoadingInEl(document.getElementById('q-opts'));
    await fetchAIQuizBatch();
  }

  // Refill in background when running low
  if (aiQuizQueue.length <= 2) fetchAIQuizBatch();

  if (aiQuizQueue.length === 0) {
    // Fallback to static vocab question
    loadQuizFallback();
    return;
  }

  const q = aiQuizQueue.shift();
  currentQuizItem = { es: q.vocab_es || q.question, cat: 'AI' };

  // Store what should actually be spoken in Spanish — used by the 🔊 button
  // For fill_blank, speak the full sentence with the blank replaced by the correct answer
  // For translate_es, speak the Spanish question word
  // For translate_en, speak the correct Spanish answer
  let audioText = '';
  if (q.type === 'fill_blank') {
    audioText = q.question.replace(/_{2,}/g, q.correct);
  } else if (q.type === 'translate_es') {
    audioText = q.question;  // the question IS the Spanish word
  } else if (q.type === 'translate_en') {
    audioText = q.correct;   // the correct answer IS the Spanish word
  } else {
    audioText = q.vocab_es || q.question;
  }
  currentQuizItem._audioText = audioText;

  const dirLabel = {
    translate_es: 'What does this mean in English?',
    translate_en: 'How do you say this in Spanish?',
    fill_blank:   'Fill in the blank:',
  }[q.type] || 'Translate:';

  document.getElementById('q-dir-label').textContent = dirLabel;
  document.getElementById('q-word').textContent      = q.question;

  const opts = [q.correct, ...q.distractors].sort(() => Math.random() - 0.5);

  // Use data attributes to avoid quote-escaping issues in onclick
  const optsHTML = opts.map((o, i) =>
    '<button class="quiz-opt" data-idx="' + i + '">' + o + '</button>'
  ).join('');
  document.getElementById('q-opts').innerHTML = optsHTML;

  // Attach click handlers directly
  document.querySelectorAll('#q-opts .quiz-opt').forEach(btn => {
    btn.addEventListener('click', () => answerQuizAI(btn, btn.textContent, q.correct, q.question));
  });
}

function answerQuizAI(btn, chosen, correct, questionWord) {
  quizTotal++;
  document.querySelectorAll('.quiz-opt').forEach(o => o.classList.add('disabled'));
  const isCorrect = chosen === correct;

  // Try to find matching vocab for performance tracking
  const vocabMatch = activeVocab.find(v => v.es === currentQuizItem.es || v.en === currentQuizItem.es);
  const cat = vocabMatch ? vocabMatch.cat : 'AI';

  if (isCorrect) {
    btn.classList.add('correct'); quizCorrect++; addXP(20);
    recordVocabPerf(cat, true);
    const praise = ['¡Correcto! 🎉 +20 XP', '¡Muy bien! +20 XP', '¡Perfecto! 🧠 +20 XP', '¡Sí! +20 XP'];
    showFB('q-fb', praise[Math.floor(Math.random() * praise.length)], 'good');
    // Speak the Spanish phrase so she hears the correct pronunciation
    const toSpeak = (currentQuizItem && currentQuizItem._audioText) ? currentQuizItem._audioText : correct;
    speakTTS(toSpeak, 'es-ES');
  } else {
    btn.classList.add('wrong');
    document.querySelectorAll('.quiz-opt').forEach(o => { if (o.textContent === correct) o.classList.add('correct'); });
    recordVocabPerf(cat, false);
    showFB('q-fb', 'Not quite — answer: <strong>' + correct + '</strong>. You\'ll get it! 💪', 'bad');
    aiHint(questionWord, correct, chosen);
  }
  saveState();
  document.getElementById('s-score').textContent = quizTotal ? Math.round(quizCorrect / quizTotal * 100) + '%' : '—';
}

function loadQuizFallback() {
  if (activeVocab.length < 4) {
    document.getElementById('q-opts').innerHTML = '<p style="color:var(--muted)">Add more vocabulary in Topics to unlock quizzes.</p>';
    return;
  }
  const item    = activeVocab[Math.floor(Math.random() * activeVocab.length)];
  currentQuizItem = item;
  const question = quizReverse ? item.en : item.es;
  const correct  = quizReverse ? item.es : item.en;
  document.getElementById('q-word').textContent      = question;
  document.getElementById('q-dir-label').textContent = quizReverse ? 'How do you say this in Spanish?' : 'What does this mean in English?';
  const wrongs = activeVocab.filter(v => v !== item).sort(() => Math.random() - 0.5).slice(0, 3);
  const opts   = [item, ...wrongs].sort(() => Math.random() - 0.5);
  const optsHTML = opts.map(o => '<button class="quiz-opt">' + (quizReverse ? o.es : o.en) + '</button>').join('');
  document.getElementById('q-opts').innerHTML = optsHTML;
  document.querySelectorAll('#q-opts .quiz-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      quizTotal++;
      document.querySelectorAll('.quiz-opt').forEach(o => o.classList.add('disabled'));
      if (btn.textContent === correct) {
        btn.classList.add('correct'); quizCorrect++; addXP(20);
        recordVocabPerf(item.cat, true);
        showFB('q-fb', '¡Correcto! +20 XP 🎉', 'good');
        speakTTS(item.es, 'es-ES');
      } else {
        btn.classList.add('wrong');
        document.querySelectorAll('.quiz-opt').forEach(o => { if (o.textContent === correct) o.classList.add('correct'); });
        recordVocabPerf(item.cat, false);
        showFB('q-fb', 'Not quite — answer: <strong>' + correct + '</strong>. 💪', 'bad');
        aiHint(quizReverse ? item.en : item.es, correct, btn.textContent);
      }
      saveState();
      document.getElementById('s-score').textContent = quizTotal ? Math.round(quizCorrect / quizTotal * 100) + '%' : '—';
    });
  });
}

function speakQuiz() {
  // Always speak Spanish — use the pre-stored audio text which has blanks filled in
  // and is guaranteed to be the Spanish side regardless of question type
  const text = (currentQuizItem && currentQuizItem._audioText)
    ? currentQuizItem._audioText
    : document.getElementById('q-word').textContent.replace(/_{2,}/g, '');
  if (text) speakTTS(text, 'es-ES');
}

function toggleQuizDir() {
  quizReverse = !quizReverse;
  document.getElementById('q-toggle').textContent = quizReverse ? 'Switch: EN →' : 'Switch: ES →';
  loadQuiz();
}

// ============================================================
// CONJUGATION
// ============================================================
function buildTenseTabs() {
  document.getElementById('tense-tabs').innerHTML = TENSES.map(t =>
    '<button class="tense-tab ' + (t === tense ? 'active' : '') + '" onclick="setTense(\'' + t + '\')">' + TENSE_LBL[t] + '</button>'
  ).join('');
}

function setTense(t) { tense = t; buildTenseTabs(); loadVerb(); }

function loadVerb() {
  const { weak } = getWeaknesses();
  const weakVerbs = weak.map(w => w.label);
  let v;
  if (weakVerbs.length && Math.random() < 0.6) {
    const match = VERBS.filter(x => weakVerbs.includes(x.inf));
    v = match.length ? match[Math.floor(Math.random() * match.length)] : VERBS[Math.floor(Math.random() * VERBS.length)];
  } else {
    v = VERBS[Math.floor(Math.random() * VERBS.length)];
  }
  verbIdx = VERBS.indexOf(v);
  document.getElementById('v-inf').textContent  = v.inf;
  document.getElementById('v-type').textContent = v.type;
  document.getElementById('v-en').textContent   = v.en;
  document.getElementById('conj-fb').innerHTML  = '';

  // Note on vosotros
  const vosotrosNote = '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;padding:6px 10px;background:var(--bg);border-radius:var(--rs);">' +
    '💡 <em>Vosotros</em> is mainly used in Spain. Most Latin American Spanish skips it — but it can still appear on tests!' +
    '</div>';

  document.getElementById('conj-grid').innerHTML = vosotrosNote +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;">' +
    PRONOUNS.map((p, i) =>
      '<div class="conj-row">' +
      '<span class="conj-pronoun">' + p + '</span>' +
      '<input class="conj-input" id="ci-' + i + '" placeholder="type here…" autocomplete="off" spellcheck="false"/>' +
      '</div>'
    ).join('') +
    '</div>';

  // Attach cursor-save listeners to the freshly created inputs
  attachConjCursorTracking();
  // Rebuild the accent bar so its buttons are fresh too
  buildConjAccentBar();
}

function checkConj() {
  const v = VERBS[verbIdx]; const ans = v.conj[tense]; let correct = 0;
  P_KEYS.forEach((key, i) => {
    const inp = document.getElementById('ci-' + i);
    if (!inp) return;
    const val = inp.value.trim().toLowerCase();
    inp.classList.remove('correct', 'wrong');
    if (val === ans[key].toLowerCase()) {
      inp.classList.add('correct');
      correct++;
    } else {
      inp.classList.add('wrong');
      // Fill the correct answer directly into wrong fields so student can see it
      inp.value = ans[key];
      inp.style.fontStyle = 'italic';
      inp.style.opacity   = '0.75';
      inp.readOnly = true;
    }
  });
  const pts = correct * 10; addXP(pts);
  recordVerbPerf(v.inf, correct >= 5);

  let msg = '';
  if (correct === 6) {
    msg = '¡Perfecto! All 6 correct! 🏆 +' + pts + ' XP';
    showFB('conj-fb', msg, 'good');
  } else {
    const wrongCount = 6 - correct;
    msg = correct + '/6 correct. The ' + wrongCount + ' wrong answer' + (wrongCount > 1 ? 's are' : ' is') +
      ' filled in above in italic — study them, then hit Next Verb. +' + pts + ' XP';
    showFB('conj-fb', msg, correct >= 4 ? 'info' : 'bad');
  }
}

function speakVerb() {
  const v = VERBS[verbIdx]; const ans = v.conj[tense];
  speakTTS(v.inf + '. ' + PRONOUNS.map((p, i) => p + ' ' + ans[P_KEYS[i]]).join(', '));
}

// ============================================================
// LISTENING — AI-generated with static fallback
// ============================================================
async function loadListen() {
  document.getElementById('listen-ans').value    = '';
  document.getElementById('listen-fb').innerHTML = '';
  document.getElementById('listen-trans').style.display = 'none';

  if (aiListenQueue.length === 0) {
    document.getElementById('listen-q').textContent = 'Loading AI phrase…';
    await fetchAIListenBatch();
  }
  if (aiListenQueue.length <= 1) fetchAIListenBatch();

  if (aiListenQueue.length === 0) {
    // Static fallback
    currentListenItem = LISTENING_BANK[Math.floor(Math.random() * LISTENING_BANK.length)];
    // Normalise field names
    currentListenItem = { ...currentListenItem, question: currentListenItem.q, answer: currentListenItem.ans };
  } else {
    currentListenItem = aiListenQueue.shift();
  }
  document.getElementById('listen-q').textContent = 'Question: ' + currentListenItem.question;
}

function playListen(override) {
  if (!currentListenItem) return;
  const rate = override || parseFloat(document.getElementById('spd').value);
  speakTTS(currentListenItem.es, 'es-ES', rate);
}

function checkListen() {
  if (!currentListenItem) return;
  const studentAns = document.getElementById('listen-ans').value.trim();
  const correct    = (currentListenItem.answer || currentListenItem.ans || '').trim();
  const trans      = document.getElementById('listen-trans');
  trans.textContent   = 'Phrase: ' + currentListenItem.es + (currentListenItem.hint ? ' | Hint: ' + currentListenItem.hint : '');
  trans.style.display = 'block';

  if (!studentAns) {
    showFB('listen-fb', 'Type your answer first!', 'info');
    return;
  }

  const isCorrect = fuzzyListenMatch(studentAns, correct);
  recordListenPerf(isCorrect);

  if (isCorrect) {
    showFB('listen-fb', '¡Correcto! Your ears are getting sharp! 👂 +25 XP', 'good');
    addXP(25);
  } else {
    // Show the correct answer clearly and be encouraging
    showFB('listen-fb',
      'Not quite. You wrote: "<em>' + studentAns + '</em>" — expected something like: "<strong>' + correct + '</strong>". ' +
      'Try playing it at slow speed and listen again! 🐢', 'bad');
    // Also ask AI if it was actually close enough (async — updates feedback if AI says yes)
    aiCheckListenAnswer(studentAns, correct, currentListenItem.es);
  }
}

// Fuzzy match: normalize both strings and check word overlap
function fuzzyListenMatch(studentAns, correct) {
  const normStudent = normalize(studentAns);
  const normCorrect = normalize(correct);

  // Exact or contains match
  if (normStudent === normCorrect) return true;
  if (normStudent.includes(normCorrect)) return true;
  if (normCorrect.includes(normStudent) && normStudent.length > 2) return true;

  // Word overlap: if student got >= 60% of the key words, accept it
  const correctWords  = normCorrect.split(' ').filter(w => w.length > 2); // ignore tiny words
  const studentWords  = normStudent.split(' ');
  if (correctWords.length === 0) return false;
  const matched = correctWords.filter(w => studentWords.some(sw => sw.includes(w) || w.includes(sw)));
  if (matched.length / correctWords.length >= 0.6) return true;

  // Number equivalents (e.g. "15" vs "fifteen" vs "quince")
  const numMap = { '1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine','10':'ten',
                   '11':'eleven','12':'twelve','13':'thirteen','14':'fourteen','15':'fifteen','16':'sixteen',
                   '20':'twenty','30':'thirty' };
  const expandNum = s => { let r = s; Object.entries(numMap).forEach(([n, w]) => { r = r.replace(new RegExp('\\b'+n+'\\b','g'), w); }); return r; };
  if (normalize(expandNum(studentAns)).includes(normalize(expandNum(correct)))) return true;

  return false;
}

// AI double-check for borderline answers — updates the feedback message asynchronously
async function aiCheckListenAnswer(studentAns, correct, spanishPhrase) {
  try {
    const system = 'You are grading a Spanish listening exercise for an 8th grade student. Answer with ONLY "correct" or "incorrect" — no other text.';
    const prompt = 'The Spanish phrase was: "' + spanishPhrase + '"\n' +
      'The expected answer was: "' + correct + '"\n' +
      'The student wrote: "' + studentAns + '"\n\n' +
      'Is the student\'s answer close enough to be marked correct? Consider synonyms, partial answers, and reasonable paraphrasing. Answer "correct" or "incorrect" only.';
    const result = (await workerCall(system, prompt, 10)).toLowerCase().trim();
    if (result.startsWith('correct')) {
      // AI says it was actually fine — update the feedback
      recordListenPerf(true); // correct the record
      perfData.listen.total--; // undo the wrong one we already recorded
      if (perfData.listen.correct > 0) perfData.listen.correct--; // remove the false negative
      saveState();
      showFB('listen-fb', '✨ AI says that counts! Good enough answer! 👂 +25 XP', 'good');
      addXP(25);
    }
  } catch (e) {
    // Silently fail — original feedback stays
  }
}

// ============================================================
// SPEAKING — AI-generated with static fallback
// ============================================================
async function loadSpeak() {
  document.getElementById('speak-result').textContent = 'Your speech will appear here…';
  document.getElementById('speak-fb').innerHTML       = '';
  if (isRecording) stopRec();

  if (aiSpeakQueue.length === 0) {
    document.getElementById('speak-en').textContent   = 'Loading AI phrase…';
    document.getElementById('speak-hint').textContent = '';
    await fetchAISpeakBatch();
  }
  if (aiSpeakQueue.length <= 1) fetchAISpeakBatch();

  if (aiSpeakQueue.length === 0) {
    currentSpeakItem = SPEAKING_BANK[Math.floor(Math.random() * SPEAKING_BANK.length)];
  } else {
    currentSpeakItem = aiSpeakQueue.shift();
  }
  document.getElementById('speak-en').textContent   = currentSpeakItem.en;
  document.getElementById('speak-hint').textContent = currentSpeakItem.hint ? 'Hint: ' + currentSpeakItem.hint : '';
}

function hearAnswer() { if (currentSpeakItem) speakTTS(currentSpeakItem.es); }
function toggleRecording() { if (isRecording) stopRec(); else startRec(); }

function startRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { document.getElementById('speak-result').textContent = 'Speech recognition not supported. Please use Chrome or Edge.'; return; }
  recognition = new SR(); recognition.lang = 'es-ES'; recognition.continuous = false; recognition.interimResults = true;
  recognition.onresult = e => {
    const t = Array.from(e.results).map(r => r[0].transcript).join('').toLowerCase().trim();
    document.getElementById('speak-result').textContent = t;
    if (e.results[e.results.length - 1].isFinal) evalSpeech(t);
  };
  recognition.onerror = e => { document.getElementById('speak-result').textContent = 'Mic error: ' + e.error; stopRec(); };
  recognition.onend   = () => { if (isRecording) stopRec(); };
  recognition.start(); isRecording = true;
  document.getElementById('mic-btn').classList.add('recording');
  document.getElementById('rec-status').textContent = '🎙 Listening… speak now!';
}

function stopRec() {
  if (recognition) { try { recognition.stop(); } catch (e) {} }
  isRecording = false;
  document.getElementById('mic-btn').classList.remove('recording');
  document.getElementById('rec-status').textContent = 'Tap mic to start';
}

function evalSpeech(heard) {
  if (!currentSpeakItem) return;
  const expW = normalize(currentSpeakItem.es).split(' ');
  const gotW = normalize(heard).split(' ');
  const pct  = Math.round(expW.filter(w => gotW.includes(w)).length / expW.length * 100);
  recordSpeakPerf(pct >= 60);
  if      (pct >= 70) { showFB('speak-fb', '¡Increíble! ' + pct + '% match — great pronunciation! 🎤 +30 XP', 'good'); addXP(30); }
  else if (pct >= 40) { showFB('speak-fb', pct + '% match — getting there! Target: "' + currentSpeakItem.es + '" +10 XP', 'info'); addXP(10); }
  else                { showFB('speak-fb', pct + '% match — keep trying! Target: "' + currentSpeakItem.es + '" 💪', 'bad'); }
}
