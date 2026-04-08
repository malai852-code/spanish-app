// ============================================================
// app.js — Español Studio main application logic
//
// SETUP REQUIRED:
//   1. Deploy the Cloudflare Worker (see /worker/README.md)
//   2. Replace WORKER_URL below with your worker's URL
//      e.g. 'https://espanol-studio-api.yourname.workers.dev'
// ============================================================

const WORKER_URL = 'https://spanish-app-proxy.marshall-lai.workers.dev';

// Password — change this to whatever you want
const APP_PASSWORD = 'espanol123';

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

function buildConjAccentBar() {
  const bar = document.getElementById('conj-accent-bar');
  if (!bar) return;
  bar.innerHTML = ACCENTS.map(ch =>
    '<button class="inline-accent-key" type="button" onclick="insertIntoFocusedConj(\'' + ch + '\')">' + ch + '</button>'
  ).join('');
}

function insertIntoFocusedConj(ch) {
  const focused = document.activeElement;
  if (focused && focused.classList.contains('conj-input')) {
    const s = focused.selectionStart, e = focused.selectionEnd;
    focused.value = focused.value.slice(0, s) + ch + focused.value.slice(e);
    focused.selectionStart = focused.selectionEnd = s + ch.length;
    focused.focus();
  } else {
    const inputs = document.querySelectorAll('.conj-input');
    if (inputs.length) { const last = inputs[inputs.length - 1]; last.value += ch; last.focus(); }
  }
}

// ============================================================
// LOGIN
// ============================================================
function tryLogin() {
  const val = document.getElementById('login-pw').value;
  if (val === APP_PASSWORD) {
    document.getElementById('login-page').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    buildAccentBar('setup-accent-bar', 'custom-vocab-input');
    buildConjAccentBar();
    loadSavedState();
  } else {
    const err = document.getElementById('login-err');
    err.style.display = 'block';
    document.getElementById('login-pw').value = '';
    setTimeout(() => { err.style.display = 'none'; }, 3000);
  }
}

// ============================================================
// STATE
// ============================================================
let userName = '', dailyMinutes = 20, selectedTopics = [], customWords = [], activeVocab = [];
let planActivities = [], completedActivities = new Set();
let xp = 0, streak = 1, quizCorrect = 0, quizTotal = 0, learnedSet = new Set();
let fcIdx = 0, fcCat = 'All', fcFlipped = false;
let quizReverse = false, currentQuizItem = null;
let verbIdx = 0, tense = 'pres';
let listenIdx = 0, speakIdx = 0;
let recognition = null, isRecording = false;
let currentActivity = null;
let timerInterval = null, timerSeconds = 0, timerMax = 0;

let perfData = {
  vocab: {},   // category -> {correct, total}
  verbs: {},   // verbInf  -> {correct, total}
  listen: { correct: 0, total: 0 },
  speak:  { correct: 0, total: 0 },
};

const PRONOUNS  = ['yo', 'tú', 'él/ella', 'nosotros', 'vosotros', 'ellos'];
const P_KEYS    = ['yo', 'tú', 'él', 'nosotros', 'vosotros', 'ellos'];
const TENSES    = ['pres', 'pret', 'fut'];
const TENSE_LBL = { pres: 'Present', pret: 'Preterite (past)', fut: 'Future' };

const ACTIVITY_DEFS = [
  { id: 'flashcards',  label: 'Vocabulary Flashcards',   icon: '🃏', desc: 'Build your word bank — tap to flip!' },
  { id: 'quiz',        label: 'Multiple Choice Quiz',    icon: '✏️', desc: 'Test yourself in both directions'   },
  { id: 'conjugation', label: 'Verb Conjugation Drill',  icon: '🔄', desc: 'Fill in the forms — key to fluency' },
  { id: 'listen',      label: 'Listening Comprehension', icon: '👂', desc: 'Train your ear with native-speed audio' },
  { id: 'speak',       label: 'Speaking Practice',       icon: '🎤', desc: 'Say it out loud — pronunciation matters!' },
];

// ============================================================
// PERSIST TO LOCALSTORAGE
// ============================================================
function saveState() {
  try {
    localStorage.setItem('espanol_v3', JSON.stringify({
      userName, dailyMinutes, selectedTopics, customWords,
      xp, streak, quizCorrect, quizTotal,
      learnedSet: [...learnedSet],
      perfData,
    }));
  } catch (e) { /* quota exceeded or private mode */ }
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
  } catch (e) { /* corrupt storage — start fresh */ }
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
    if (d.total >= 2 && d.correct / d.total < 0.5) weak.push({ label: verb, rate: d.correct / d.total });
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

