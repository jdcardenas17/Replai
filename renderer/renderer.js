const $ = id => document.getElementById(id);
const S = {
  cfg: {}, meetings: [], meetingId: null,
  transcript: [], qa: [],
  listening: false, ws: null, rec: null, stream: null, retry: 0,
  buf: '', pending: '', timer: null,
  askId: 0, curQ: '', raw: '', auto: true,
};

// ---------- UI ----------
function setStatus(txt, cls = '') { $('status').textContent = txt; $('dot').className = 'dot ' + cls; }
function esc(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function renderHeard(interim = '') {
  const last = S.transcript.slice(-4).map(esc).join('<br>');
  $('heardText').innerHTML = (last + (interim ? `<br><span class="interim">${esc(interim)}</span>` : '')) || '—';
  $('heardText').scrollTop = 1e6;
}
function renderHistory() {
  $('histList').innerHTML = '';
  [...S.qa].reverse().forEach(x => {
    const d = document.createElement('div');
    d.className = 'hist-item';
    d.innerHTML = `<div class="q">${esc(x.q)}</div><div class="a">${esc(x.en)}</div>`;
    d.onclick = () => showAnswer(x.en, x.es);
    $('histList').appendChild(d);
  });
}
function showAnswer(en, es) { $('en').textContent = en; $('es').textContent = es || ''; }
function applyFont() { document.documentElement.style.setProperty('--fs', (S.cfg.fontSize || 22) + 'px'); }
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + name));
}
document.querySelectorAll('.tab').forEach(t => t.onclick = async () => { await saveMeetingFromForm(); showTab(t.dataset.tab); });
document.querySelectorAll('[data-open]').forEach(a => a.onclick = e => { e.preventDefault(); api.openExternal(a.dataset.open); });

// ---------- Claude ----------
function ask(question, note, withScreen, force) {
  const q = (question || '').trim();
  if (!q && !S.transcript.length && !withScreen) return;
  const id = ++S.askId;
  S.curQ = q || (withScreen ? '📷 Captura de pantalla' : S.transcript.slice(-1)[0] || '');
  S.raw = ''; S.qsum = '';
  $('answerLabel').textContent = 'Pensando…';
  setStatus('Pensando…', 'busy');
  api.ask({ id, transcript: S.transcript, question: q, meetingId: S.meetingId, extraNote: note, withScreen, force });
}
function parseAnswer(raw, final = false) {
  let q = '', rest = raw;
  if (raw.includes('---EN---')) { const i = raw.indexOf('---EN---'); q = raw.slice(0, i); rest = raw.slice(i + 8); }
  else if (!final) { return { q: raw.trim(), en: '', es: '' }; }      // aún llega el resumen
  const [en, es] = rest.split('---ES---');
  return { q: q.trim(), en: (en || '').trim(), es: (es || '').trim() };
}
const idleStatus = () => setStatus(S.listening ? 'Escuchando' : 'Listo', S.listening ? 'on' : '');

api.onChunk(({ id, chunk }) => {
  if (id !== S.askId) return;
  S.raw += chunk;
  const t = S.raw.trim();
  if ('[NO_RESPONSE]'.startsWith(t) || t.startsWith('[NO_RESPONSE]')) return;
  const { q, en, es } = parseAnswer(S.raw);
  S.qsum = q;
  showAnswer(en, es);
  $('answerLabel').textContent = 'Respuesta sugerida';
});
api.onDone(({ id }) => {
  if (id !== S.askId) return;
  idleStatus();
  if (!S.raw.trim()) { $('answerLabel').textContent = 'Sin respuesta · pulsa Responder otra vez'; return; }
  if (S.raw.trim().startsWith('[NO_RESPONSE]')) { $('answerLabel').textContent = 'No detecté pregunta en lo último · pulsa Responder si quieres respuesta'; return; }
  const { q, en, es } = parseAnswer(S.raw, true);
  S.qsum = q;
  if (!S.raw.includes('---EN---')) showAnswer(en, es);
  S.qa.push({ q: q || S.curQ, en, es, a: en });
  renderHistory();
});
api.onError(({ id, error }) => {
  if (id !== S.askId) return;
  $('answerLabel').textContent = 'Error';
  showAnswer('⚠ ' + error, '');
  idleStatus();
});

