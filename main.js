const { shell, app, BrowserWindow, ipcMain, globalShortcut, session, desktopCapturer, safeStorage, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let win;
let clickThrough = false;
let hidden = false;

// Carpeta de datos fija "Replai"; si venías de versiones anteriores, se migran tus datos (claves, perfil, reuniones)
(() => {
  const root = app.getPath('appData');
  const dest = process.env.REPLAI_DATA || path.join(root, 'Replai');   // REPLAI_DATA: solo para pruebas
  app.setPath('userData', dest);
  try {
    if (!fs.existsSync(path.join(dest, 'config.json'))) {
      for (const old of ['asistente-reuniones', 'Copiloto de Reuniones']) {
        const src = path.join(root, old);
        if (fs.existsSync(path.join(src, 'config.json'))) {
          fs.mkdirSync(dest, { recursive: true });
          for (const f of ['config.json', 'perfil.md']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dest, f));
          if (fs.existsSync(path.join(src, 'reuniones'))) fs.cpSync(path.join(src, 'reuniones'), path.join(dest, 'reuniones'), { recursive: true });
          break;
        }
      }
    }
  } catch {}
})();

// ---------- Licencia (suscripción en sitiorapido.lat) ----------
const LIC_BASE = 'https://sitiorapido.lat/api/replai';
let licensed = false, licReason = 'nokey', licChecked = false;
const DEV_BYPASS = !app.isPackaged && process.env.REPLAI_DEV === '1';   // solo para desarrollo, nunca en la app instalada

async function checkLicense() {
  if (DEV_BYPASS) { licensed = true; return notifyLicense(); }
  const cfg = readCfg();
  if (!cfg.deviceId) { cfg.deviceId = require('crypto').randomUUID(); writeCfg(cfg); }
  if (!cfg.licenseKey) { licensed = false; licReason = 'nokey'; return notifyLicense(); }
  try {
    const res = await fetch(LIC_BASE + '/license', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: cfg.licenseKey, device: cfg.deviceId }),
    });
    const d = await res.json();
    licensed = Boolean(d.ok); licReason = d.ok ? '' : d.reason || 'invalid';
    if (d.ok) { const c = readCfg(); c.licenseOkAt = Date.now(); writeCfg(c); }
  } catch {
    // sin internet: se permite seguir hasta 72 h desde la última verificación
    licensed = Date.now() - (cfg.licenseOkAt || 0) < 72 * 3600 * 1000; licReason = licensed ? '' : 'offline';
  }
  return notifyLicense();
}
function notifyLicense() {
  licChecked = true;
  const st = { ok: licensed, reason: licReason };
  win?.webContents.send('license:status', st);
  return st;
}
ipcMain.handle('license:get', () => ({ ok: licensed, reason: licReason, pending: !licChecked, hasKey: Boolean(readCfg().licenseKey) }));
ipcMain.handle('license:set', async (_e, key) => {
  const c = readCfg(); c.licenseKey = String(key || '').trim().toUpperCase(); writeCfg(c);
  const st = await checkLicense();
  if (st.ok) setupUpdater(true);
  return st;
});

// ---------- Actualizaciones automáticas (desde sitiorapido.lat, solo con licencia) ----------
let updaterStarted = false;
function setupUpdater(force) {
  if (!app.isPackaged) return;
  const cfg = readCfg();
  if (!cfg.licenseKey || (updaterStarted && !force)) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.setFeedURL({ provider: 'generic', url: LIC_BASE + '/updates' });
    autoUpdater.requestHeaders = { 'x-replai-key': cfg.licenseKey, 'x-replai-device': cfg.deviceId };
    if (updaterStarted) { autoUpdater.checkForUpdates().catch(() => {}); return; }
    updaterStarted = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', i => win?.webContents.send('update:status', { state: 'downloading', version: i.version }));
    autoUpdater.on('update-downloaded', i => win?.webContents.send('update:status', { state: 'ready', version: i.version }));
    autoUpdater.on('error', () => {});
    ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  } catch {}
}

