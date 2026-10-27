const $ = id => document.getElementById(id);
let st = {}, collapsed = false, prevH = 320;

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = n => String(n).padStart(2, '0');
  return (h ? h + ':' : '') + p(m) + ':' + p(x);
}
function render() {
  $('dot').className = 'dot ' + (st.dotCls || '');
  $('status').textContent = st.status || 'Listo';
  $('label').textContent = st.label || '';
  $('en').textContent = st.en || (st.listening
    ? (st.auto ? 'Escuchando… responderé solo cuando terminen de preguntar.' : 'Escuchando. Cuando te pregunten, pulsa ⚡ Responder (Ctrl+Alt+Espacio).')
    : 'Pulsa ▶ en el panel o Ctrl+Alt+L para empezar.');
  $('es').textContent = st.es || '';
  $('qsum').textContent = st.qsum ? '📝 ' + st.qsum : '';
  $('qsum').style.display = st.qsum ? '' : 'none';
  $('heard').textContent = st.heard || '';
  $('heardBox').style.display = st.heard ? '' : 'none';
  $('heard').scrollTop = 1e6;
  $('aAuto').classList.toggle('on', !!st.auto);
  $('aMode').classList.toggle('on', st.mode === 'tech');
  $('aMode').textContent = st.mode === 'tech' ? '🛠 Técnica ✓' : '🛠 Técnica';
  $('keys').textContent = st.key ? '🔑 ' + st.key : '';
  $('keys').style.display = st.key ? '' : 'none';
  $('aAuto').textContent = st.auto ? 'Auto ✓' : 'Auto';
  $('aToggle').textContent = st.listening ? '⏸' : '▶';
  $('aToggle').title = st.listening ? 'Pausar escucha' : 'Empezar a escuchar';
  document.documentElement.style.setProperty('--fs', (st.fs || 20) + 'px');
  const a = $('answer');
  if (st.stick) a.scrollTop = 0;
}
setInterval(() => {
  $('timer').textContent = st.startedAt && st.listening ? fmt(Date.now() - st.startedAt) : '00:00';
}, 500);

api.onHudState(s => { st = s; render(); });
api.onHudOpacity(v => ($('op').value = Math.round(v * 100)));
api.onHudClickThrough(on => $('ct').classList.toggle('hidden', !on));

// Comandos hacia el panel de control (que tiene la lógica)
const cmd = (type, extra = {}) => api.hudCmd({ type, ...extra });
$('aAnswer').onclick = () => cmd('answer');
$('aShot').onclick = () => cmd('shot');
$('aClear').onclick = () => cmd('clear');
$('aAuto').onclick = () => cmd('auto');
$('aMode').onclick = () => cmd('mode');
$('aToggle').onclick = () => cmd('toggle');
$('aEnd').onclick = () => cmd('end');
$('fsPlus').onclick = () => cmd('font', { delta: 2 });
$('fsMinus').onclick = () => cmd('font', { delta: -2 });
$('btnClose').onclick = () => api.hudHide();
$('op').oninput = () => api.setCfg({ hudOpacity: +$('op').value / 100 });

// Chat: la ventana solo toma el foco cuando haces clic en el campo de texto
const chat = $('chat');
chat.addEventListener('mousedown', () => api.hudFocusable(true));
chat.addEventListener('blur', () => api.hudFocusable(false));
chat.addEventListener('keydown', e => {
  if (e.key === 'Enter' && chat.value.trim()) { cmd('chat', { text: chat.value.trim() }); chat.value = ''; chat.blur(); }
  if (e.key === 'Escape') chat.blur();
});
$('aSend').onclick = () => { if (chat.value.trim()) { cmd('chat', { text: chat.value.trim() }); chat.value = ''; } };

// Minimizar / restaurar
$('btnCollapse').onclick = async () => {
  collapsed = !collapsed;
  document.body.classList.toggle('collapsed', collapsed);
  $('hud').classList.toggle('collapsed', collapsed);
  const b = await api.hudGetBounds();
  if (collapsed) { prevH = b.height; api.hudSetBounds({ height: 38 }); $('btnCollapse').textContent = '▢'; }
  else { api.hudSetBounds({ height: Math.max(prevH, 160) }); $('btnCollapse').textContent = '▁'; }
};

// Cambiar tamaño con el tirador (las ventanas transparentes no se redimensionan solas en Windows)
const grip = $('grip');
grip.addEventListener('pointerdown', async e => {
  grip.setPointerCapture(e.pointerId);
  const b0 = await api.hudGetBounds();
  const x0 = e.screenX, y0 = e.screenY;
  const move = ev => api.hudSetBounds({ width: Math.max(300, b0.width + ev.screenX - x0), height: Math.max(140, b0.height + ev.screenY - y0) });
  const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
});

api.getCfg().then(c => { $('op').value = Math.round((c.hudOpacity || 0.9) * 100); });
render();
