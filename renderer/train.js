// Menú 3: Entrenamiento (simulador de entrevista)
const T = { cfg: null, items: [], current: null, result: null, queue: [], mic: null, finalText: '', words: [], voice: false, busy: false };
const show = (id, on) => $(id).classList.toggle('hidden', !on);

// ---------- Voz de la pregunta (texto a voz del sistema) ----------
function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = 0.95;
  const v = speechSynthesis.getVoices().find(x => /en-US/i.test(x.lang) && /natural|online|aria|guy|jenny/i.test(x.name)) || speechSynthesis.getVoices().find(x => /^en/i.test(x.lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

// ---------- Progreso guardado ----------
function renderProgress(list) {
  const box = $('tProgress');
  if (!list.length) { box.innerHTML = '<span class="hint">Aún no hay sesiones. Haz tu primera entrevista para ver tu evolución.</span>'; return; }
  const pts = list.slice(-15).map(s => s.avg);
  const W = 300, H = 60, step = pts.length > 1 ? W / (pts.length - 1) : 0;
  const xy = pts.map((v, i) => [i * step, H - (v / 10) * H]);
  const path = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const avgAll = (pts.reduce((a, b) => a + b, 0) / pts.length).toFixed(1);
  box.innerHTML = `<svg class="spark" viewBox="-4 -4 ${W + 8} ${H + 8}" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="#6c7bff" stroke-width="2.5" stroke-linejoin="round"/>${xy.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#a06bff"/>`).join('')}</svg>
    <div class="sess-row"><span>${list.length} sesiones · promedio ${avgAll}/10</span><span>última: ${pts[pts.length - 1]}/10</span></div>` +
    list.slice(-4).reverse().map(s => `<div class="sess-row"><span>${new Date(s.t).toLocaleDateString()} · ${esc(s.role)} · ${s.level}</span><b>${s.avg}/10</b></div>`).join('');
}
async function loadProgress() { renderProgress(await api.trainProgress()); }

// ---------- Flujo ----------
$('tRole').onchange = () => show('tRoleOther', $('tRole').value === 'Otro…');
$('tStart').onclick = () => {
  const role = $('tRole').value === 'Otro…' ? ($('tRoleOther').value.trim() || 'Software Engineer') : $('tRole').value;
  T.cfg = { role, level: $('tLevel').value, type: $('tType').value, count: +$('tCount').value };
  T.items = []; T.queue = [];
  show('tSetup', false); show('tSummary', false); show('tRun', true);
  nextQuestion();
};

async function nextQuestion() {
  stopMic();
  T.result = null; T.finalText = ''; T.words = []; T.voice = false;
  $('tAns').value = ''; show('tResult', false); show('tAnswerBox', true); show('tQes', false);
  $('tShowEs').textContent = 'Ver traducción';
  const n = T.items.length + 1;
  $('tNum').textContent = `Pregunta ${n} de ${T.cfg.count} · ${T.cfg.role}`;
  $('tQ').textContent = 'Preparando pregunta…'; $('tQes').textContent = '';
  try {
    const q = T.queue.length ? T.queue.shift() : await api.trainQuestion({ cfgT: T.cfg, previous: T.items.map(x => x.q) });
    T.current = q;
    $('tQ').textContent = q.q; $('tQes').textContent = q.es || '';
    speak(q.q);
    $('tAns').focus();
  } catch (e) { $('tQ').textContent = '⚠ ' + e.message; }
}

$('tSpeak').onclick = () => speak($('tQ').textContent);
$('tShowEs').onclick = () => { const h = $('tQes').classList.contains('hidden'); show('tQes', h); $('tShowEs').textContent = h ? 'Ocultar traducción' : 'Ver traducción'; };

// ---------- Micrófono + transcripción (Deepgram) ----------
async function toggleMic() { return T.mic ? stopMic() : startMic(); }
async function startMic() {
  if (!S.cfg.deepgramKey) { $('tMicSt').textContent = 'Falta la clave de Deepgram (Ajustes).'; return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $('tMicSt').textContent = 'No pude usar el micrófono. Revisa los permisos de Windows.'; return; }
  speechSynthesis.cancel();
  T.finalText = $('tAns').value ? $('tAns').value.trim() + ' ' : ''; T.words = []; T.voice = true;
  const ws = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&punctuate=true&interim_results=true', ['token', S.cfg.deepgramKey]);
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  T.mic = { ws, rec, stream };
  ws.onopen = () => { rec.ondataavailable = e => { if (e.data.size && ws.readyState === 1) ws.send(e.data); }; rec.start(150); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'Results') return;
    const alt = m.channel?.alternatives?.[0]; const t = alt?.transcript || '';
    if (m.is_final) { if (t) { T.finalText += t + ' '; T.words.push(...(alt.words || [])); } $('tAns').value = T.finalText; }
    else $('tAns').value = (T.finalText + t).trim();
  };
  ws.onerror = () => { $('tMicSt').textContent = 'Error de conexión con Deepgram.'; stopMic(); };
  $('tMic').classList.add('rec'); $('tMic').innerHTML = '⏹ Detener <kbd>Ctrl+M</kbd>'; $('tMicSt').textContent = 'Grabando… habla en inglés';
}
function stopMic() {
  const m = T.mic; if (!m) return;
  T.mic = null;
  try { m.rec.state !== 'inactive' && m.rec.stop(); } catch {}
  setTimeout(() => { try { m.ws.close(); } catch {} }, 700);   // deja llegar los últimos resultados
  try { m.stream.getTracks().forEach(t => t.stop()); } catch {}
  $('tMic').classList.remove('rec'); $('tMic').innerHTML = '🎤 Hablar <kbd>Ctrl+M</kbd>'; $('tMicSt').textContent = '';
}
$('tMic').onclick = toggleMic;

function pronData() {
  const w = T.words.filter(x => typeof x.confidence === 'number');
  if (!w.length) return null;
  const avg = Math.round(w.reduce((a, b) => a + b.confidence, 0) / w.length * 100);
  const low = [...new Set(w.filter(x => x.confidence < 0.75).map(x => x.word.toLowerCase()))].slice(0, 8);
  return { avg, low };
}

// ---------- Calificar ----------
$('tGrade').onclick = async () => {
  const answer = $('tAns').value.trim();
  if (!answer || T.busy) { $('tAns').focus(); return; }
  stopMic();
  T.busy = true; $('tGrade').textContent = 'Calificando…';
  try {
    const pron = T.voice ? pronData() : null;
    const r = await api.trainEvaluate({ cfgT: T.cfg, question: T.current.q, answer, viaVoice: !!pron, pron });
    T.result = { ...r, answer, q: T.current.q, es: T.current.es };
    renderResult(r, !!pron);
  } catch (e) { show('tResult', true); $('tResult').innerHTML = `<div class="card">⚠ ${esc(e.message)}</div>`; }
  T.busy = false; $('tGrade').innerHTML = 'Calificar <kbd>Ctrl+Enter</kbd>';
};

const bar = (label, v) => v == null ? '' : `<div class="bar-row"><span>${label}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, v * 10)}%"></div></div><b>${v}</b></div>`;
function renderResult(r, voice) {
  show('tResult', true);
  $('tResult').innerHTML = `
    <div class="card" style="margin-top:12px">
      <div style="display:flex;gap:16px;align-items:center"><div class="score-big">${r.score}<span style="font-size:18px">/10</span></div>
      <div class="bars" style="flex:1">${bar('Contenido', r.content)}${bar('Claridad', r.clarity)}${bar('Gramática', r.grammar)}${voice ? bar('Pronunciación', r.pronunciation) : ''}</div></div>
      ${voice ? '<div class="hint">La pronunciación es una estimación según qué tan claro entendió tu voz el reconocimiento automático.</div>' : ''}
    </div>
    <div class="card ans" style="margin-top:10px"><div class="label">Respuesta modelo (basada en tu experiencia)</div>
      <div class="r-en small" id="tModel">${esc(r.model_answer || '')}</div>
      <div class="r-es">${esc(r.model_answer_es || '')}</div>
      <div class="row"><button id="tSpeakModel">🔊 Escuchar</button><button id="tCopyModel">Copiar</button></div></div>
    <div class="card" style="margin-top:10px"><div class="label">Mejoras</div>${(r.improvements || []).slice(0, 3).map(x => `<div class="imp">${esc(x)}</div>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button id="tRetry">↻ Reintentar</button>
      <button id="tNext" class="primary">${T.items.length + 1 >= T.cfg.count ? 'Ver resumen' : 'Siguiente pregunta'} <kbd>Ctrl+N</kbd></button></div>`;
  $('tSpeakModel').onclick = () => speak(r.model_answer);
  $('tCopyModel').onclick = () => navigator.clipboard.writeText(r.model_answer || '');
  $('tRetry').onclick = () => { show('tResult', false); $('tAns').value = ''; T.finalText = ''; T.words = []; T.voice = false; $('tAns').focus(); speak(T.current.q); };
  $('tNext').onclick = advance;
  $('tResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function advance() {
  if (!T.result) return;
  T.items.push(T.result); T.result = null;
  if (T.items.length >= T.cfg.count) return finish();
  nextQuestion();
}
$('tEnd').onclick = () => { stopMic(); speechSynthesis.cancel(); if (T.result) T.items.push(T.result); T.result = null; T.items.length ? finish() : backToSetup(); };

async function finish() {
  show('tRun', false); show('tSummary', true);
  const avg = +(T.items.reduce((a, b) => a + (+b.score || 0), 0) / T.items.length).toFixed(1);
  $('tSummary').innerHTML = `<div class="card"><div class="label">Resumen de la sesión</div><div class="score-big">${avg}<span style="font-size:18px">/10</span></div><div id="tSumTxt" class="hint" style="margin-top:8px">Analizando tu sesión…</div></div>`;
  let sum = {};
  try { sum = await api.trainSummary({ cfgT: T.cfg, items: T.items }); } catch {}
  const weak = T.items.filter(x => x.score < 6);
  $('tSummary').innerHTML = `
    <div class="card"><div class="label">Resumen de la sesión · ${esc(T.cfg.role)}</div>
      <div class="score-big">${avg}<span style="font-size:18px">/10</span></div>
      <p>${esc(sum.overall || '')}</p>
      ${(sum.strong_points || []).map(x => `<div class="imp" style="border-color:var(--ok)">✔ ${esc(x)}</div>`).join('')}
      ${(sum.weak_points || []).map(x => `<div class="imp">⚠ ${esc(x)}</div>`).join('')}
    </div>
    <div class="card" style="margin-top:10px"><div class="label">Preguntas</div>
      ${T.items.map((x, i) => `<div class="sess-row"><span>${i + 1}. ${esc(x.q.slice(0, 90))}</span><b style="color:${x.score < 6 ? 'var(--warn)' : 'var(--ok)'}">${x.score}/10</b></div>`).join('')}</div>
    <div class="row" style="margin-top:12px">
      ${weak.length ? `<button id="tRepeat" class="primary">Repetir las ${weak.length} más flojas</button>` : ''}
      <button id="tAgain">Nueva sesión</button></div>`;
  await api.trainProgressAdd({ role: T.cfg.role, level: T.cfg.level, type: T.cfg.type, avg, items: T.items.map(x => ({ q: x.q, score: x.score })) });
  if ($('tRepeat')) $('tRepeat').onclick = () => {
    T.queue = weak.map(x => ({ q: x.q, es: x.es })); T.cfg = { ...T.cfg, count: T.queue.length }; T.items = [];
    show('tSummary', false); show('tRun', true); nextQuestion();
  };
  $('tAgain').onclick = backToSetup;
}
function backToSetup() { show('tRun', false); show('tSummary', false); show('tSetup', true); loadProgress(); }

// ---------- Atajos del menú ----------
addEventListener('keydown', e => {
  if (!$('v-train').classList.contains('active') || $('tRun').classList.contains('hidden')) return;
  if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); toggleMic(); }
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); $('tGrade').click(); }
  if (e.ctrlKey && (e.key === 'n' || e.key === 'N') && T.result) { e.preventDefault(); advance(); }
});

loadProgress();
