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
