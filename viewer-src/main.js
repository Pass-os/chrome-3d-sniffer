import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const q = new URLSearchParams(location.search);
const p = {
  source: q.get('source'), tab: q.get('tab'), frame: q.get('frame') || '0', id: q.get('id'),
  url: q.get('url'), name: q.get('name') || 'modelo', ext: (q.get('ext') || '').toLowerCase()
};
document.title = p.name + ' - 3D Model Sniffer';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; };

// ---------- cena ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(3, 5, 4);
scene.add(dir);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const grid = new THREE.GridHelper(10, 20, 0x666666, 0x333333);
scene.add(grid);
const BG = [0x1b1d21, 0xd8dbe0, 0x000000];
let bgIdx = 0;
scene.background = new THREE.Color(BG[0]);

let model = null, mixer = null, frameBox = null, rawBuffer = null;
const clock = new THREE.Clock();

function resize() {
  const w = innerWidth, h = innerHeight - $('bar').offsetHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  if (mixer) mixer.update(clock.getDelta());
  controls.update();
  renderer.render(scene, camera);
});

function frame() {
  if (!frameBox) return;
  const size = frameBox.getSize(new THREE.Vector3());
  const center = frameBox.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) || 1;
  const dist = r / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.6;
  camera.position.copy(center).add(new THREE.Vector3(0.7, 0.5, 1).normalize().multiplyScalar(dist));
  camera.near = r / 1000;
  camera.far = r * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  grid.scale.setScalar(Math.max(1, r / 5));
  grid.position.set(center.x, frameBox.min.y, center.z);
}

function show(obj, animations) {
  if (model) scene.remove(model);
  model = obj;
  scene.add(model);
  model.updateMatrixWorld(true);
  frameBox = new THREE.Box3().setFromObject(model);
  frame();
  let tris = 0, verts = 0, meshes = 0;
  model.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    meshes++;
    const pos = o.geometry.attributes.position;
    verts += pos ? pos.count : 0;
    tris += o.geometry.index ? o.geometry.index.count / 3 : (pos ? pos.count / 3 : 0);
  });
  const s = frameBox.getSize(new THREE.Vector3());
  $('info').textContent = `${meshes} malhas · ${Math.round(tris).toLocaleString('pt-BR')} triângulos · ${verts.toLocaleString('pt-BR')} vértices · ${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)}`;
  if (animations && animations.length) {
    mixer = new THREE.AnimationMixer(model);
    animations.forEach((a) => mixer.clipAction(a).play());
    $('info').textContent += ` · ${animations.length} animação(ões)`;
  }
  status('');
}

// ---------- obtenção dos bytes ----------
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getBuffer() {
  if (p.source === 'url') {
    status('Baixando…');
    const r = await fetch(p.url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  }
  status('Pedindo o modelo à aba de origem…');
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(+p.tab, { frameId: +p.frame, name: 'm3d-get' });
    const chunks = [];
    let got = 0, done = false;
    port.onMessage.addListener((m) => {
      if (m.error) { done = true; reject(new Error(m.error)); return; }
      const b = b64ToBytes(m.chunk);
      chunks.push(b);
      got += b.length;
      status('Recebendo… ' + (got / 1048576).toFixed(1) + ' MB');
      if (m.last) {
        done = true;
        const all = new Uint8Array(got);
        let o = 0;
        for (const c of chunks) { all.set(c, o); o += c.length; }
        resolve(all.buffer);
      }
    });
    port.onDisconnect.addListener(() => { if (!done) reject(new Error('a aba de origem foi fechada ou recarregada')); });
    port.postMessage({ id: +p.id });
  });
}

// ---------- parsers ----------
const grey = () => new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide });
const text = (buf) => new TextDecoder().decode(buf);

function loadGltf(buf) {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('draco/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return new Promise((res, rej) => loader.parse(buf, '', (g) => res([g.scene, g.animations]), rej));
}

function geometryToMesh(g) {
  g.computeVertexNormals();
  const mat = grey();
  if (g.hasAttribute('color')) mat.vertexColors = true;
  return new THREE.Mesh(g, mat);
}

async function parse(buf, ext) {
  switch (ext) {
    case 'glb': case 'gltf': return loadGltf(buf);
    case 'obj': {
      const o = new OBJLoader().parse(text(buf));
      o.traverse((c) => { if (c.isMesh) c.material = grey(); });
      return [o];
    }
    case 'stl': return [geometryToMesh(new STLLoader().parse(buf))];
    case 'ply': return [geometryToMesh(new PLYLoader().parse(buf))];
    case 'fbx': return [new FBXLoader().parse(buf, ''), []];
    case 'dae': return [new ColladaLoader().parse(text(buf), '').scene];
    case 'drc': {
      const d = new DRACOLoader();
      d.setDecoderPath('draco/');
      const geo = await new Promise((res, rej) => d.parse(buf, res, rej));
      return [geometryToMesh(geo)];
    }
    default: throw new Error('o viewer ainda não abre .' + ext + ' (baixe e abra em outro programa)');
  }
}

// ---------- UI ----------
$('name').textContent = p.name;
$('wire').onclick = () => {
  if (!model) return;
  model.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) m.wireframe = !m.wireframe;
  });
};
$('grid').onclick = () => { grid.visible = !grid.visible; };
$('bg').onclick = () => { bgIdx = (bgIdx + 1) % BG.length; scene.background = new THREE.Color(BG[bgIdx]); };
$('reset').onclick = frame;
$('save').onclick = () => {
  if (!rawBuffer) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rawBuffer]));
  a.download = p.name;
  a.click();
};

(async () => {
  try {
    rawBuffer = await getBuffer();
    status('Interpretando…');
    const ext = p.ext === 'zip' ? 'zip' : p.ext;
    const [obj, anims] = await parse(rawBuffer, ext);
    show(obj, anims);
  } catch (e) {
    status('Erro: ' + (e && e.message ? e.message : e));
    console.error(e);
  }
})();
