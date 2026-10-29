// LastFit — GLB file collection, per-product calibration and independent viewer instances.
(function (LF) {
  'use strict';

  function copyState(value) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(copyState);
    if (ArrayBuffer.isView(value)) return value.slice();
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = copyState(item);
    return out;
  }

  function cleanName(value, fallback) {
    const name = typeof value === 'string' ? value.trim() : '';
    return name || fallback;
  }

  // GLTFLoader may decode PNG/JPEG data into an ImageBitmap. Asset disposal closes
  // those images, so an instance receives its own drawable pixels before ownership
  // transfers to the viewer. Ordinary DOM images have no close() and can be shared.
  function cloneImage(image, images) {
    if (!image || typeof image !== 'object') return image;
    if (images.has(image)) return images.get(image);
    if (Array.isArray(image)) {
      const cloned = image.map((item) => cloneImage(item, images));
      images.set(image, cloned);
      return cloned;
    }
    if (image.data && ArrayBuffer.isView(image.data)) {
      const cloned = { ...image, data: image.data.slice() };
      images.set(image, cloned);
      return cloned;
    }
    if (typeof image.close !== 'function') return image;
    if (typeof document === 'undefined' || !document.createElement) {
      throw new Error('3D 모델의 텍스처를 복제할 수 없습니다. 브라우저에서 다시 선택해 주세요.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) {
      throw new Error('3D 모델의 텍스처 크기를 확인할 수 없습니다.');
    }
    context.drawImage(image, 0, 0);
    images.set(image, canvas);
    return canvas;
  }

  function cloneScene(template) {
    const scene = template.clone(true);
    const nodes = new Map(), geometries = new Map(), materials = new Map();
    const textures = new Map(), images = new Map();
    const pair = (original, cloned) => {
      nodes.set(original, cloned);
      for (let i = 0; i < original.children.length; i++) pair(original.children[i], cloned.children[i]);
    };
    pair(template, scene);

    function texture(original) {
      if (!textures.has(original)) {
        const cloned = original.clone();
        cloned.image = cloneImage(original.image, images);
        cloned.needsUpdate = true;
        textures.set(original, cloned);
      }
      return textures.get(original);
    }

    function uniformValue(value) {
      if (value && value.isTexture) return texture(value);
      if (Array.isArray(value)) return value.map(uniformValue);
      if (value && typeof value.clone === 'function') return value.clone();
      if (ArrayBuffer.isView(value)) return value.slice();
      if (value && typeof value === 'object') {
        const cloned = {};
        for (const [key, item] of Object.entries(value)) cloned[key] = uniformValue(item);
        return cloned;
      }
      return value;
    }

    function material(original) {
      if (!materials.has(original)) {
        const cloned = original.clone();
        for (const [key, value] of Object.entries(original)) {
          if (value && value.isTexture) cloned[key] = texture(value);
        }
        if (original.uniforms) {
          cloned.uniforms = {};
          for (const [key, uniform] of Object.entries(original.uniforms)) {
            cloned.uniforms[key] = uniform && typeof uniform === 'object'
              ? { ...uniform, value: uniformValue(uniform.value) } : uniform;
          }
        }
        materials.set(original, cloned);
      }
      return materials.get(original);
    }

    nodes.forEach((cloned, original) => {
      if (original.geometry) {
        if (!geometries.has(original.geometry)) geometries.set(original.geometry, original.geometry.clone());
        cloned.geometry = geometries.get(original.geometry);
      }
      if (original.material) {
        cloned.material = Array.isArray(original.material)
          ? original.material.map(material) : material(original.material);
      }
      if (original.isSkinnedMesh && original.skeleton) {
        cloned.skeleton = original.skeleton.clone();
        cloned.skeleton.bones = original.skeleton.bones.map((bone) => nodes.get(bone) || bone);
        cloned.skeleton.boneInverses = original.skeleton.boneInverses.map((matrix) => matrix.clone());
      }
    });
    return scene;
  }

  class GLBLibrary {
    constructor() {
      this.records = new Map();
      this.selectedId = null;
      this.nextId = 1;
    }

    // This library takes ownership of the decoded scene. templateScene must only
    // be inspected; instantiate() provides the disposable and deformable copy.
    add(loaded, options) {
      options = options || {};
      if (!loaded || !loaded.scene || typeof loaded.scene.clone !== 'function' ||
          typeof loaded.scene.traverse !== 'function') {
        throw new TypeError('목록에 추가할 GLB 모델이 필요합니다.');
      }
      const fileName = cleanName(options.fileName || loaded.fileName, cleanName(loaded.label, 'shoe') + '.glb');
      const fallbackName = fileName.replace(/^.*[\\/]/, '').replace(/\.glb$/i, '');
      const record = {
        id: 'glb-' + this.nextId++,
        fileName,
        name: cleanName(options.name, fallbackName),
        source: options.demo || options.source === 'demo' ? 'demo' : 'file',
        demo: Boolean(options.demo || options.source === 'demo'),
        metadata: copyState(loaded.metadata || {}),
        modelId: options.modelId || null,
        calibration: copyState(options.calibration || {}),
        dimensions: copyState(options.dimensions || {}),
        registration: options.registration || null,
        templateScene: loaded.scene,
      };
      record.label = record.name;
      this.records.set(record.id, record);
      if (this.selectedId == null) this.selectedId = record.id;
      return record;
    }

    get(id) { return this.records.get(id == null ? this.selectedId : id) || null; }

    list() { return Array.from(this.records.values()); }

    select(id) {
      const record = this.get(id);
      if (!record) throw new RangeError('목록에서 GLB 모델을 선택해 주세요.');
      this.selectedId = record.id;
      return record;
    }

    update(id, patch) {
      const record = this.get(id);
      if (!record) throw new RangeError('수정할 GLB 모델을 찾지 못했습니다.');
      patch = patch || {};
      if (patch.name != null) record.label = record.name = cleanName(patch.name, record.name);
      if (patch.modelId != null) record.modelId = patch.modelId;
      // Registration holds immutable decoded Float32Array samples and is shared
      // with the fit engine/viewer; each consumer owns its mutable display data.
      if (Object.prototype.hasOwnProperty.call(patch, 'registration')) record.registration = patch.registration;
      for (const key of ['calibration', 'dimensions', 'metadata']) {
        if (patch[key] && typeof patch[key] === 'object') record[key] = { ...record[key], ...copyState(patch[key]) };
      }
      return record;
    }

    instantiate(id) {
      const record = this.get(id);
      if (!record) throw new RangeError('표시할 GLB 모델을 선택해 주세요.');
      return {
        scene: cloneScene(record.templateScene),
        label: record.name,
        fileName: record.fileName,
        metadata: copyState(record.metadata),
        libraryId: record.id,
        modelId: record.modelId,
        calibration: copyState(record.calibration),
        dimensions: copyState(record.dimensions),
        registration: record.registration,
      };
    }

    dispose() {
      const scenes = new Set(this.list().map((record) => record.templateScene));
      scenes.forEach((scene) => { if (LF.assets && LF.assets.dispose) LF.assets.dispose(scene); });
      this.records.clear();
      this.selectedId = null;
    }
  }

  LF.GLBLibrary = GLBLibrary;
})((window.LF = window.LF || {}));