// ---------- Transcripción en vivo ----------
function flushUtterance() {
  const text = S.buf.trim();
  S.buf = '';
  if (!text) return;
  S.transcript.push(text);
  // "Turno" = todo lo que dice el otro seguido; tras >8 s de silencio empieza un turno nuevo
  if (Date.now() - (S.lastUtter || 0) > 8000) S.pending = '';
  S.lastUtter = Date.now();
  S.pending = (S.pending + ' ' + text).trim();
  renderHeard();
  if (!S.auto) return;
  clearTimeout(S.timer);
  // Si terminó con "?" respondemos de inmediato; si no, esperamos un instante por si sigue hablando
  const delay = /[?]\s*$/.test(S.pending) ? 0 : 450;
  S.timer = setTimeout(() => {
    const q = S.pending;   // se conserva: si siguen hablando, la siguiente respuesta cubre todo el turno
    if (q.split(/\s+/).length >= 3) ask(q);
  }, delay);
}

function connectDeepgram() {
  const url = 'wss://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&punctuate=true' +
    '&interim_results=true&endpointing=250&utterance_end_ms=1000&vad_events=true';
  const ws = new WebSocket(url, ['token', S.cfg.deepgramKey]);
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    setStatus('Escuchando', 'on');
    S.rec = new MediaRecorder(S.stream, { mimeType: 'audio/webm;codecs=opus' });
    S.rec.ondataavailable = e => { if (e.data.size && ws.readyState === 1) ws.send(e.data); };
    S.rec.start(100);
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'Results') {
      const t = m.channel?.alternatives?.[0]?.transcript || '';
      S.interim = m.is_final ? '' : t;
      if (m.is_final) {
        if (t) S.buf += ' ' + t;
        renderHeard();
        if (m.speech_final) flushUtterance();
      } else renderHeard((S.buf + ' ' + t).trim());
    } else if (m.type === 'UtteranceEnd') flushUtterance();
  };
  ws.onclose = () => {
    try { S.rec && S.rec.state !== 'inactive' && S.rec.stop(); } catch {}
    if (S.listening && S.retry++ < 5) { setStatus('Reconectando…', 'busy'); setTimeout(connectDeepgram, 1000); }
    else if (S.listening) { stopListening(); setStatus('Conexión perdida'); }
  };
}

async function startListening() {
  if (!S.cfg.deepgramKey || !S.cfg.anthropicKey) { showTab('settings'); setStatus('Faltan las claves'); return; }
  await saveMeetingFromForm();
  try {
    const st = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    st.getVideoTracks().forEach(t => { t.stop(); st.removeTrack(t); });
    if (!st.getAudioTracks().length) throw new Error('sin audio del sistema');
    S.stream = st;
  } catch (e) { setStatus('No pude capturar el audio'); return; }
  S.listening = true;
  if (!S.startedAt) S.startedAt = Date.now();
  api.hudShow(); api.controlHide();   // el HUD flotante toma el relevo; Ctrl+Alt+P vuelve al panel
  $('startCard').classList.add('running');
  $('btnListen').classList.add('stop');
  $('btnListenTxt').textContent = 'Detener';
  connectDeepgram();
}
function stopListening() {
  S.listening = false;
  clearTimeout(S.timer);
  try { S.rec && S.rec.state !== 'inactive' && S.rec.stop(); } catch {}
  try { S.ws && S.ws.close(); } catch {}
  try { S.stream && S.stream.getTracks().forEach(t => t.stop()); } catch {}
  S.stream = null;
  $('startCard').classList.remove('running');
  $('btnListen').classList.remove('stop');
  $('btnListenTxt').textContent = 'Empezar a escuchar';
  setStatus('Listo');
}
const toggleListen = () => (S.listening ? stopListening() : startListening());

// ---------- Reuniones ----------
const currentMeeting = () => S.meetings.find(m => m.id === S.meetingId);
function fillMeetingForm() {
  const m = currentMeeting() || {};
  $('mName').value = m.name || ''; $('mContext').value = m.context || ''; $('mMemory').value = m.memory || '';
  $('liveMeetingName').textContent = m.name || '—';
}
function renderMeetingSel() {
  $('meetingSel').innerHTML = S.meetings.map(m => `<option value="${m.id}">${esc(m.name || 'Sin nombre')}${m.sessions ? ` · ${m.sessions} sesiones` : ''}</option>`).join('');
  if (S.meetingId) $('meetingSel').value = S.meetingId;
}
async function reloadMeetings() { S.meetings = await api.listMeetings(); renderMeetingSel(); }
async function saveMeetingFromForm() {
  const m = currentMeeting();
  if (!m || $('v-meetings').offsetParent === null && !S._formDirty) return;
  m.name = $('mName').value.trim() || m.name; m.context = $('mContext').value; m.memory = $('mMemory').value;
  await api.saveMeeting(m);
  await reloadMeetings();
  $('liveMeetingName').textContent = m.name;
}
['mName', 'mContext', 'mMemory'].forEach(id => $(id).addEventListener('input', () => (S._formDirty = true)));
async function newMeeting(name = 'Nueva reunión', context = '') {
  const m = await api.saveMeeting({ name, context });
  S.meetingId = m.id; await api.setCfg({ lastMeeting: m.id });
  await reloadMeetings(); fillMeetingForm();
}

