// Documentación de proyectos (escritorio): se guarda en tu cuenta de Replai
async function loadDocs() {
  const list = await api.docsList();
  $('dList').innerHTML = list.length ? list.map(d => `<div class="hist-row" style="display:flex;justify-content:space-between;gap:8px;align-items:center;cursor:default">
    <span>📄 ${esc(d.name)}<br><small style="color:var(--muted)">${d.chunks} fragmento(s) · ${Math.round(d.chars / 1000)}k caracteres</small></span>
    <button class="danger" data-id="${esc(d.id)}" style="padding:4px 9px;font-size:12px">Borrar</button></div>`).join('')
    : '<p class="hint">Aún no hay documentos. Sube los de tus proyectos o descríbelos abajo.</p>';
}
$('dList').onclick = async e => {
  const b = e.target.closest('button[data-id]'); if (!b || !confirm('¿Borrar este documento?')) return;
  await api.docsDelete(b.dataset.id); loadDocs();
};
$('dUpload').onclick = async () => {
  $('dMsg').textContent = 'Elige los archivos…';
  const res = await api.docsUpload();
  if (!res.length) { $('dMsg').textContent = ''; return; }
  $('dMsg').textContent = res.map(r => r.ok ? '✔ ' + r.name + ' (' + r.chunks + ')' : '⚠ ' + r.name + ': ' + r.error).join(' · ');
  loadDocs();
};
$('dSaveNote').onclick = async () => {
  const title = $('dTitle').value.trim() || 'Proyecto', text = $('dNote').value.trim();
  if (text.length < 40) { $('dMsg').textContent = 'Escribe al menos un par de frases sobre el proyecto.'; return; }
  $('dMsg').textContent = 'Guardando…';
  const r = await api.docsNote({ title, text });
  $('dMsg').textContent = r.ok ? '✔ Guardado.' : '⚠ ' + r.error;
  if (r.ok) { $('dTitle').value = ''; $('dNote').value = ''; loadDocs(); }
};
api.onLicense(st => { if (st.ok) loadDocs(); });
api.licenseGet().then(st => { if (st.ok) loadDocs(); });
