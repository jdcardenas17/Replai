// Publica una versión nueva en GitHub Releases. Uso: node publicar.js
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const tokenFile = path.join(__dirname, 'token-github.txt');
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
if (!token || token.startsWith('PEGA_AQUI')) { console.error('Falta el token en token-github.txt'); process.exit(1); }
const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'always'], { stdio: 'inherit', shell: true, env: { ...process.env, GH_TOKEN: token } });
process.exit(r.status || 0);