// ---------- Eventos ----------
$('btnListen').onclick = toggleListen;
$('autoSw').onchange = () => { S.auto = $('autoSw').checked; api.setCfg({ auto: S.auto }); };
$('btnHide').onclick = () => api.minimize();
$('btnQuit').onclick = () => api.quit();
$('btnCopy').onclick = () => { navigator.clipboard.writeText($('en').textContent); $('btnCopy').textContent = '¡Copiado!'; setTimeout(() => $('btnCopy').textContent = 'Copiar', 1200); };
$('btnAsk').onclick = submitManual;
$('manual').addEventListener('keydown', e => { if (e.key === 'Enter') submitManual(); });
function submitManual() {
  const v = $('manual').value.trim();
  if (!v) return answerNow();
  S.transcript.push(v); renderHeard(); $('manual').value = ''; ask(v, '', false, true);
}
function answerNow() {
  clearTimeout(S.timer);
  // Todo lo que se dijo desde la última vez que pulsaste Responder (incluye lo que aún se está transcribiendo)
  const tail = (S.buf + ' ' + (S.interim || '')).trim();
  S.buf = ''; S.interim = '';
  if (tail) S.transcript.push(tail);
  let lines = S.transcript.slice(S.mark || 0);
  if (!lines.length) lines = S.transcript.slice(-3);
  S.mark = S.transcript.length;
  S.pending = '';
  renderHeard();
  ask(lines.join(' ').slice(-1500), '', false, true);
}
api.onAnswerNow(answerNow);
api.onToggleListen(toggleListen);
api.onClickThrough(on => {
  let b = document.querySelector('.ct-banner');
  if (on && !b) { b = document.createElement('div'); b.className = 'ct-banner'; b.textContent = 'Clic a través activo · Ctrl+Alt+C para volver'; document.body.appendChild(b); }
  if (!on && b) b.remove();
});

$('meetingSel').onchange = async () => {
  S._formDirty = true; await saveMeetingFromForm(); S._formDirty = false;
  S.meetingId = $('meetingSel').value; await api.setCfg({ lastMeeting: S.meetingId });
  S.transcript = []; S.qa = []; renderHeard(); renderHistory(); fillMeetingForm();
};
$('btnNewMeeting').onclick = async () => { S._formDirty = true; await saveMeetingFromForm(); await newMeeting(); $('mName').focus(); $('mName').select(); };
$('btnDelMeeting').onclick = async () => {
  if (!confirm('¿Borrar esta reunión y su memoria?')) return;
  await api.deleteMeeting(S.meetingId);
  await reloadMeetings();
  if (!S.meetings.length) await newMeeting('Mi primera reunión');
  S.meetingId = S.meetings[0].id; renderMeetingSel(); fillMeetingForm();
};
$('btnSaveMeeting').onclick = async () => { S._formDirty = true; await saveMeetingFromForm(); S._formDirty = false; setStatus('Reunión guardada'); };
$('btnFinish').onclick = async () => {
  S._formDirty = true; await saveMeetingFromForm();
  if (S.listening) stopListening();
  setStatus('Guardando memoria…', 'busy');
  const r = await api.summarize({ meetingId: S.meetingId, transcript: S.transcript, qa: S.qa });
  if (r.error) { setStatus('Error: ' + r.error.slice(0, 60)); return; }
  await reloadMeetings(); fillMeetingForm();
  S.transcript = []; S.qa = []; renderHeard(); renderHistory();
  setStatus('Memoria actualizada ✔');
};
$('btnImport').onclick = async () => { const t = await api.importProfile(); if (t) $('profile').value = t; };
$('btnSaveProfile').onclick = async () => { await api.setProfile($('profile').value); setStatus('Perfil guardado ✔'); };
$('fontSize').oninput = () => { $('fsVal').textContent = $('fontSize').value; S.cfg.fontSize = +$('fontSize').value; applyFont(); };
$('opacity').oninput = () => api.setCfg({ opacity: +$('opacity').value / 100 });
$('btnSaveCfg').onclick = async () => {
  S.cfg = await api.setCfg({
    userName: $('userName').value.trim(), anthropicKey: $('anthropicKey').value.trim(),
    deepgramKey: $('deepgramKey').value.trim(), model: $('model').value, workspaceId: $('workspaceId').value.trim(), fontSize: +$('fontSize').value,
  });
  setStatus('Ajustes guardados ✔');
};

