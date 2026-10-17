// Menú 2: Leer y responder
const R = { image: null, id: 0, raw: '', text: '', busy: false };

function parseRead(raw) {
  const grab = (a, b) => {
    const i = raw.indexOf(a); if (i < 0) return '';
    const s = i + a.length, e = b ? raw.indexOf(b, s) : -1;
    return raw.slice(s, e < 0 ? undefined : e).trim();
  };
  return { es: grab('---ES---', '---EN---'), en: grab('---EN---', '---ALT---'), alt: grab('---ALT---', null) };
}
function renderRead(r) {
  $('rOut').classList.remove('hidden');
  $('rEs').textContent = r.es; $('rEn').textContent = r.en; $('rAlt').textContent = r.alt;
}
function setImage(img) {
  R.image = img;
  $('rImgBox').classList.toggle('hidden', !img);
  if (img) $('rImg').src = `data:${img.mime};base64,${img.b64}`;
}
function runRead(mode) {
  const text = $('rText').value.trim();
  if (!text && !R.image) { $('rText').focus(); return; }
  const id = ++R.id;
  R.busy = true; R.raw = '';
  $('rGo').textContent = 'Pensando…';
  if (mode === 'initial') $('rOut').classList.add('hidden');
  api.readRun({ id, text, image: R.image, note: $('rNote').value.trim(), mode, prev: mode === 'initial' ? '' : `${$('rEn').textContent}\n${$('rAlt').textContent}` });
}
function resetReadBtn() { R.busy = false; $('rGo').innerHTML = 'Traducir y sugerir respuesta <kbd>Ctrl+Enter</kbd>'; }

api.onReadChunk(({ id, chunk }) => { if (id !== R.id) return; R.raw += chunk; renderRead(parseRead(R.raw)); });
api.onReadDone(async ({ id }) => {
  if (id !== R.id) return;
  resetReadBtn();
  const r = parseRead(R.raw);
  if (!r.en && !r.es) { $('rOut').classList.remove('hidden'); $('rEs').textContent = R.raw || 'Sin respuesta. Pulsa Regenerar.'; return; }
  loadReadHistory(await api.readHistoryAdd({ text: ($('rText').value.trim() || '📷 imagen').slice(0, 300), ...r }));
});
api.onReadError(({ id, error }) => {
  if (id !== R.id) return;
  resetReadBtn();
  $('rOut').classList.remove('hidden'); $('rEs').textContent = '⚠ ' + error; $('rEn').textContent = ''; $('rAlt').textContent = '';
});

function loadReadHistory(list) {
  $('rHist').innerHTML = '';
  (list || []).forEach(h => {
    const d = document.createElement('div');
    d.className = 'hist-row';
    d.innerHTML = `<div style="color:var(--muted)">${esc(h.text.slice(0, 110))}</div><div class="h-en">${esc((h.en || '').slice(0, 120))}</div>`;
    d.onclick = () => { renderRead(h); $('rText').value = h.text.startsWith('📷') ? '' : h.text; };
    $('rHist').appendChild(d);
  });
}

const copyBtn = (btn, getText) => btn.onclick = () => {
  navigator.clipboard.writeText(getText());
  const t = btn.textContent; btn.textContent = '¡Copiado!'; setTimeout(() => (btn.textContent = t), 1100);
};
copyBtn($('rCopyEn'), () => $('rEn').textContent);
copyBtn($('rCopyAlt'), () => $('rAlt').textContent);

$('rGo').onclick = () => runRead('initial');
$('rRegen').onclick = () => runRead('regen');
$('rShort').onclick = () => runRead('shorter');
$('rLong').onclick = () => runRead('longer');
$('rClear').onclick = () => { $('rText').value = ''; $('rNote').value = ''; setImage(null); $('rOut').classList.add('hidden'); };
$('rImgX').onclick = () => setImage(null);
$('rShot').onclick = () => api.regionStart();
$('rPick').onclick = async () => { const i = await api.pickImage(); if (i) setImage(i); };
$('rHistClear').onclick = async () => loadReadHistory(await api.readHistoryClear());

// Pegar una imagen con Ctrl+V
$('v-read').addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const fr = new FileReader();
  fr.onload = () => setImage({ mime: item.type, b64: String(fr.result).split(',')[1] });
  fr.readAsDataURL(item.getAsFile());
});

// Captura de zona (Ctrl+Alt+S): llega la imagen y se traduce sola
api.onShot(img => { showTab('read'); setImage(img); $('rText').value = ''; runRead('initial'); });

// Atajos dentro de este menú
addEventListener('keydown', e => {
  if (!$('v-read').classList.contains('active')) return;
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runRead('initial'); }
  if (e.ctrlKey && (e.key === 'r' || e.key === 'R') && !$('rOut').classList.contains('hidden')) { e.preventDefault(); runRead('regen'); }
});

api.onGoto(name => showTab(name));
api.readHistory().then(loadReadHistory);

// ---------- Leer en voz alta: Replai te escucha y transcribe ----------
const D = { mic: null, finalText: '', base: '' };
async function toggleDictation() { return D.mic ? stopDictation(true) : startDictation(); }
async function startDictation() {
  if (!S.cfg.deepgramKey) { $('rMicSt').textContent = 'Falta la clave de Deepgram (Ajustes).'; return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $('rMicSt').textContent = 'No pude usar el micrófono. Revisa los permisos de Windows.'; return; }
  D.base = $('rText').value.trim(); D.finalText = '';
  setImage(null);
  const ws = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&punctuate=true&interim_results=true', ['token', S.cfg.deepgramKey]);
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  D.mic = { ws, rec, stream };
  const put = interim => { $('rText').value = [D.base, D.finalText.trim(), interim].filter(Boolean).join(' '); };
  ws.onopen = () => { rec.ondataavailable = e => { if (e.data.size && ws.readyState === 1) ws.send(e.data); }; rec.start(150); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'Results') return;
    const t = m.channel?.alternatives?.[0]?.transcript || '';
    if (m.is_final) { if (t) D.finalText += t + ' '; put(''); } else put(t);
  };
  ws.onerror = () => { $('rMicSt').textContent = 'Error de conexión con Deepgram.'; stopDictation(false); };
  $('rMic').classList.add('rec'); $('rMic').innerHTML = '⏹ Listo, traducir <kbd>Ctrl+M</kbd>';
  $('rMicSt').textContent = 'Escuchando… lee el texto en voz alta';
}
function stopDictation(run) {
  const m = D.mic; if (!m) return;
  D.mic = null;
  try { m.rec.state !== 'inactive' && m.rec.stop(); } catch {}
  try { m.stream.getTracks().forEach(t => t.stop()); } catch {}
  $('rMic').classList.remove('rec'); $('rMic').innerHTML = '🎤 Leer en voz alta <kbd>Ctrl+M</kbd>'; $('rMicSt').textContent = '';
  // deja llegar los últimos resultados y luego traduce y responde solo
  setTimeout(() => { try { m.ws.close(); } catch {} if (run && $('rText').value.trim()) runRead('initial'); }, 900);
}
$('rMic').onclick = toggleDictation;
addEventListener('keydown', e => {
  if (!$('v-read').classList.contains('active')) return;
  if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); toggleDictation(); }
});
