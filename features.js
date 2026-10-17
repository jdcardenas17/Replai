// Menú 2 (Leer y responder) y Menú 3 (Entrenamiento): lado principal
const path = require('path');
const fs = require('fs');
const { BrowserWindow, nativeImage } = require('electron');

module.exports = function register(ctx) {
  const { ipcMain, screen, desktopCapturer, dialog, app, readCfg, getProfile, streamClaude, getWin, showControl, isLicensed } = ctx;
  const file = n => path.join(app.getPath('userData'), n);
  const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
  const writeJson = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v, null, 2));

  const BASE = (cfg, profile) => `Eres Replai, el asistente de ${cfg.userName || 'el usuario'}, un profesional hispanohablante que no domina el inglés.

PERFIL DEL USUARIO (única fuente de su experiencia):
${profile?.trim() || '(vacío)'}

REGLAS COMUNES:
- NUNCA inventes experiencia, empresas, cargos, cifras ni títulos que no estén en el perfil. Si falta un dato, usa formulaciones generales y creíbles.
- Inglés simple (nivel B1), frases cortas, fáciles de pronunciar, natural y humano, sin palabras rebuscadas.
- Explicaciones y comentarios para el usuario: en español.`;

  async function collect(args) { let o = ''; for await (const c of streamClaude(args)) o += c; return o.trim(); }
  const parseJson = t => {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Respuesta sin formato válido. Intenta de nuevo.');
    return JSON.parse(m[0]);
  };
  function need() {
    const cfg = readCfg();
    if (!isLicensed()) throw new Error('Licencia inactiva. Activa o renueva tu suscripción en sitiorapido.lat/replai');
    if (!cfg.anthropicKey && !isLicensed()) throw new Error('Falta la clave de Claude (Ajustes).');
    return cfg;
  }
  async function stream(e, prefix, id, args) {
    try {
      for await (const chunk of streamClaude(args)) e.sender.send(`${prefix}:chunk`, { id, chunk });
      e.sender.send(`${prefix}:done`, { id });
    } catch (err) { e.sender.send(`${prefix}:error`, { id, error: String(err.message || err) }); }
  }

  // ---------- MENÚ 2: LEER Y RESPONDER ----------
  ipcMain.handle('read:run', async (e, { id, text, image, note, mode, prev }) => {
    let cfg;
    try { cfg = need(); } catch (err) { return e.sender.send('read:error', { id, error: err.message }); }
    const system = BASE(cfg, getProfile()) + `

TAREA "LEER Y RESPONDER": el usuario leyó algo en inglés (correo, chat, oferta, pregunta escrita; puede venir como texto o como imagen: si es imagen, léela primero). Devuelve EXACTAMENTE este formato, sin nada más:
---ES---
<traducción fiel y natural al español de lo que leyó; si es largo, tradúcelo completo>
---EN---
<respuesta sugerida que el usuario enviaría o diría, en primera persona; corta (2-4 frases) a menos que el texto pida algo más extenso>
---ALT---
<versión alternativa del mismo contenido con otro tono: si la principal es neutral o casual, hazla más formal; si es formal, más casual>

Si el texto no pide respuesta directa (p. ej. una oferta de trabajo), redacta una respuesta breve mostrando interés y mencionando 1 o 2 puntos relevantes del perfil. Si el usuario dejó una instrucción, síguela.`;
    const mod = {
      shorter: '\n\nGenera de nuevo la respuesta (EN y ALT) MÁS CORTA: 1 o 2 frases.',
      longer: '\n\nGenera de nuevo la respuesta (EN y ALT) MÁS DETALLADA: 4 a 6 frases, con datos concretos del perfil.',
      regen: '\n\nGenera una versión DISTINTA a la anterior.',
    }[mode] || '';
    const textPart = (text ? `Texto que leyó el usuario:\n"""\n${text}\n"""` : 'El texto está en la imagen adjunta.') +
      (note ? `\n\nInstrucción del usuario: ${note}` : '') +
      (mod && prev ? `\n\nRespuesta anterior (no la repitas igual):\n${prev}` : '') + mod;
    const content = image
      ? [{ type: 'image', source: { type: 'base64', media_type: image.mime || 'image/png', data: image.b64 } }, { type: 'text', text: textPart }]
      : textPart;
    stream(e, 'read', id, { key: cfg.anthropicKey, model: cfg.model, system, messages: [{ role: 'user', content }], maxTokens: 900 });
  });

  ipcMain.handle('read:history:get', () => readJson('historial-leer.json', []));
  ipcMain.handle('read:history:add', (_e, item) => {
    const h = readJson('historial-leer.json', []);
    h.unshift({ ...item, t: Date.now() });
    writeJson('historial-leer.json', h.slice(0, 20));
    return h.slice(0, 20);
  });
  ipcMain.handle('read:history:clear', () => { writeJson('historial-leer.json', []); return []; });

  ipcMain.handle('read:pickImage', async () => {
    const r = await dialog.showOpenDialog(getWin(), { filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    const f = r.filePaths[0];
    const ext = path.extname(f).toLowerCase();
    return { b64: fs.readFileSync(f).toString('base64'), mime: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
  });

  // Captura de una zona de la pantalla (congela la pantalla, tú seleccionas el área)
  let overlay = null, frozen = null;
  async function startRegionCapture() {
    if (overlay) return;
    const d = screen.getPrimaryDisplay();
    const w = Math.round(d.size.width * d.scaleFactor), h = Math.round(d.size.height * d.scaleFactor);
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    frozen = srcs[0].thumbnail;
    overlay = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setContentProtection(true);
    overlay.loadFile(path.join(__dirname, 'renderer', 'region.html'));
    overlay.on('closed', () => { overlay = null; frozen = null; });
  }
  ipcMain.handle('region:start', () => startRegionCapture());
  ipcMain.handle('region:init', () => (frozen ? frozen.toDataURL() : null));
  ipcMain.handle('region:cancel', () => { overlay?.close(); });
  ipcMain.handle('region:done', (_e, r) => {
    try {
      const d = screen.getPrimaryDisplay();
      const size = frozen.getSize();
      const sx = size.width / d.bounds.width, sy = size.height / d.bounds.height;
      let img = frozen.crop({ x: Math.round(r.x * sx), y: Math.round(r.y * sy), width: Math.max(8, Math.round(r.w * sx)), height: Math.max(8, Math.round(r.h * sy)) });
      const s = img.getSize();
      if (s.width > 1800) img = img.resize({ width: 1800 });
      const out = { b64: img.toPNG().toString('base64'), mime: 'image/png' };
      overlay?.close();
      showControl();
      getWin().webContents.send('shot:result', out);
    } catch { overlay?.close(); }
  });

  // ---------- MENÚ 3: ENTRENAMIENTO ----------
  const LEVEL = { facil: 'fácil (preguntas básicas y directas)', medio: 'medio', dificil: 'difícil (profundas, de diseño, con repreguntas)' };
  const TYPE = { tecnica: 'técnica', conductual: 'conductual (behavioral, método STAR)', mixta: 'mixta (técnica y conductual)' };

  ipcMain.handle('train:question', async (_e, { cfgT, previous }) => {
    const cfg = need();
    const n = previous.length + 1;
    const system = BASE(cfg, getProfile()) + `

Eres un entrevistador de ${cfgT.role}. Nivel: ${LEVEL[cfgT.level]}. Tipo: ${TYPE[cfgT.type]}. Esta es la pregunta ${n} de ${cfgT.count}.
Reglas: hazla en inglés claro y natural (una sola pregunta, sin saludo). Mézclala entre preguntas típicas de entrevista y preguntas basadas en la experiencia real del perfil (empresas, proyectos, tecnologías). ${cfgT.type !== 'tecnica' && n >= cfgT.count - 1 ? 'Si aún no se preguntó, incluye una pregunta sobre expectativas salariales. ' : ''}No repitas las anteriores.
Devuelve SOLO JSON: {"q":"<pregunta en inglés>","es":"<traducción al español>"}`;
    const t = await collect({ key: cfg.anthropicKey, model: cfg.model, system, maxTokens: 300,
      messages: [{ role: 'user', content: previous.length ? `Preguntas ya hechas:\n- ${previous.join('\n- ')}` : 'Primera pregunta.' }] });
    return parseJson(t);
  });

  ipcMain.handle('train:evaluate', async (_e, { cfgT, question, answer, viaVoice, pron }) => {
    const cfg = need();
    const system = BASE(cfg, getProfile()) + `

Eres un coach de entrevistas en inglés. Evalúa la respuesta del usuario a esta pregunta de entrevista de ${cfgT.role} (nivel ${LEVEL[cfgT.level]}, tipo ${TYPE[cfgT.type]}).
${viaVoice ? `La respuesta se dio hablando y se transcribió. Datos de pronunciación (confianza del reconocimiento de voz; es solo una aproximación): promedio ${pron?.avg ?? 'n/d'}%, palabras poco claras: ${(pron?.low || []).join(', ') || 'ninguna'}.` : 'La respuesta fue escrita: pronunciation debe ser null.'}
Califica de 0 a 10 (decimales permitidos): content (¿responde lo que se preguntó y con ejemplos?), clarity (claridad y estructura), grammar (gramática y vocabulario)${viaVoice ? ', pronunciation' : ''} y score (nota global).
"model_answer": respuesta modelo en inglés B1, frases cortas, basada SOLO en la experiencia real del perfil (sin inventar); si el perfil no cubre el tema, usa un ejemplo genérico plausible sin datos falsos específicos. "improvements": máximo 3 mejoras concretas en español, con ejemplo de cómo decirlo.
Devuelve SOLO JSON:
{"score":0,"content":0,"clarity":0,"grammar":0,"pronunciation":${viaVoice ? '0' : 'null'},"model_answer":"","model_answer_es":"","improvements":["","",""]}`;
    const t = await collect({ key: cfg.anthropicKey, model: cfg.model, system, maxTokens: 900,
      messages: [{ role: 'user', content: `Pregunta: ${question}\n\nRespuesta del usuario: ${answer || '(vacía)'}` }] });
    return parseJson(t);
  });

  ipcMain.handle('train:summary', async (_e, { cfgT, items }) => {
    const cfg = need();
    const system = BASE(cfg, getProfile()) + `\n\nResume una sesión de entrenamiento de entrevista. Devuelve SOLO JSON: {"overall":"2-3 frases en español sobre el desempeño","weak_points":["máx. 3 puntos débiles concretos"],"strong_points":["máx. 2"]}`;
    const t = await collect({ key: cfg.anthropicKey, model: cfg.model, system, maxTokens: 500,
      messages: [{ role: 'user', content: items.map((x, i) => `#${i + 1} (${x.score}/10) P: ${x.q}\nMejoras: ${(x.improvements || []).join(' | ')}`).join('\n\n') }] });
    return parseJson(t);
  });

  ipcMain.handle('train:progress:get', () => readJson('entrenamiento.json', []));
  ipcMain.handle('train:progress:add', (_e, s) => {
    const all = readJson('entrenamiento.json', []);
    all.push({ ...s, t: Date.now() });
    writeJson('entrenamiento.json', all.slice(-100));
    return all.slice(-100);
  });

  return { startRegionCapture };
};