// ---------- Asistente de primer uso ----------
let wStep = 1;
function wizShow() {
  document.querySelectorAll('.wstep').forEach(s => s.classList.toggle('hidden', +s.dataset.step !== wStep));
  document.querySelectorAll('.steps i').forEach((i, idx) => i.classList.toggle('on', idx < wStep));
  $('wBack').style.visibility = wStep === 1 ? 'hidden' : 'visible';
  $('wNext').textContent = wStep === 3 ? 'Terminar ✔' : 'Siguiente';
}
$('wBack').onclick = () => { wStep--; wizShow(); };
$('wImport').onclick = async () => { const t = await api.importProfile(); if (t) $('wProfile').value = t; };
$('wNext').onclick = async () => {
  if (wStep === 1) {
    if (!$('wAnthropic').value.trim() || !$('wDeepgram').value.trim()) { $('wAnthropic').focus(); return; }
    S.cfg = await api.setCfg({ anthropicKey: $('wAnthropic').value.trim(), deepgramKey: $('wDeepgram').value.trim(), userName: $('wName').value.trim() });
  }
  if (wStep === 2) await api.setProfile($('wProfile').value);
  if (wStep === 3) {
    const m = currentMeeting();
    m.name = $('wMeet').value.trim() || 'Mi primera reunión'; m.context = $('wCtx').value;
    await api.saveMeeting(m);
    await api.setCfg({ wizardDone: true });
    $('wizard').classList.add('hidden');
    await init();
    return;
  }
  wStep++; wizShow();
};

async function init() {
  S.cfg = await api.getCfg();
  S.auto = S.cfg.auto; $('autoSw').checked = S.auto; applyFont();
  ['userName', 'anthropicKey', 'deepgramKey', 'model', 'workspaceId'].forEach(k => $(k).value = S.cfg[k] || '');
  $('fontSize').value = S.cfg.fontSize; $('fsVal').textContent = S.cfg.fontSize;
  $('opacity').value = Math.round(S.cfg.opacity * 100);
  $('profile').value = await api.getProfile();
  S.meetings = await api.listMeetings();
  if (!S.meetings.length) { await newMeeting('Mi primera reunión'); S.meetings = await api.listMeetings(); }
  S.meetingId = (S.meetings.find(m => m.id === S.cfg.lastMeeting) || S.meetings[0]).id;
  renderMeetingSel(); fillMeetingForm();
  if (!S.cfg.wizardDone && !S.cfg.anthropicKey) { $('wizard').classList.remove('hidden'); wizShow(); }
}
// ---------- Actualizaciones ----------
api.onUpdate(u => {
  $('updateBar').classList.remove('hidden');
  const ready = u.state === 'ready';
  $('updateTxt').textContent = ready ? `Versión ${u.version} lista` : `Descargando versión ${u.version}…`;
  $('btnUpdate').style.display = ready ? '' : 'none';
});
$('btnUpdate').onclick = () => api.installUpdate();

// ---------- HUD flotante ----------
let lastHud = '';
setInterval(() => {
  const s = {
    listening: S.listening, auto: S.auto, startedAt: S.startedAt,
    status: $('status').textContent, dotCls: $('dot').className.replace('dot', '').trim(),
    qsum: S.qsum || '', label: $('answerLabel').textContent, en: $('en').textContent, es: $('es').textContent,
    heard: S.transcript.slice(-4).concat($('heardText').querySelector('.interim')?.textContent || []).join('\n').slice(-600),
    fs: S.cfg.fontSize || 22,
  };
  const j = JSON.stringify(s);
  if (j !== lastHud) { lastHud = j; api.hudUpdate(s); }
}, 150);

function clearAnswer() {
  // Limpiar borra también lo que se había escuchado, para que voces de fondo no se mezclen con la próxima pregunta
  S.askId++; S.pending = ''; S.buf = ''; S.interim = ''; S.transcript = []; S.mark = 0; S.qsum = '';
  renderHeard();
  showAnswer('', ''); $('answerLabel').textContent = 'Respuesta sugerida';
  idleStatus();
}
api.onHudCmd(async c => {
  switch (c.type) {
    case 'answer': return answerNow();
    case 'shot': return ask('', '', true);
    case 'clear': return clearAnswer();
    case 'auto': $('autoSw').checked = !$('autoSw').checked; return $('autoSw').onchange();
    case 'toggle': return toggleListen();
    case 'chat': S.transcript.push(c.text); renderHeard(); return ask(c.text, '', false, true);
    case 'font':
      S.cfg.fontSize = Math.min(40, Math.max(12, (S.cfg.fontSize || 22) + c.delta));
      $('fontSize').value = S.cfg.fontSize; $('fsVal').textContent = S.cfg.fontSize;
      applyFont(); return api.setCfg({ fontSize: S.cfg.fontSize });
    case 'end':
      await $('btnFinish').onclick();
      S.startedAt = null;
      return api.controlShow();
  }
});

init();
