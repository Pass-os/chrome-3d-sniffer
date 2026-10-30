// Native messaging host: recebe { path } da extensão e abre o arquivo no Blender.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BLENDER = 'D:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe';
const IMPORT_SCRIPT = path.join(__dirname, 'import_model.py');
const ALLOWED = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'dae', 'usd', 'usda', 'usdc', 'usdz', 'blend']);

function reply(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

// Blender não lê EXT_meshopt_compression: descomprime com gltf-transform e abre a cópia (.decoded.glb)
function usesMeshopt(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    let json;
    if (head.toString('latin1', 0, 4) === 'glTF') {
      const len = head.readUInt32LE(12);
      json = Buffer.alloc(len);
      fs.readSync(fd, json, 0, len, 20);
    } else {
      json = fs.readFileSync(file);
    }
    fs.closeSync(fd);
    return json.toString('utf8').includes('EXT_meshopt_compression');
  } catch (e) {
    return false;
  }
}

function decodeMeshopt(file) {
  const out = file.replace(/\.(glb|gltf)$/i, '') + '.decoded.glb';
  const cli = path.join(__dirname, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'copy', file, out], { shell: false, stdio: 'ignore', timeout: 120000 });
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

function handle(msg) {
  let file = msg && msg.path;
  if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.existsSync(file)) {
    return reply({ ok: false, error: 'arquivo não encontrado: ' + file });
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!ALLOWED.has(ext)) return reply({ ok: false, error: 'extensão não permitida: ' + ext });
  if (!fs.existsSync(BLENDER)) return reply({ ok: false, error: 'Blender não encontrado em ' + BLENDER });
  if ((ext === 'glb' || ext === 'gltf') && usesMeshopt(file)) {
    const decoded = decodeMeshopt(file);
    if (!decoded) return reply({ ok: false, error: 'falha ao descomprimir Meshopt (npx @gltf-transform/cli)' });
    file = decoded;
  }
  const args = ext === 'blend' ? ['--disable-autoexec', file] : ['--python', IMPORT_SCRIPT, '--', file];
  const child = spawn(BLENDER, args, { detached: true, stdio: 'ignore', shell: false });
  let answered = false;
  const once = (o) => { if (!answered) { answered = true; reply(o); } };
  child.on('error', (e) => once({ ok: false, error: String(e) }));
  child.on('spawn', () => { child.unref(); once({ ok: true, file }); });
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return;
  let msg = null;
  try { msg = JSON.parse(buf.slice(4, 4 + len).toString('utf8')); } catch (e) {}
  handle(msg);
});