// ---------- Almacenamiento local ----------
const dataDir = () => app.getPath('userData');
const cfgPath = () => path.join(dataDir(), 'config.json');
const profilePath = () => path.join(dataDir(), 'perfil.md');
const meetingsDir = () => {
  const d = path.join(dataDir(), 'reuniones');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const DEFAULT_CFG = {
  anthropicKey: '',
  deepgramKey: '',
  model: 'claude-haiku-5-5',   // el más rápido: lo importante en vivo es la velocidad
  auto: false,
  opacity: 0.95,
  wizardDone: false,
  licenseKey: '',
  deviceId: '',
  licenseOkAt: 0,
  workspaceId: '',
  hudOpacity: 0.9,
  hudBounds: null,
  fontSize: 22,
  userName: '',
  lastMeeting: null,
  bounds: null,
};
const SECRET_FIELDS = ['anthropicKey', 'deepgramKey', 'licenseKey'];

function readCfg() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch {}
  const cfg = { ...DEFAULT_CFG, ...raw };
  if (!raw.manualV1) { cfg.auto = false; cfg.manualV1 = true; }   // migración: ahora piensa solo cuando tú pulsas Responder
  if (!raw.speedV2) { cfg.model = DEFAULT_CFG.model; cfg.speedV2 = true; }   // migración única: pasa a modelo rápido
  cfg._raw = {};
  for (const k of SECRET_FIELDS) {
    if (raw[k] && raw[k].startsWith('enc:')) {
      try { cfg[k] = safeStorage.decryptString(Buffer.from(raw[k].slice(4), 'base64')); }
      catch { cfg[k] = ''; cfg._raw[k] = raw[k]; }   // no se pudo descifrar ahora: se conserva tal cual para no borrarla
    }
  }
  return cfg;
}
function writeCfg(cfg) {
  const out = { ...cfg };
  for (const k of SECRET_FIELDS) {
    if (out[k] && safeStorage.isEncryptionAvailable()) {
      out[k] = 'enc:' + safeStorage.encryptString(out[k]).toString('base64');
    } else if (!out[k] && cfg._raw?.[k]) {
      out[k] = cfg._raw[k];
    }
  }
  delete out._raw;
  fs.writeFileSync(cfgPath(), JSON.stringify(out, null, 2));
}

