// Gerador de GLB (puro) + exportador de cena three.js. Roda no contexto da página.
(() => {
  const api = window.__m3dApi || (window.__m3dApi = {});

  const align4 = (n) => (n + 3) & ~3;

  // model: { meshes: [{ name, pos, nor?, uv?, col?, colSize?, prims: [{ idx, mat }] }],
  //          materials: [{ name, color, metallic, roughness, emissive?, alphaMode?, alphaCutoff?, doubleSided?, tex? }],
  //          images: [Uint8Array(png)] }   tex = { image, wrapS, wrapT }
  function buildGLB(model) {
    const parts = [];
    let offset = 0;
    const views = [], accessors = [];

    function addView(u8, target) {
      const pad = align4(offset) - offset;
      if (pad) { parts.push(new Uint8Array(pad)); offset += pad; }
      const v = { buffer: 0, byteOffset: offset, byteLength: u8.byteLength };
      if (target) v.target = target;
      views.push(v);
      parts.push(u8);
      offset += u8.byteLength;
      return views.length - 1;
    }
    function addAcc(arr, type, componentType, count, target, minmax) {
      const bv = addView(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), target);
      const a = { bufferView: bv, componentType, count, type };
      if (minmax) { a.min = minmax.min; a.max = minmax.max; }
      accessors.push(a);
      return accessors.length - 1;
    }

    const images = model.images.map((png) => ({ bufferView: addView(png), mimeType: 'image/png' }));
    const textures = [], samplers = [], texKey = new Map();
    function texIndex(t) {
      const key = t.image + '|' + t.wrapS + '|' + t.wrapT;
      if (texKey.has(key)) return texKey.get(key);
      samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: t.wrapS, wrapT: t.wrapT });
      textures.push({ source: t.image, sampler: samplers.length - 1 });
      texKey.set(key, textures.length - 1);
      return textures.length - 1;
    }

    const materials = model.materials.map((m) => {
      const pbr = {
        baseColorFactor: m.color,
        metallicFactor: m.metallic,
        roughnessFactor: m.roughness
      };
      if (m.tex) pbr.baseColorTexture = { index: texIndex(m.tex) };
      if (m.mrTex) pbr.metallicRoughnessTexture = { index: texIndex(m.mrTex) };
      const out = { name: m.name, pbrMetallicRoughness: pbr, doubleSided: !!m.doubleSided };
      if (m.normalTex) out.normalTexture = { index: texIndex(m.normalTex), scale: m.normalScale != null ? m.normalScale : 1 };
      if (m.aoTex) out.occlusionTexture = { index: texIndex(m.aoTex) };
      if (m.emissiveTex) out.emissiveTexture = { index: texIndex(m.emissiveTex) };
      if (m.alphaMode && m.alphaMode !== 'OPAQUE') out.alphaMode = m.alphaMode;
      if (m.alphaMode === 'MASK') out.alphaCutoff = m.alphaCutoff;
      if (m.emissive && (m.emissive[0] || m.emissive[1] || m.emissive[2])) out.emissiveFactor = m.emissive;
      return out;
    });

    const meshes = [], nodes = [];
    for (const m of model.meshes) {
      const n = m.pos.length / 3;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) {
          if (!Number.isFinite(m.pos[i * 3 + c])) m.pos[i * 3 + c] = 0;
          const v = m.pos[i * 3 + c];
          if (v < min[c]) min[c] = v;
          if (v > max[c]) max[c] = v;
        }
      }
      const attributes = { POSITION: addAcc(m.pos, 'VEC3', 5126, n, 34962, { min, max }) };
      if (m.nor) attributes.NORMAL = addAcc(m.nor, 'VEC3', 5126, n, 34962);
      if (m.uv) attributes.TEXCOORD_0 = addAcc(m.uv, 'VEC2', 5126, n, 34962);
      if (m.col) attributes.COLOR_0 = addAcc(m.col, m.colSize === 4 ? 'VEC4' : 'VEC3', 5126, n, 34962);
      const primitives = m.prims.map((p) => {
        const prim = { attributes, indices: addAcc(p.idx, 'SCALAR', 5125, p.idx.length, 34963), mode: 4 };
        if (p.mat != null && p.mat >= 0) prim.material = p.mat;
        return prim;
      });
      meshes.push({ name: m.name, primitives });
    }
    if (model.nodes) {
      for (const nd of model.nodes) {
        const node = { name: nd.name, mesh: nd.mesh };
        const mt = nd.matrix;
        const identity = !mt || mt.every((v, i) => v === ((i % 5 === 0) ? 1 : 0));
        if (!identity && mt.every(Number.isFinite)) node.matrix = Array.from(mt);
        nodes.push(node);
      }
    } else {
      meshes.forEach((m, i) => nodes.push({ name: m.name, mesh: i }));
    }

    const binLen = align4(offset);
    if (binLen > offset) parts.push(new Uint8Array(binLen - offset));

    const json = {
      asset: { version: '2.0', generator: '3D Model Sniffer' },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      nodes,
      meshes,
      accessors,
      bufferViews: views,
      buffers: [{ byteLength: binLen }]
    };
    if (materials.length) json.materials = materials;
    if (images.length) json.images = images;
    if (textures.length) { json.textures = textures; json.samplers = samplers; }

    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLen = align4(jsonBytes.length);
    const jsonPadded = new Uint8Array(jsonLen).fill(0x20);
    jsonPadded.set(jsonBytes);

    const header = new DataView(new ArrayBuffer(12 + 8));
    header.setUint32(0, 0x46546c67, true);
    header.setUint32(4, 2, true);
    header.setUint32(8, 12 + 8 + jsonLen + 8 + binLen, true);
    header.setUint32(12, jsonLen, true);
    header.setUint32(16, 0x4e4f534a, true);
    const binHeader = new DataView(new ArrayBuffer(8));
    binHeader.setUint32(0, binLen, true);
    binHeader.setUint32(4, 0x004e4942, true);

    return new Blob([header, jsonPadded, binHeader, ...parts], { type: 'model/gltf-binary' });
  }

  // ---- matrizes 4x4 em coluna-maior
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  // inversa transposta do bloco 3x3 + determinante (para normais e espelhamento)
  function normalMatrix(m) {
    const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det) return { n: [1, 0, 0, 0, 1, 0, 0, 0, 1], det: 1 };
    const k = 1 / det;
    // cofatores / det = inversa transposta
    return {
      n: [A * k, B * k, C * k,
        (c * h - b * i) * k, (a * i - c * g) * k, (b * g - a * h) * k,
        (b * f - c * e) * k, (c * d - a * f) * k, (a * e - b * d) * k],
      det
    };
  }

  const WRAP = { 1000: 10497, 1001: 33071, 1002: 33648 };

  async function imageToPng(img) {
    if (!img) return null;
    const c = document.createElement('canvas');
    let w, h;
    if (img.data && img.width && img.height) {
      w = img.width; h = img.height;
      if (!(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) || img.data.length !== w * h * 4) return null;
      c.width = w; c.height = h;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), w, h), 0, 0);
    } else {
      w = img.naturalWidth || img.videoWidth || img.displayWidth || img.width;
      h = img.naturalHeight || img.videoHeight || img.displayHeight || img.height;
      if (!w || !h) return null;
      const s = Math.min(1, 4096 / Math.max(w, h));
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    }
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  async function exportThree(scene) {
    scene.updateMatrixWorld(true);
    const objs = [];
    scene.traverseVisible((o) => {
      if ((o.isMesh || o.isInstancedMesh) && o.geometry && o.geometry.attributes && o.geometry.attributes.position) objs.push(o);
    });

    const model = { meshes: [], nodes: [], materials: [], images: [] };
    const matIdx = new Map(), imgIdx = new Map(), meshCache = new Map();
    let totalVerts = 0, lastYield = 0;
    const MAX_NODES = 200000;

    async function imageIndex(img) {
      if (imgIdx.has(img)) return imgIdx.get(img);
      let png = null;
      try { png = await imageToPng(img); } catch (e) { /* canvas "tainted" (cross-origin) */ }
      let idx = -1;
      if (png) { model.images.push(png); idx = model.images.length - 1; }
      imgIdx.set(img, idx);
      return idx;
    }

    async function materialIndex(mat) {
      if (!mat) return -1;
      if (matIdx.has(mat)) return matIdx.get(mat);
      const col = mat.color ? [mat.color.r, mat.color.g, mat.color.b] : [0.8, 0.8, 0.8];
      const m = {
        name: mat.name || mat.type || 'material',
        color: [col[0], col[1], col[2], mat.opacity != null ? mat.opacity : 1],
        metallic: mat.metalness != null ? mat.metalness : 0,
        roughness: mat.roughness != null ? mat.roughness : 1,
        alphaMode: mat.transparent ? 'BLEND' : (mat.alphaTest > 0 ? 'MASK' : 'OPAQUE'),
        alphaCutoff: mat.alphaTest || 0.5,
        doubleSided: mat.side === 2
      };
      if (mat.emissive) {
        const k = Math.min(1, mat.emissiveIntensity != null ? mat.emissiveIntensity : 1);
        m.emissive = [mat.emissive.r * k, mat.emissive.g * k, mat.emissive.b * k];
      }
      const texOf = async (map) => {
        if (!map || !map.image) return null;
        const image = await imageIndex(map.image);
        return image >= 0 ? { image, wrapS: WRAP[map.wrapS] || 10497, wrapT: WRAP[map.wrapT] || 10497 } : null;
      };
      m.tex = await texOf(mat.map);
      m.normalTex = await texOf(mat.normalMap);
      if (m.normalTex && mat.normalScale) m.normalScale = mat.normalScale.x;
      m.aoTex = await texOf(mat.aoMap);
      m.emissiveTex = await texOf(mat.emissiveMap);
      m.mrTex = await texOf(mat.metalnessMap || mat.roughnessMap);
      // sem mapa de emissão o fator branco do three vira "tudo brilha": só vale o fator se o mapa existir ou for realmente colorido
      if (mat.emissiveMap && !m.emissiveTex) m.emissive = null;
      model.materials.push(m);
      matIdx.set(mat, model.materials.length - 1);
      return model.materials.length - 1;
    }

    const isDeformed = (o) => !!(o.isSkinnedMesh || (o.geometry.morphAttributes && o.geometry.morphAttributes.position && o.geometry.morphAttributes.position.length));

    // vértices em espaço LOCAL; a matriz do objeto vai no node (o glTF cuida de escala negativa)
    async function buildMesh(o, mats, flipV) {
      const g = o.geometry, p = g.attributes.position;
      const n = p.count;
      const deformed = isDeformed(o);
      const pos = new Float32Array(n * 3);
      if (deformed && (o.getVertexPosition || o.boneTransform)) {
        // pose atual (skin + morph); precisa de um Vector3 do three, tirado de matrixWorld.constructor não existe, então usa position
        const v = o.position.clone();
        for (let i = 0; i < n; i++) {
          if (o.getVertexPosition) o.getVertexPosition(i, v);
          else { v.fromBufferAttribute(p, i); o.boneTransform(i, v); }
          pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
        }
      } else {
        for (let i = 0; i < n; i++) { pos[i * 3] = p.getX(i); pos[i * 3 + 1] = p.getY(i); pos[i * 3 + 2] = p.getZ(i); }
      }
      const nAttr = deformed ? null : g.attributes.normal;
      const uvAttr = g.attributes.uv, cAttr = g.attributes.color;
      let nor = null, uv = null, col = null, colSize = 3;
      if (nAttr) {
        nor = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { nor[i * 3] = nAttr.getX(i); nor[i * 3 + 1] = nAttr.getY(i); nor[i * 3 + 2] = nAttr.getZ(i); }
      }
      if (uvAttr) {
        uv = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          uv[i * 2] = uvAttr.getX(i);
          const v = uvAttr.getY(i);
          uv[i * 2 + 1] = flipV ? 1 - v : v;
        }
      }
      if (cAttr && mats.some((mt) => mt && mt.vertexColors)) {
        colSize = cAttr.itemSize === 4 ? 4 : 3;
        col = new Float32Array(n * colSize);
        for (let i = 0; i < n; i++) {
          col[i * colSize] = cAttr.getX(i); col[i * colSize + 1] = cAttr.getY(i); col[i * colSize + 2] = cAttr.getZ(i);
          if (colSize === 4) col[i * 4 + 3] = cAttr.getW(i);
        }
      }
      let idx;
      if (g.index) idx = new Uint32Array(g.index.array);
      else { idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; }
      const dr = g.drawRange || { start: 0, count: Infinity };
      const ranges = g.groups && g.groups.length
        ? g.groups.map((gr) => ({ start: gr.start, count: gr.count, mat: gr.materialIndex || 0 }))
        : [{ start: 0, count: idx.length, mat: 0 }];
      const prims = [];
      for (const r of ranges) {
        const start = Math.max(r.start, dr.start || 0);
        const end = Math.min(r.start + r.count, (dr.start || 0) + dr.count, idx.length);
        const count = end - start;
        if (count < 3 || start < 0) continue;
        prims.push({ idx: idx.slice(start, start + count - (count % 3)), mat: await materialIndex(mats[r.mat] || mats[0]) });
      }
      if (!prims.length) return -1;
      model.meshes.push({ name: o.name || 'mesh', pos, nor, uv, col, colSize, prims });
      return model.meshes.length - 1;
    }

    for (const o of objs) {
      const g = o.geometry, p = g.attributes.position;
      if (p.itemSize < 3) continue;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const flipV = !!(mats[0] && mats[0].map && mats[0].map.flipY);
      const key = (isDeformed(o) ? o.uuid : g.uuid) + '|' + mats.map((mt) => (mt && mt.uuid) || '-').join(',') + '|' + flipV;
      let mi = meshCache.get(key);
      if (mi === undefined) {
        if (totalVerts + p.count > 40e6) throw new Error('cena grande demais (limite de 40M vértices)');
        totalVerts += p.count;
        mi = await buildMesh(o, mats, flipV);
        meshCache.set(key, mi);
        if (totalVerts - lastYield > 200000) { lastYield = totalVerts; await new Promise((r) => setTimeout(r)); }
      }
      if (mi < 0) continue;
      if (o.isInstancedMesh) {
        const base = o.matrixWorld.elements.slice();
        const cnt = Math.min(o.count, MAX_NODES - model.nodes.length);
        for (let k = 0; k < cnt; k++) {
          const im = Array.from(o.instanceMatrix.array.subarray(k * 16, k * 16 + 16));
          model.nodes.push({ name: (o.name || 'mesh') + '_' + k, mesh: mi, matrix: mul(base, im) });
        }
      } else if (model.nodes.length < MAX_NODES) {
        model.nodes.push({ name: o.name || 'mesh', mesh: mi, matrix: o.matrixWorld.elements.slice() });
      }
    }
    if (!model.nodes.length) throw new Error('a cena three.js ainda não tem malhas visíveis');
    return buildGLB(model);
  }

  api.buildGLB = buildGLB;
  api.exportThree = exportThree;
})();
