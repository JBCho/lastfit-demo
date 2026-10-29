// LastFit — self-contained local GLB assets. Model resources never leave the browser.
(function (LF) {
  'use strict';

  const MAX_FILE = 80 * 1024 * 1024;
  const MAX_JSON = 5 * 1024 * 1024;
  const JSON_CHUNK = 0x4e4f534a;
  const BIN_CHUNK = 0x004e4942;
  const COMPRESSED = {
    KHR_draco_mesh_compression: 'Draco',
    EXT_meshopt_compression: 'Meshopt',
    KHR_texture_basisu: 'KTX2 / Basis',
  };
  // Extensions implemented by the companion three.js r128 GLTFLoader.
  const REQUIRED = new Set([
    'KHR_materials_unlit', 'KHR_materials_pbrSpecularGlossiness',
    'KHR_materials_clearcoat', 'KHR_materials_transmission',
    'KHR_texture_transform', 'KHR_lights_punctual', 'KHR_mesh_quantization',
  ]);
  const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

  class ProductAssetError extends Error {
    constructor(code, message) { super(message); this.name = 'ProductAssetError'; this.code = code; }
  }
  const fail = (code, message) => { throw new ProductAssetError(code, message); };
  const whole = (n) => Number.isSafeInteger(n) && n >= 0;
  function array(value, name) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 4096) fail('structure', `${name} 구성이 올바르지 않거나 너무 복잡합니다.`);
    return value;
  }
  function reference(items, index, name) {
    if (!whole(index) || !items[index]) fail('reference', `${name} 참조가 올바르지 않습니다. GLB로 다시 내보내 주세요.`);
    return items[index];
  }

  function inspectGLB(buffer) {
    if (!(buffer instanceof ArrayBuffer)) fail('buffer', 'GLB 파일을 읽지 못했습니다. 파일을 다시 선택해 주세요.');
    if (buffer.byteLength > MAX_FILE) fail('size', '3D 파일은 80 MB 이하의 GLB를 사용해 주세요.');
    if (buffer.byteLength < 20) fail('header', 'GLB 헤더가 없거나 파일이 잘렸습니다.');
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67) fail('format', 'glTF 2.0 바이너리 형식(.glb)만 지원합니다.');
    if (view.getUint32(4, true) !== 2) fail('version', 'glTF 2.0 버전으로 내보낸 GLB를 사용해 주세요.');
    if (view.getUint32(8, true) !== buffer.byteLength) fail('length', 'GLB에 기록된 길이와 실제 파일 크기가 다릅니다. 파일이 손상되었을 수 있습니다.');

    let cursor = 12, json = null, binLength = 0, chunks = 0;
    while (cursor < buffer.byteLength) {
      if (cursor + 8 > buffer.byteLength) fail('chunk', 'GLB 청크 헤더가 잘렸습니다.');
      const length = view.getUint32(cursor, true), type = view.getUint32(cursor + 4, true);
      cursor += 8;
      if (length % 4 || cursor + length > buffer.byteLength) fail('chunk', 'GLB 청크의 크기 또는 정렬이 올바르지 않습니다.');
      if (chunks === 0 && type !== JSON_CHUNK) fail('json', 'GLB의 첫 청크는 모델 정보(JSON)여야 합니다.');
      if (type === JSON_CHUNK) {
        if (json !== null || chunks !== 0 || !length || length > MAX_JSON) fail('json', 'GLB의 모델 정보가 중복되었거나 너무 큽니다.');
        try {
          json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, cursor, length)));
        } catch (_) { fail('json', 'GLB의 모델 정보(JSON)를 읽을 수 없습니다.'); }
      } else if (type === BIN_CHUNK) {
        if (chunks !== 1 || !length) fail('chunk', 'GLB 바이너리 청크가 중복되었거나 올바르지 않습니다.');
        binLength = length;
      } else {
        fail('chunk', '이 GLB의 추가 청크 형식은 지원하지 않습니다. 표준 GLB로 다시 내보내 주세요.');
      }
      cursor += length; chunks++;
    }
    if (!json || !json.asset || json.asset.version !== '2.0' || (json.asset.minVersion && json.asset.minVersion !== '2.0')) {
      fail('version', 'glTF 2.0 모델 정보가 필요합니다.');
    }

    // Check every resource URI before GLTFLoader sees the document, including extension resources.
    const pending = [{ value: json, depth: 0 }]; let entries = 0;
    while (pending.length) {
      const { value, depth } = pending.pop();
      if (++entries > 200000 || depth > 128) fail('complexity', '모델 정보가 너무 복잡합니다. 단순화한 GLB를 사용해 주세요.');
      if (!value || typeof value !== 'object') continue;
      for (const [key, item] of Object.entries(value)) {
        if (key === 'uri') fail('external', '외부 파일이나 별도 URI를 사용하는 모델은 지원하지 않습니다. 메시와 텍스처를 모두 포함한 GLB로 내보내 주세요.');
        if (Object.prototype.hasOwnProperty.call(COMPRESSED, key)) {
          fail('compression', `${COMPRESSED[key]} 압축 모델은 아직 지원하지 않습니다. 압축을 해제한 GLB로 내보내 주세요.`);
        }
        if (typeof item === 'number' && !Number.isFinite(item)) fail('number', '모델에 유효하지 않은 수치가 포함되어 있습니다.');
        if (item && typeof item === 'object') pending.push({ value: item, depth: depth + 1 });
      }
    }
    const used = array(json.extensionsUsed, '확장 기능');
    const required = array(json.extensionsRequired, '필수 확장 기능');
    for (const extension of [...used, ...required]) {
      if (typeof extension !== 'string') fail('extension', '모델 확장 기능의 이름이 올바르지 않습니다.');
      if (Object.prototype.hasOwnProperty.call(COMPRESSED, extension)) {
        fail('compression', `${COMPRESSED[extension]} 압축 모델은 아직 지원하지 않습니다. 압축을 해제한 GLB로 내보내 주세요.`);
      }
    }
    for (const extension of required) {
      if (!REQUIRED.has(extension)) fail('extension', `이 뷰어에서 지원하지 않는 필수 확장 기능(${extension})이 있습니다. 기본 glTF 2.0 GLB로 내보내 주세요.`);
    }

    const buffers = array(json.buffers, '바이너리 버퍼');
    if (buffers.length !== 1 || !buffers[0] || !binLength || !whole(buffers[0].byteLength) || !buffers[0].byteLength ||
        buffers[0].byteLength > binLength || binLength - buffers[0].byteLength > 3) {
      fail('binary', '모델 데이터를 포함한 단일 BIN 버퍼가 필요합니다. GLB로 다시 내보내 주세요.');
    }
    const views = array(json.bufferViews, '버퍼 영역');
    for (const section of views) {
      if (!section || section.buffer !== 0 || !whole(section.byteLength) || !section.byteLength ||
          !whole(section.byteOffset || 0) || (section.byteOffset || 0) + section.byteLength > buffers[0].byteLength ||
          (section.byteStride != null && (!whole(section.byteStride) || section.byteStride < 4 || section.byteStride > 252 || section.byteStride % 4))) {
        fail('bounds', 'GLB의 버퍼 영역이 파일 범위를 벗어나거나 올바르지 않습니다.');
      }
    }
    const accessors = array(json.accessors, '메시 데이터');
    let decodedBytes = 0;
    for (const accessor of accessors) {
      if (!accessor || !COMPONENTS[accessor.type] || !COMPONENT_BYTES[accessor.componentType] ||
          !whole(accessor.count) || accessor.count > 5000000 || !whole(accessor.byteOffset || 0)) {
        fail('accessor', 'GLB의 메시 데이터 크기 또는 형식이 올바르지 않습니다.');
      }
      const bytes = COMPONENTS[accessor.type] * COMPONENT_BYTES[accessor.componentType];
      decodedBytes += bytes * accessor.count;
      if (decodedBytes > 150 * 1024 * 1024) fail('complexity', '압축을 푼 메시 데이터가 너무 큽니다. 모델을 단순화해 주세요.');
      if (accessor.bufferView != null) {
        const section = reference(views, accessor.bufferView, '메시 버퍼');
        const stride = section.byteStride || bytes;
        const needed = accessor.count ? (accessor.count - 1) * stride + bytes : 0;
        if (stride < bytes || (accessor.byteOffset || 0) + needed > section.byteLength) fail('bounds', '메시 데이터가 버퍼 범위를 벗어납니다.');
      } else if (!accessor.sparse) {
        fail('accessor', 'GLB의 메시 데이터에 버퍼 참조가 없습니다.');
      }
      if (accessor.sparse) {
        const sparse = accessor.sparse;
        if (!whole(sparse.count) || sparse.count > accessor.count || !sparse.indices || !sparse.values ||
            ![5121, 5123, 5125].includes(sparse.indices.componentType)) fail('accessor', '희소 메시 데이터가 올바르지 않습니다.');
        for (const [item, itemBytes] of [[sparse.indices, COMPONENT_BYTES[sparse.indices.componentType]], [sparse.values, bytes]]) {
          const section = reference(views, item.bufferView, '희소 메시 버퍼');
          if (!whole(item.byteOffset || 0) || (item.byteOffset || 0) + sparse.count * itemBytes > section.byteLength) fail('bounds', '희소 메시 데이터가 버퍼 범위를 벗어납니다.');
        }
      }
    }
    const images = array(json.images, '텍스처');
    for (const item of images) {
      if (!item || !['image/png', 'image/jpeg'].includes(item.mimeType)) fail('texture', 'GLB 내부의 PNG 또는 JPEG 텍스처만 지원합니다.');
      reference(views, item.bufferView, '텍스처 버퍼');
    }
    const meshes = array(json.meshes, '메시');
    let primitives = 0, vertices = 0, triangles = 0;
    for (const mesh of meshes) {
      for (const primitive of array(mesh && mesh.primitives, '메시 조각')) {
        if (!primitive || !primitive.attributes) fail('mesh', '표시할 수 있는 메시 데이터가 없습니다.');
        const position = reference(accessors, primitive.attributes.POSITION, '정점 위치');
        if (position.type !== 'VEC3' || !position.count) fail('mesh', '3D 정점 위치 데이터가 올바르지 않습니다.');
        for (const index of Object.values(primitive.attributes)) reference(accessors, index, '정점 속성');
        const index = primitive.indices == null ? null : reference(accessors, primitive.indices, '삼각형 인덱스');
        if (index && (index.type !== 'SCALAR' || ![5121, 5123, 5125].includes(index.componentType))) fail('mesh', '메시의 인덱스 형식이 올바르지 않습니다.');
        const count = index ? index.count : position.count;
        const mode = primitive.mode == null ? 4 : primitive.mode;
        if (!whole(mode) || mode > 6) fail('mesh', '지원하지 않는 메시 표시 방식입니다.');
        triangles += mode === 4 ? Math.floor(count / 3) : (mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0);
        vertices += position.count; primitives++;
        if (vertices > 2000000 || primitives > 2048) fail('complexity', '모델의 메시가 너무 복잡합니다. 정점 수를 줄인 GLB를 사용해 주세요.');
      }
    }
    if (!primitives) fail('mesh', '이 GLB에는 표시할 수 있는 3D 메시가 없습니다.');
    return {
      json, binaryByteLength: binLength,
      metadata: {
        bytes: buffer.byteLength, meshes: meshes.length, primitives, vertices, triangles,
        materials: array(json.materials, '소재').length, textures: images.length,
        extensions: Array.from(new Set(used)), generator: typeof json.asset.generator === 'string' ? json.asset.generator : '',
      },
    };
  }

  function dispose(scene) {
    if (!scene || typeof scene.traverse !== 'function') return;
    const geometries = new Set(), materials = new Set(), textures = new Set();
    scene.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : (object.material ? [object.material] : [])) {
        materials.add(material);
        for (const item of Object.values(material)) if (item && item.isTexture) textures.add(item);
        if (material.uniforms) for (const uniform of Object.values(material.uniforms)) if (uniform && uniform.value && uniform.value.isTexture) textures.add(uniform.value);
      }
    });
    textures.forEach((item) => { item.dispose(); if (item.image && typeof item.image.close === 'function') item.image.close(); });
    materials.forEach((item) => item.dispose());
    geometries.forEach((item) => item.dispose());
  }

  async function loadBuffer(buffer, label) {
    const inspected = inspectGLB(buffer);
    const T = window.THREE;
    if (!T || typeof T.GLTFLoader !== 'function') {
      fail('loader', '3D 파일 로더를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 페이지를 새로고침해 주세요.');
    }
    const manager = new T.LoadingManager();
    manager.setURLModifier((url) => {
      // GLTFLoader creates browser-owned blob URLs for validated embedded image bufferViews.
      if (typeof url !== 'string' || !url.startsWith('blob:')) fail('external', '모델에 포함되지 않은 외부 리소스는 불러올 수 없습니다.');
      return url;
    });
    const loader = new T.GLTFLoader(manager);
    return new Promise((resolve, reject) => {
      const failure = (error) => reject(error instanceof ProductAssetError ? error : new ProductAssetError('parse', '3D 모델을 표시하지 못했습니다. 메시와 PNG/JPEG 텍스처를 포함한 기본 GLB로 다시 내보내 주세요.'));
      try {
        loader.parse(buffer, '', (gltf) => {
          const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
          let visibleMeshes = 0;
          if (scene && typeof scene.traverse === 'function') scene.traverse((object) => {
            if (!object.isMesh) return;
            visibleMeshes++;
            // Async decoding can reorder scene children. Retain the file's mesh
            // identity so a left/right pair is never selected by completion order.
            let node = object;
            while (node) {
              const association = gltf.parser && gltf.parser.associations && gltf.parser.associations.get(node);
              const definition = association && association.type === 'nodes' && inspected.json.nodes && inspected.json.nodes[association.index];
              if (definition && Number.isInteger(definition.mesh)) {
                object.userData = object.userData || {};
                object.userData.sourceGltfMeshIndex = definition.mesh;
                break;
              }
              node = node.parent;
            }
          });
          if (!visibleMeshes) { dispose(scene); failure(new ProductAssetError('scene', '선택한 GLB 장면에는 표시할 수 있는 메시가 없습니다.')); return; }
          resolve({ scene, label: String(label || '내 제품 3D'), metadata: inspected.metadata });
        }, failure);
      } catch (error) { failure(error); }
    });
  }

  async function load(file) {
    if (!file || typeof file.name !== 'string' || !/\.glb$/i.test(file.name)) fail('type', '제품의 3D 파일(.glb)을 선택해 주세요.');
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_FILE) fail('size', '비어 있지 않은 80 MB 이하의 GLB 파일을 선택해 주세요.');
    if (typeof file.arrayBuffer !== 'function') fail('read', '이 브라우저에서 파일을 읽지 못했습니다. 최신 브라우저를 사용해 주세요.');
    let buffer;
    try { buffer = await file.arrayBuffer(); } catch (_) { fail('read', '3D 파일을 읽지 못했습니다. 파일 접근 권한을 확인하고 다시 선택해 주세요.'); }
    return loadBuffer(buffer, file.name.replace(/\.glb$/i, ''));
  }

  async function loadCatalog(item) {
    if (!item || typeof item.key !== 'string') fail('catalog', '등록된 GLB 모델 정보를 확인할 수 없습니다.');
    let buffer;
    if (typeof item.base64 === 'string') {
      const binary = atob(item.base64), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      buffer = bytes.buffer;
    } else {
      const response = await fetch(item.url);
      if (!response.ok) fail('catalog', `${item.fileName}을 불러오지 못했습니다. assets 폴더와 모델 목록을 확인하세요.`);
      buffer = await response.arrayBuffer();
    }
    const loaded = await loadBuffer(buffer, item.name);
    loaded.metadata = { ...loaded.metadata, catalogKey: item.key, fitTargets: item.fitTargets || [], orientationNote: item.orientationNote || '' };
    return loaded;
  }

  LF.assets = { inspectGLB, load, loadBuffer, loadCatalog, dispose, ProductAssetError, MAX_FILE };
})((window.LF = window.LF || {}));