function listMeetings() {
  return fs.readdirSync(meetingsDir())
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(meetingsDir(), f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}
function saveMeeting(m) {
  m.updated = Date.now();
  fs.writeFileSync(path.join(meetingsDir(), m.id + '.json'), JSON.stringify(m, null, 2));
  return m;
}

// ---------- Ventana ----------
function createWindow() {
  const cfg = readCfg();
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  let b = cfg.bounds || { width: 820, height: 700, x: Math.max(0, Math.round((sw - 820) / 2)), y: 40 };
  if (b.width < 720) b = { ...b, width: 820, height: Math.max(b.height, 700) };   // ahora hay barra lateral: ventana más ancha
  win = new BrowserWindow({
    ...b,
    minWidth: 640, minHeight: 480,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,        // no aparece en la barra de tareas al compartir pantalla completa
    backgroundColor: '#0b0d14',
    icon: path.join(__dirname, 'build', 'icon.png'),
    opacity: cfg.opacity,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // CLAVE: excluye la ventana de capturas / transmisión (Zoom, Meet, Teams, OBS...). Tú la ves, los demás no.
  win.setContentProtection(true);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const saveBounds = () => { const c = readCfg(); c.bounds = win.getBounds(); writeCfg(c); };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
}

// ---------- HUD flotante: pequeño, semitransparente, movible, no roba el foco ----------
let hud;
function createHud() {
  const cfg = readCfg();
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const b = cfg.hudBounds || { width: 440, height: 320, x: sw - 470, y: 60 };
  hud = new BrowserWindow({
    ...b,
    minWidth: 300, minHeight: 36,
    frame: false, transparent: true, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true,
    focusable: false,         // no roba el foco: la app de la reunión no detecta que "saliste"
    show: false,
    opacity: cfg.hudOpacity,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  hud.setAlwaysOnTop(true, 'screen-saver');
  hud.setContentProtection(true);   // invisible en pantalla compartida
  hud.setMenuBarVisibility(false);
  hud.loadFile(path.join(__dirname, 'renderer', 'hud.html'));
  const saveHud = () => { if (hud.isMinimized()) return; const c = readCfg(); c.hudBounds = hud.getBounds(); writeCfg(c); };
  hud.on('moved', saveHud);
  hud.on('resized', saveHud);
}
function showHud() { if (!hud.isVisible()) hud.showInactive(); hud.setAlwaysOnTop(true, 'screen-saver'); }
function toggleHud() { hud.isVisible() ? hud.hide() : showHud(); }
function toggleControl() { win.isVisible() ? win.hide() : win.show(); }
function toggleClickThrough() {
  clickThrough = !clickThrough;
  hud.setIgnoreMouseEvents(clickThrough, { forward: true });
  hud.webContents.send('hud:clickthrough', clickThrough);
}
function setOpacity(delta) {
  const c = readCfg();
  c.hudOpacity = Math.min(1, Math.max(0.25, +(c.hudOpacity + delta).toFixed(2)));
  writeCfg(c);
  hud.setOpacity(c.hudOpacity);
  hud.webContents.send('hud:opacity', c.hudOpacity);
}

app.whenReady().then(() => {
  // Captura del audio del sistema (lo que dice el entrevistador) vía loopback de Windows
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      cb({ video: sources[0], audio: 'loopback' });
    } catch { cb({}); }
  }, { useSystemPicker: false });

  createWindow();
  createHud();
  checkLicense().then(() => setupUpdater());
  setInterval(() => checkLicense(), 6 * 3600 * 1000);

  const feats = require('./features')({
    ipcMain, screen, desktopCapturer, dialog, app, readCfg, streamClaude,
    getProfile: () => { try { return fs.readFileSync(profilePath(), 'utf8'); } catch { return ''; } },
    getWin: () => win, isLicensed: () => licensed,
    showControl: () => { win.show(); win.focus(); },
  });
  const goto = name => { win.show(); win.focus(); win.webContents.send('ui:goto', name); };
  globalShortcut.register('Control+Alt+1', () => goto('live'));
  globalShortcut.register('Control+Alt+2', () => goto('read'));
  globalShortcut.register('Control+Alt+3', () => goto('train'));
  globalShortcut.register('Control+Alt+S', () => { feats.startRegionCapture(); });   // capturar zona de pantalla

  globalShortcut.register('Control+Alt+H', toggleHud);                           // ocultar/mostrar HUD
  globalShortcut.register('Control+Alt+P', toggleControl);                       // panel de control
  globalShortcut.register('Control+Alt+Space', () => win.webContents.send('ui:answer-now')); // responder ya
  globalShortcut.register('Control+Alt+C', toggleClickThrough);                  // clic a través
  globalShortcut.register('Control+Alt+Up', () => setOpacity(0.08));
  globalShortcut.register('Control+Alt+Down', () => setOpacity(-0.08));
  globalShortcut.register('Control+Alt+L', () => win.webContents.send('ui:toggle-listen'));
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

// ---------- IPC: configuración, perfil, reuniones ----------
ipcMain.handle('cfg:get', () => readCfg());
ipcMain.handle('cfg:set', (_e, patch) => {
  const c = { ...readCfg(), ...patch };
  writeCfg(c);
  if (patch.opacity) win.setOpacity(c.opacity);
  if (patch.hudOpacity) { hud.setOpacity(c.hudOpacity); hud.webContents.send('hud:opacity', c.hudOpacity); }
  return c;
});

// ---------- IPC: HUD <-> panel de control ----------
ipcMain.on('hud:update', (_e, state) => { if (hud && !hud.isDestroyed()) hud.webContents.send('hud:state', state); });
ipcMain.on('hud:cmd', (_e, cmd) => { win.webContents.send('hud:cmd', cmd); });
ipcMain.handle('hud:show', () => { showHud(); });
ipcMain.handle('hud:hide', () => { hud.hide(); });
ipcMain.handle('hud:focusable', (_e, on) => { hud.setFocusable(on); if (on) hud.focus(); });
ipcMain.handle('hud:setbounds', (_e, b) => { const cur = hud.getBounds(); hud.setBounds({ ...cur, ...b }); });
ipcMain.handle('hud:getbounds', () => hud.getBounds());
ipcMain.handle('control:toggle', () => toggleControl());
ipcMain.handle('control:hide', () => win.hide());
ipcMain.handle('control:show', () => win.show());

async function captureScreen() {
  const d = screen.getPrimaryDisplay();
  const w = Math.min(1920, Math.round(d.size.width * d.scaleFactor));
  const h = Math.round(w * d.size.height / d.size.width);
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
  return srcs[0].thumbnail.toJPEG(72).toString('base64');   // el HUD no sale: está protegido contra capturas
}
ipcMain.handle('profile:get', () => { try { return fs.readFileSync(profilePath(), 'utf8'); } catch { return ''; } });
ipcMain.handle('profile:set', (_e, text) => { fs.writeFileSync(profilePath(), text || ''); return true; });
ipcMain.handle('profile:import', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Hoja de vida', extensions: ['pdf', 'txt', 'md'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  const f = r.filePaths[0];
  if (f.toLowerCase().endsWith('.pdf')) {
    const pdf = require('pdf-parse');
    return (await pdf(fs.readFileSync(f))).text;
  }
  return fs.readFileSync(f, 'utf8');
});
ipcMain.handle('meetings:list', () => listMeetings());
ipcMain.handle('meetings:save', (_e, m) => {
  if (!m.id) { m.id = 'm' + Date.now(); m.created = Date.now(); m.memory = m.memory || ''; m.sessions = m.sessions || 0; }
  return saveMeeting(m);
});
ipcMain.handle('meetings:delete', (_e, id) => { try { fs.unlinkSync(path.join(meetingsDir(), id + '.json')); } catch {} return true; });
ipcMain.handle('app:open', (_e, url) => { if (/^https:\/\/(console\.(anthropic|deepgram)\.com|(www\.)?sitiorapido\.lat)\//.test(url)) shell.openExternal(url); });
ipcMain.handle('app:quit', () => app.quit());
ipcMain.handle('app:minimize', () => win.hide());

// ---------- Claude (streaming) ----------
class Retryable extends Error {}

// Con reintentos automáticos: si Claude tarda, se satura o devuelve vacío, vuelve a intentar solo (hasta 3 veces)
async function* streamClaude(args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), 8000);
    const kick = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), 8000); };
    let got = false;
    try {
      for await (const t of streamClaudeOnce(args, ctrl.signal, kick)) { got = true; yield t; }
      clearTimeout(timer);
      if (got) return;
      throw new Retryable('respuesta vacía');
    } catch (err) {
      clearTimeout(timer);
      // Si el modelo rechaza los ajustes de velocidad, reintenta una vez sin ellos
      if (!args.noTune && !got && /Claude 400/.test(String(err.message)) && /thinking|effort|output_config/i.test(String(err.message))) {
        args = { ...args, noTune: true }; attempt--; continue;
      }
      const transient = err instanceof Retryable || err.name === 'AbortError' || /fetch failed|network|terminated|ECONN|ETIMEDOUT/i.test(String(err.message));
      if (got || !transient || attempt === 2) {
        throw err.name === 'AbortError' ? new Error('Claude tardó demasiado en responder. Pulsa Responder otra vez.') : err;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

// Baja latencia: sin "pensar" largo (esos tokens se comen el límite de la respuesta y dejaban el texto vacío)
function tuning(model) {
  if (/haiku-5-5/.test(model)) return { thinking: { type: 'disabled' }, output_config: { effort: 'low' } };
  if (/sonnet-5-5/.test(model)) return { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } };
  return { output_config: { effort: 'low' } };
}

async function* streamClaudeOnce({ key, model, system, messages, maxTokens, noTune }, signal, kick) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    signal,
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
      ...(readCfg().workspaceId ? { 'anthropic-workspace-id': readCfg().workspaceId.trim() } : {}),
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, stream: true, ...(noTune ? {} : tuning(model)) }),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body).error?.message || msg; } catch {}
    let hint = '';
    if (/workspace/i.test(msg)) hint = 'Tu clave no está ligada a un workspace. Solución fácil: en console.anthropic.com → Settings → API Keys, crea una clave nueva eligiendo el workspace "Default" y pégala en Ajustes. O pega el ID del workspace en Ajustes → ID de workspace.';
    else if (/credit balance/i.test(msg)) hint = 'Tu cuenta de Anthropic no tiene saldo. Entra a console.anthropic.com → Plans & Billing y compra créditos (con USD 5 alcanza para empezar).';
    else if (/model/i.test(msg)) hint = 'El modelo elegido no está disponible para tu cuenta. Cámbialo en Ajustes → Velocidad / calidad.';
    else if (res.status === 401) hint = 'La clave de Claude es incorrecta. Revísala en Ajustes.';
    if ([429, 500, 502, 503, 504, 529].includes(res.status)) throw new Retryable(`Claude ${res.status}: ${msg}`);
    throw new Error(`${hint ? hint + '\n\n' : ''}(Claude ${res.status}: ${msg})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    kick();
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'error') throw new Retryable(ev.error?.message || 'error del servidor');
        if (ev.type === 'content_block_delta' && ev.delta?.text) { yield ev.delta.text; continue; }
      } catch (e) { if (e instanceof Retryable) throw e; }
    }
  }
}

function buildSystem({ profile, meeting, others, userName }) {
  const rules = `Eres Replai, el copiloto de reuniones de ${userName || 'el usuario'}, un profesional hispanohablante que NO habla inglés y asiste a reuniones técnicas y entrevistas en inglés. Escuchas lo que dicen los demás y escribes lo que ${userName || 'el usuario'} debe responder, EN PRIMERA PERSONA, para que lo lea en voz alta.

REGLAS:
- Responde a TODO lo que el interlocutor dijo o preguntó en su turno, no solo a la última frase. Si hizo varias preguntas o planteó varios puntos, contesta cada uno en orden, de forma fluida en un solo bloque corto. Usa también el resto de la conversación para dar una respuesta coherente con lo ya dicho.
- LA LONGITUD DEBE SER PROPORCIONAL A LA PREGUNTA. Responde SOLO lo que se preguntó, nada más. No agregues información que no pidieron, no resumas tu carrera si no te lo piden, no cierres con ofrecimientos ni preguntas.
  · Charla social o saludo ("how are you?", "can you hear me?", "how's your day?"): UNA frase corta de 4 a 12 palabras, p. ej. "I'm doing great, really excited to be here."
  · Pregunta cerrada o simple (sí/no, disponibilidad, datos puntuales): 1 frase, máximo 2.
  · Pregunta abierta de motivación u opinión ("why do you want to work here?", "why this role?", "what do you like about...?"): 2 a 3 frases (~35-50 palabras) con un motivo concreto basado en la empresa/rol del contexto y un toque personal, p. ej. "I like that it's a company focused on X, and honestly, software development is my passion."
  · Pregunta de experiencia o comportamiento: 2 a 3 frases (~35-55 palabras).
  · Preguntas abiertas que piden explicar un proceso, comparar opciones, diseñar algo o "walk me through...": una respuesta un poco más estructurada, con orden claro ("First..., then..., finally..."), 4-6 frases cortas (~70-100 palabras).
  · "Tell me about yourself" y preguntas técnicas profundas: hasta 4-5 frases (~70-90 palabras).
  Ante la duda, más corto. Un poco de calidez humana está bien, pero sin extenderse.
- Apóyate en el perfil del usuario SOLO cuando la pregunta trate de su experiencia, tecnologías o trayectoria: cita 1 o 2 datos concretos y relevantes (empresa, tecnología, años, proyecto) como lo diría quien lo vivió. No recites el CV.
- Suena como una PERSONA real hablando en una reunión, no como un traductor ni un texto escrito: tono relajado y seguro, contracciones (I'm, I've, that's, we're), frases cortas, vocabulario cotidiano. Evita fórmulas rebuscadas o corporativas ("I would be delighted to", "Certainly"). Puedes abrir con una muletilla natural y breve cuando encaje ("Yeah,", "Sure,", "So,", "Honestly,", "Good question,"). Nada de listas ni viñetas. No repitas la pregunta de vuelta. Fácil de leer en voz alta, sin palabras difíciles de pronunciar.
- La traducción al español también debe sonar natural y coloquial, no literal.
- Basa todo en su hoja de vida, el contexto de la reunión y la memoria de reuniones pasadas.
- SIEMPRE da una respuesta coherente y segura. NUNCA digas "I don't know", "I'm not sure", "I haven't worked with that", ni pidas que te expliquen más, ni respondas con una pregunta, ni uses frases de relleno para ganar tiempo. Si el tema no está en el perfil, responde con conocimiento técnico real y correcto: cómo funciona, cómo lo abordarías, qué buenas prácticas aplicarías, y conéctalo con experiencia afín que SÍ aparezca en el perfil. Usa formulaciones generales y creíbles ("in the projects I've worked on", "usually what I do is...") y NO inventes datos específicos verificables que no estén en el perfil (nombres de empresas, cargos, cifras, fechas, títulos, certificaciones).
- Que no se note que es generado por IA: habla como persona normal, con ritmo oral y alguna imperfección leve natural; evita palabras típicas de IA (delve, leverage, robust, seamless, crucial, comprehensive), estructuras demasiado pulidas o simétricas, listas, y cualquier mención a ser un asistente o una IA.
- En reuniones diarias (daily/standup): si preguntan qué hiciste ayer/hoy/bloqueos, usa la memoria de reuniones pasadas y el contexto actual.
- Responde únicamente [NO_RESPONSE] SOLO cuando lo último sea claramente una frase suelta que no espera nada del usuario (p. ej. "okay", "mm-hmm", "thanks", "let me share my screen", ruido o charla entre otras personas). Cualquier pregunta, petición o invitación a hablar ("tell me about yourself", "walk me through...", "describe...", "how are you?", "can you hear me?") SIEMPRE se responde, aunque sea simple o un saludo.
- Solo si la transcripción es totalmente ininteligible (no si el tema es difícil), sugiere: "Sorry, you cut out for a second, could you say that again?"

FORMATO ESTRICTO (sin nada más, en este orden):
<resumen en UNA frase corta en español de lo que te preguntaron o dijeron, p. ej. "Te preguntan si puedes trabajar en horario de EE. UU., 9am–5pm ET">
---EN---
<respuesta en inglés, lo que el usuario dice en voz alta>
---ES---
<traducción natural al español de esa respuesta>`;

  const parts = [rules];
  parts.push(`\n\n=== HOJA DE VIDA / PERFIL DEL USUARIO ===\n${profile?.trim() || '(no cargada)'}`);
  if (meeting) {
    parts.push(`\n\n=== REUNIÓN ACTUAL: ${meeting.name} ===\nContexto dado por el usuario:\n${meeting.context?.trim() || '(sin contexto)'}`);
    parts.push(`\nMemoria acumulada de sesiones anteriores de esta reunión:\n${meeting.memory?.trim() || '(primera sesión)'}`);
  }
  const extra = (others || []).filter(o => o.memory?.trim()).slice(0, 5)
    .map(o => `- ${o.name}: ${o.memory.trim().slice(0, 700)}`).join('\n');
  if (extra) parts.push(`\n\n=== MEMORIA DE OTRAS REUNIONES (referencia) ===\n${extra}`);
  return [{ type: 'text', text: parts.join(''), cache_control: { type: 'ephemeral' } }];
}

ipcMain.handle('ask', async (e, { id, transcript, question, meetingId, extraNote, withScreen, force }) => {
  const cfg = readCfg();
  if (!licensed) { e.sender.send('ask:error', { id, error: 'Licencia inactiva. Activa o renueva tu suscripción en sitiorapido.lat/replai' }); return; }
  if (!cfg.anthropicKey) { e.sender.send('ask:error', { id, error: 'Falta la clave de Anthropic (⚙ Ajustes).' }); return; }
  const profile = (() => { try { return fs.readFileSync(profilePath(), 'utf8'); } catch { return ''; } })();
  const all = listMeetings();
  const meeting = all.find(m => m.id === meetingId);
  const system = buildSystem({ profile, meeting, others: all.filter(m => m.id !== meetingId), userName: cfg.userName });
  const recent = (transcript || []).slice(-40).map(l => `- ${l}`).join('\n');
  const user = `Conversación reciente (la última línea es lo más nuevo; solo se oye a los demás, no al usuario):\n${recent || '(vacía)'}\n\n` +
    (question ? `Lo que dijo el interlocutor en su turno actual (responde a TODO esto, no solo a la última frase):\n"${question}"` : 'Responde a lo que se dijo en el último turno.') +
    (extraNote ? `\n\nNota del usuario: ${extraNote}` : '') +
    (force ? '\n\nEl usuario pidió explícitamente una respuesta: respóndela SIEMPRE, nunca uses [NO_RESPONSE].' : '');
  try {
    let content = user;
    if (withScreen) {
      const img = await captureScreen();
      content = [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } },
        { type: 'text', text: user + '\n\nAdjunto una captura de mi pantalla. Si muestra una pregunta, ejercicio de código o problema, resuélvelo como si lo dijera yo: en el bloque en inglés da el enfoque y, si hace falta, el código corto; en el bloque ES explica en español.' },
      ];
    }
    for await (const chunk of streamClaude({ key: cfg.anthropicKey, model: cfg.model, system, messages: [{ role: 'user', content }], maxTokens: withScreen ? 1100 : 320 })) {
      e.sender.send('ask:chunk', { id, chunk });
    }
    e.sender.send('ask:done', { id });
  } catch (err) {
    e.sender.send('ask:error', { id, error: String(err.message || err) });
  }
});

// Al terminar la reunión: actualiza la memoria acumulada
ipcMain.handle('summarize', async (_e, { meetingId, transcript, qa }) => {
  const cfg = readCfg();
  const meeting = listMeetings().find(m => m.id === meetingId);
  if (!meeting) return { error: 'Reunión no encontrada' };
  if (!cfg.anthropicKey) return { error: 'Falta la clave de Anthropic' };
  if (!transcript?.length) return { memory: meeting.memory };
  const sys = 'Mantienes la memoria de una reunión recurrente para un asistente. Escribe en español, con viñetas cortas. Conserva lo relevante de la memoria previa y fusiona lo nuevo. Máx. ~350 palabras.';
  const user = `MEMORIA PREVIA:\n${meeting.memory || '(ninguna)'}\n\nTRANSCRIPCIÓN DE HOY:\n${transcript.slice(-200).join('\n')}\n\nRESPUESTAS SUGERIDAS/DADAS HOY:\n${(qa || []).map(x => `P: ${x.q}\nR: ${x.a}`).join('\n').slice(0, 6000)}\n\nDevuelve la memoria actualizada con secciones: Temas y decisiones, Tareas/pendientes, Lo que dije/prometí, Términos técnicos y nombres de personas, Estilo/preguntas frecuentes del entrevistador.`;
  try {
    let out = '';
    for await (const c of streamClaude({ key: cfg.anthropicKey, model: cfg.model, system: sys, messages: [{ role: 'user', content: user }], maxTokens: 900 })) out += c;
    meeting.memory = out.trim();
    meeting.sessions = (meeting.sessions || 0) + 1;
    meeting.lastTranscript = transcript.slice(-300);
    saveMeeting(meeting);
    return { memory: meeting.memory };
  } catch (err) { return { error: String(err.message || err) }; }
});