function recordListenPerf(correct) { perfData.listen.total++; if (correct) perfData.listen.correct++; saveState(); }
function recordSpeakPerf(correct)  { perfData.speak.total++;  if (correct) perfData.speak.correct++;  saveState(); }

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
    body: JSON.stringify({ system, prompt, max_tokens: maxTokens || 400 }),
  });
  if (!resp.ok) throw new Error('Worker error ' + resp.status);
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return data.text || '';
}

async function aiExpandVocab() {
  if (!customWords.length) {
    document.getElementById('ai-expand-status').textContent = 'Add some words first, then I can expand on them!';
    return;
  }
  const btn = document.getElementById('expand-btn');
  btn.classList.add('loading');
  btn.innerHTML = '<span>⏳</span> Expanding…';
  document.getElementById('ai-expand-status').textContent = 'AI is finding related vocabulary…';

  const sample = customWords.slice(0, 10).map(w => w.es + ' = ' + w.en).join('\n');
  const system = 'You are a Spanish teacher for 8th grade students. Respond ONLY with valid JSON. No explanation, no markdown, no code fences.';
  const prompt = 'A student entered these Spanish words:\n' + sample +
    '\n\nIdentify the theme (e.g. "clothing") and generate 8 RELATED words they have NOT entered. Return a JSON array only:\n' +
    '[{"es":"la camisa","en":"shirt","cat":"Clothing","pron":"lah kah-MEE-sah","ex":"La camisa es azul."},...]';
  try {
    const text = await workerCall(system, prompt, 900);
    const words = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (Array.isArray(words)) {
      const added = words.filter(w => w.es && w.en);
      customWords.push(...added);
      renderVocabTags();
      document.getElementById('ai-expand-status').textContent = '✨ AI added ' + added.length + ' related words!';
      saveState();
    }
  } catch (e) {
    document.getElementById('ai-expand-status').textContent = 'Could not reach AI. Is the Worker URL set correctly?';
  }
  btn.classList.remove('loading');
  btn.innerHTML = '<span>✨</span> AI: Expand These Topics';
}

async function aiEncouragement(activityName, score, weaknesses) {
  const panel = document.getElementById('ai-panel');
  const panelText = document.getElementById('ai-panel-text');
  panel.style.display = 'block';
  panelText.innerHTML = '<div class="ai-thinking"><div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div></div>';
  const weakStr = weaknesses.length ? 'Weak areas: ' + weaknesses.map(w => w.label).join(', ') + '.' : 'No major weak areas yet.';
  const system = 'You are an encouraging Spanish tutor for a middle school student. Be warm, brief (2-3 sentences), positive, and specific. Plain text only — no lists, no markdown.';
  const prompt = userName + ' just completed ' + activityName + ' with result: ' + score + '. ' + weakStr +
    ' Give specific, personalized encouragement and one quick tip. Address them by name.';
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
  const system = 'You are a friendly Spanish tutor for a middle school student. Give a very short memory tip (1-2 sentences, plain text). Be encouraging and specific.';
  const prompt = 'Student confused "' + spanishWord + '" (correct: "' + correctAnswer + '") with "' + studentAnswer + '". Give a quick mnemonic or memory trick.';
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
  selectedTopics.forEach(t => { if (ALL_VOCAB[t]) activeVocab.push(...ALL_VOCAB[t].map(w => ({ ...w, cat: t }))); });
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
  if      (dailyMinutes <= 10) plan = [{ id: 'flashcards', mins: 4 }, { id: 'quiz', mins: 3 }, { id: 'conjugation', mins: 3 }];
  else if (dailyMinutes <= 20) plan = [{ id: 'flashcards', mins: 5 }, { id: 'quiz', mins: 5 }, { id: 'conjugation', mins: 5 }, { id: 'listen', mins: 5 }];
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
    dailyMinutes + '-min plan · ' + selectedTopics.length + ' topics · ' + activeVocab.length + ' words';

  const enc = ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)];
  document.getElementById('enc-quote').textContent = enc.q;
  document.getElementById('enc-attr').textContent  = enc.a;

  updateWeaknessUI();
  renderPlanGrid();
  updateStats();
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

  if      (id === 'flashcards')   { buildFCCatFilter(); loadCard(); }
  else if (id === 'quiz')         { quizReverse = false; loadQuiz(); }
  else if (id === 'conjugation')  { buildTenseTabs(); buildConjAccentBar(); loadVerb(); }
  else if (id === 'listen')       { loadListen(); }
  else if (id === 'speak')        { loadSpeak(); }

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
  const score    = (currentActivity === 'quiz' && quizTotal) ? Math.round(quizCorrect / quizTotal * 100) + '%' : 'completed';

  if (wasNew) {
    addXP(50);
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
  const pct = timerMax ? Math.round(timerSeconds / timerMax * 100) : 0;
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
  document.getElementById('fc-counter').textContent        = 'Card ' + n + ' of ' + list.length;
  document.getElementById('fc-prog').style.width           = Math.round(n / list.length * 100) + '%';
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
// QUIZ
// ============================================================
function loadQuiz() {
  document.getElementById('q-fb').innerHTML = '';
  document.getElementById('ai-panel').style.display = 'none';
  if (activeVocab.length < 4) {
    document.getElementById('q-opts').innerHTML = '<p style="color:var(--muted)">Add more vocabulary in Topics to unlock quizzes (need at least 4 words).</p>';
    return;
  }
  const { weak } = getWeaknesses();
  const weakCats = weak.map(w => w.label);
  let pool = activeVocab;
  if (weakCats.length && Math.random() < 0.6) {
    const wp = activeVocab.filter(v => weakCats.includes(v.cat));
    if (wp.length >= 4) pool = wp;
  }
  const item    = pool[Math.floor(Math.random() * pool.length)];
  currentQuizItem = item;
  const question = quizReverse ? item.en : item.es;
  const correct  = quizReverse ? item.es : item.en;
  document.getElementById('q-word').textContent     = question;
  document.getElementById('q-dir-label').textContent = quizReverse ? 'How do you say this in Spanish?' : 'What does this mean in English?';
  const wrongs = activeVocab.filter(v => v !== item).sort(() => Math.random() - 0.5).slice(0, 3);
  const opts   = [item, ...wrongs].sort(() => Math.random() - 0.5);
  document.getElementById('q-opts').innerHTML = opts.map(o => {
    const lbl = quizReverse ? o.es : o.en;
    return '<button class="quiz-opt" onclick="answerQuiz(this,\'' + lbl.replace(/'/g, "\\'") + '\',\'' + correct.replace(/'/g, "\\'") + '\')">' + lbl + '</button>';
  }).join('');
}

function answerQuiz(btn, chosen, correct) {
  quizTotal++;
  document.querySelectorAll('.quiz-opt').forEach(o => o.classList.add('disabled'));
  const isCorrect = chosen === correct;
  if (isCorrect) {
    btn.classList.add('correct'); quizCorrect++; addXP(20);
    recordVocabPerf(currentQuizItem.cat, true);
    const praise = ['¡Correcto! 🎉 +20 XP', '¡Muy bien! +20 XP', '¡Perfecto! 🧠 +20 XP', '¡Sí! +20 XP'];
    showFB('q-fb', praise[Math.floor(Math.random() * praise.length)], 'good');
    if (!quizReverse) speakTTS(currentQuizItem.es); else speakTTS(chosen);
  } else {
    btn.classList.add('wrong');
    document.querySelectorAll('.quiz-opt').forEach(o => { if (o.textContent === correct) o.classList.add('correct'); });
    recordVocabPerf(currentQuizItem.cat, false);
    showFB('q-fb', 'Not quite — answer: <strong>' + correct + '</strong>. You\'ll get it next time! 💪', 'bad');
    aiHint(quizReverse ? currentQuizItem.en : currentQuizItem.es, correct, chosen);
  }
  saveState();
  document.getElementById('s-score').textContent = quizTotal ? Math.round(quizCorrect / quizTotal * 100) + '%' : '—';
}

function speakQuiz() {
  const w = document.getElementById('q-word').textContent;
  if (!quizReverse) speakTTS(w); else speakTTS(w, 'en-US');
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
  const ans = v.conj[tense];
  document.getElementById('conj-grid').innerHTML = PRONOUNS.map((p, i) =>
    '<div class="conj-row"><span class="conj-pronoun">' + p + '</span>' +
    '<input class="conj-input" id="ci-' + i + '" placeholder="type here…" autocomplete="off" spellcheck="false"/></div>'
  ).join('');
}

function checkConj() {
  const v = VERBS[verbIdx]; const ans = v.conj[tense]; let correct = 0;
  P_KEYS.forEach((key, i) => {
    const inp = document.getElementById('ci-' + i);
    const val = inp.value.trim().toLowerCase();
    inp.classList.remove('correct', 'wrong');
    if (val === ans[key].toLowerCase()) { inp.classList.add('correct'); correct++; }
    else { inp.classList.add('wrong'); inp.placeholder = ans[key]; }
  });
  const pts = correct * 10; addXP(pts);
  recordVerbPerf(v.inf, correct >= 5);
  if (correct === 6) showFB('conj-fb', '¡Perfecto! All 6 correct! 🏆 +' + pts + ' XP', 'good');
  else if (correct >= 4) showFB('conj-fb', correct + '/6 — so close! Check highlighted boxes. +' + pts + ' XP', 'info');
  else showFB('conj-fb', correct + '/6 — keep drilling! Wrong answers shown. +' + pts + ' XP 💪', 'bad');
}

function speakVerb() {
  const v = VERBS[verbIdx]; const ans = v.conj[tense];
  speakTTS(v.inf + '. ' + PRONOUNS.map((p, i) => p + ' ' + ans[P_KEYS[i]]).join(', '));
}

// ============================================================
// LISTENING
// ============================================================
function loadListen() {
  listenIdx = Math.floor(Math.random() * LISTENING_BANK.length);
  const p = LISTENING_BANK[listenIdx];
  document.getElementById('listen-q').textContent = 'Question: ' + p.q;
  document.getElementById('listen-ans').value     = '';
  document.getElementById('listen-fb').innerHTML  = '';
  document.getElementById('listen-trans').style.display = 'none';
}

function playListen(override) {
  const rate = override || parseFloat(document.getElementById('spd').value);
  speakTTS(LISTENING_BANK[listenIdx].es, 'es-ES', rate);
}

function checkListen() {
  const p = LISTENING_BANK[listenIdx];
  const ans     = document.getElementById('listen-ans').value.trim().toLowerCase();
  const correct = p.ans.toLowerCase();
  const trans   = document.getElementById('listen-trans');
  trans.textContent    = 'Phrase: ' + p.es + ' | Hint: ' + p.hint;
  trans.style.display  = 'block';
  const isCorrect = ans.includes(correct) || (correct.includes(ans) && ans.length > 2);
  recordListenPerf(isCorrect);
  if (isCorrect) { showFB('listen-fb', '¡Correcto! Your ears are getting sharp! 👂 +25 XP', 'good'); addXP(25); }
  else           { showFB('listen-fb', 'Not quite — expected: "' + p.ans + '". Hint: ' + p.hint + '. Try the slow button!', 'bad'); }
}

// ============================================================
// SPEAKING
// ============================================================
function loadSpeak() {
  speakIdx = Math.floor(Math.random() * SPEAKING_BANK.length);
  const p  = SPEAKING_BANK[speakIdx];
  document.getElementById('speak-en').textContent     = p.en;
  document.getElementById('speak-hint').textContent   = 'Hint: ' + p.hint;
  document.getElementById('speak-result').textContent = 'Your speech will appear here…';
  document.getElementById('speak-fb').innerHTML       = '';
  if (isRecording) stopRec();
}

function hearAnswer() { speakTTS(SPEAKING_BANK[speakIdx].es); }
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
  const p    = SPEAKING_BANK[speakIdx];
  const expW = normalize(p.es).split(' ');
  const gotW = normalize(heard).split(' ');
  const pct  = Math.round(expW.filter(w => gotW.includes(w)).length / expW.length * 100);
  recordSpeakPerf(pct >= 60);
  if      (pct >= 70) { showFB('speak-fb', '¡Increíble! ' + pct + '% match — great pronunciation! 🎤 +30 XP', 'good'); addXP(30); }
  else if (pct >= 40) { showFB('speak-fb', pct + '% match — getting there! Target: "' + p.es + '" +10 XP', 'info'); addXP(10); }
  else                { showFB('speak-fb', pct + '% match — keep trying! Target: "' + p.es + '" 💪', 'bad'); }
}
