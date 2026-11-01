// LastFit — 3D 뷰어 (three.js r128)
(function (LF) {
  'use strict';
  const { clamp } = LF.util;
  const GM = LF.geom;

  function emptyCollisionStats() {
    return { collisionCorrectedVertexCount: 0, remainingPenetrationMm: 0, remainingFlexiblePenetrationMm: 0, remainingRigidPenetrationMm: 0,
      maxDrapeMm: 0, collisionReactionKPa: 0,
      iterations: 0, contactVertexCount: 0, initialPenetrationMm: 0, elasticLimitExceededVertexCount: 0, rigidContactVertexCount: 0,
      maxElasticExpansionMm:0,maxAllowedElasticExpansionMm:0,maxPhysicalDisplacementMm:0,maxInwardDisplacementMm:0,displacementLimitedVertexCount:0 };
  }

  // ---------- 히트맵 색상 ----------
  // s < 0: 여유(mm), s > 0: 압력(kPa)
  const HEAT = [
    [-12, '#2b59c3'], [-6, '#6f9fe0'], [-2.5, '#b4d8ee'], [0, '#c6ead0'],
    [8, '#e2ee9c'], [15, '#f5d257'], [25, '#f29233'], [38, '#d63a3a'], [55, '#951546'],
  ].map(([s, hex]) => [s, new THREE.Color(hex).convertSRGBToLinear()]);
  // Red marks unresolved fit; it does not imply a calculated pressure value.
  const UNKNOWN_PRESSURE = new THREE.Color('#e32636').convertSRGBToLinear();

  function heatColor(s, out) {
    if (s <= HEAT[0][0]) return out.copy(HEAT[0][1]);
    for (let i = 1; i < HEAT.length; i++) {
      if (s <= HEAT[i][0]) {
        const f = (s - HEAT[i - 1][0]) / (HEAT[i][0] - HEAT[i - 1][0]);
        return out.copy(HEAT[i - 1][1]).lerp(HEAT[i][1], f);
      }
    }
    return out.copy(HEAT[HEAT.length - 1][1]);
  }

  const MAT_COLORS = ['#6c8ebf', '#d1495b', '#e3a33b', '#4f9d7a', '#8d6aa8'];

  // Procedural appearance remains a fallback when no calibrated GLB is selected.
  const PRODUCT_COLORS = {
    aero: { upper: '#e1e4de', trim: '#355a4e', panel: '#c3ccc3', lace: '#f9faf3' },
    derby: { upper: '#55352b', trim: '#2a1d19', panel: '#674337', lace: '#2d211c' },
    trail: { upper: '#7b8565', trim: '#292f2a', panel: '#455241', lace: '#e5bf76' },
    flow: { upper: '#d9cfb8', trim: '#535b4d', panel: '#a69f89', lace: '#f7f1e4' },
    court: { upper: '#ece9df', trim: '#344e67', panel: '#d7d8cf', lace: '#fcfbf4' },
  };

  // Each dynamically owned object is disposed once, including shared texture maps.
  function disposeObject(object) {
    if (!object) return;
    const geometries = new Set(), materials = new Set(), textures = new Set();
    object.traverse((part) => {
      if (part.geometry) geometries.add(part.geometry);
      const list = Array.isArray(part.material) ? part.material : [part.material];
      list.filter(Boolean).forEach((material) => {
        materials.add(material);
        Object.values(material).forEach((value) => { if (value && value.isTexture) textures.add(value); });
        if (material.uniforms) Object.values(material.uniforms).forEach((uniform) => {
          if (uniform && uniform.value && uniform.value.isTexture) textures.add(uniform.value);
        });
      });
      if (part.skeleton && part.skeleton.boneTexture) textures.add(part.skeleton.boneTexture);
    });
    geometries.forEach((geometry) => geometry.dispose());
    textures.forEach((texture) => texture.dispose());
    materials.forEach((material) => material.dispose());
    if (object.parent) object.parent.remove(object);
  }

  function materialTexture(kind) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#979797';
    ctx.fillRect(0, 0, 128, 128);
    if (kind === 'knit' || kind === 'mesh') {
      for (let y = 0; y < 128; y += 8) {
        for (let x = 0; x < 128; x += 6) {
          ctx.strokeStyle = kind === 'knit' ? '#dedede' : '#555555';
          ctx.lineWidth = kind === 'knit' ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(x + (y % 16 ? 3 : 0), y);
          ctx.lineTo(x + 3 + (y % 16 ? 3 : 0), y + 5);
          ctx.lineTo(x + 6 + (y % 16 ? 3 : 0), y);
          ctx.stroke();
        }
      }
    } else {
      for (let y = 0; y < 128; y += 3) {
        for (let x = 0; x < 128; x += 3) {
          const tone = 90 + ((x * 13 + y * 17) % 70);
          ctx.fillStyle = `rgb(${tone},${tone},${tone})`;
          ctx.fillRect(x, y, 1.4, 1.4);
        }
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(5, 2);
    return texture;
  }

  // Sample the static upper grid, including photo-derived silhouette profiles.
  function upperPoint(shoe, x, fraction, lift) {
    const rows = GM.sectionRows(shoe, x);
    const u = clamp(fraction, -0.998, 0.998);
    const angle = Math.acos(Math.sign(u) * Math.pow(Math.abs(u), 2.8 / 2));
    const j = angle / (2 * Math.PI) * shoe.nt;
    const j0 = Math.floor(j), j1 = Math.min(shoe.nt / 2, j0 + 1), f = j - j0;
    const out = new THREE.Vector3();
    for (const [row, weight] of [[rows.i0, 1 - rows.f], [rows.i1, rows.f]]) {
      for (let axis = 0; axis < 3; axis++) {
        const v = shoe.pos[3 * (row * shoe.nt + j0) + axis] * (1 - f)
          + shoe.pos[3 * (row * shoe.nt + j1) + axis] * f;
        out.setComponent(axis, out.getComponent(axis) + v * weight);
      }
    }
    out.y += lift || 0;
    out.z += u * 1.7;
    return out;
  }

  function ribbon(shoe, x0, x1, f0, f1, lift, material) {
    const positions = [], indices = [], uv = [];
    const nx = 28, nz = 12;
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= nz; j++) {
        const p = upperPoint(shoe, x0 + (x1 - x0) * i / nx, f0 + (f1 - f0) * j / nz, lift);
        positions.push(p.x, p.y, p.z); uv.push(i / nx, j / nz);
        if (i < nx && j < nz) {
          const k = i * (nz + 1) + j;
          indices.push(k, k + nz + 1, k + 1, k + 1, k + nz + 1, k + nz + 2);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }

  function tube(points, radius, material, closed) {
    if (points.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(points, Boolean(closed), 'centripetal');
    return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, points.length * 3), radius, 7, Boolean(closed)), material);
  }

  function dimensionLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(247,250,247,0.94)';
    ctx.fillRect(2, 2, 508, 92);
    ctx.strokeStyle = '#a2bcb0'; ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, 508, 92);
    ctx.fillStyle = '#183c30'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '500 31px "Noto Sans KR", "Malgun Gothic", sans-serif';
    ctx.fillText(text, 256, 48);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }));
    label.scale.set(114, 21.4, 1);
    label.renderOrder = 8;
    return label;
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // ---------- 궤도 카메라 조작 ----------
  function Orbit(camera, el, onChange) {
    this.camera = camera;
    this.el = el;
    this.onChange = onChange;
    this.target = new THREE.Vector3(0, 30, 0);
    this.cur = { r: 560, th: 2.35, ph: 1.08 };
    this.goal = { ...this.cur };
    this.fit = 1; // 화면 비율에 따른 거리 배율
    this.pan = new THREE.Vector3();
    this.pointers = new Map();
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.ease = reduce ? 1 : 0.18;

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (this.pointers.size === 1) {
        if (p.button === 2 || p.shift) this.panBy(dx, dy);
        else {
          this.goal.th -= dx * 0.008;
          this.goal.ph = clamp(this.goal.ph - dy * 0.008, 0.12, 1.62);
          this.cur.th = this.goal.th;
          this.cur.ph = this.goal.ph;
        }
      } else if (this.pointers.size === 2) {
        const pts = [...this.pointers.values()];
        const other = pts.find((q) => q !== p);
        const before = Math.hypot(p.x - other.x, p.y - other.y);
        const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 0 && after > 0) this.zoom(before / after);
        this.panBy(dx / 2, dy / 2);
      }
      p.x = e.clientX;
      p.y = e.clientY;
      this.onChange();
    });
    const up = (e) => this.pointers.delete(e.pointerId);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      // 세로로 쌓인 좁은 레이아웃에서는 휠을 페이지 스크롤에 양보(Ctrl+휠로 확대)
      if (window.innerWidth < 1100 && !e.ctrlKey) return;
      e.preventDefault();
      this.zoom(Math.exp(e.deltaY * 0.0012));
      this.onChange();
    }, { passive: false });
  }
  Orbit.prototype.zoom = function (f) {
    this.goal.r = clamp(this.goal.r * f, 200, 1400);
    this.cur.r = this.goal.r;
  };
  Orbit.prototype.panBy = function (dx, dy) {
    const s = this.cur.r * this.fit * 0.0012;
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
    const upv = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
    this.pan.addScaledVector(right, -dx * s).addScaledVector(upv, dy * s);
    this.pan.clampLength(0, 260);
  };
  Orbit.prototype.setView = function (v) {
    Object.assign(this.goal, v);
    this.pan.set(0, 0, 0);
  };
  Orbit.prototype.update = function () {
    let moving = false;
    for (const k of ['r', 'th', 'ph']) {
      const d = this.goal[k] - this.cur[k];
      if (Math.abs(d) > 1e-4) { this.cur[k] += d * this.ease; moving = true; }
      else this.cur[k] = this.goal[k];
    }
    const { th, ph } = this.cur;
    const r = this.cur.r * this.fit;
    const t = this.target.clone().add(this.pan);
    this.camera.position.set(t.x + r * Math.sin(ph) * Math.sin(th), t.y + r * Math.cos(ph), t.z + r * Math.sin(ph) * Math.cos(th));
    this.camera.lookAt(t);
    return moving;
  };

  const VIEWS = {
    persp: { th: 2.35, ph: 1.08, r: 560 },
    side: { th: Math.PI, ph: 1.5, r: 520 },
    top: { th: Math.PI / 2, ph: 0.12, r: 560 },
    front: { th: Math.PI / 2 + 0.25, ph: 1.22, r: 470 },
    cut: { th: Math.PI / 2 + 0.62, ph: 1.0, r: 560 },
  };

  // ---------- 뷰어 ----------
  function Viewer(el) {
    this.el = el;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.localClippingEnabled = true;
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', '3D 착화 시뮬레이션 뷰. 드래그로 회전, 휠로 확대');
    renderer.domElement.setAttribute('role', 'img');
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(30, 1, 5, 6000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8c918e, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(260, 520, 300);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-320, 180, -260);
    scene.add(fill);

    this.root = new THREE.Group();
    this.root.scale.z = -1; // 모델 프레임(안쪽 +z) → 화면상 오른발
    scene.add(this.root);

    this.clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e5);
    const clipPlanes = [this.clip];

    // 발
    this.footGeo = new THREE.BufferGeometry();
    this.footMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide, clippingPlanes: clipPlanes });
    this.footMesh = new THREE.Mesh(this.footGeo, this.footMat);
    this.root.add(this.footMesh);

    // 다리(발목) — 표시용, 평가 제외
    // Blend the lower ankle into the heel while retaining the exposed calf.
    const prof = [[0.0, -0.02], [0.76, 0], [0.9, 0.22], [1.04, 0.4], [0.9, 0.5], [0.84, 0.8], [0.86, 1]].map(([r, y]) => new THREE.Vector2(r, y));
    this.legGeo = new THREE.LatheGeometry(prof, 48);
    this.legMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.7, metalness: 0, side: THREE.DoubleSide, transparent: true, clippingPlanes: clipPlanes });
    this.legMesh = new THREE.Mesh(this.legGeo, this.legMat);
    this.root.add(this.legMesh);

    // 신발 갑피(반투명 셸): 내부면 + 벽 두께 + 변형량, 칼라 위는 셰이더에서 잘라냄
    this.shellGeo = new THREE.BufferGeometry();
    this.shellMat = new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, opacity: 0.2, roughness: 0.35, metalness: 0,
      side: THREE.DoubleSide, depthWrite: false, clippingPlanes: clipPlanes,
    });
    this.shellMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aOpen;\nvarying float vOpen;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOpen = aOpen;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vOpen;')
        .replace('void main() {', 'void main() {\n  if (vOpen > 0.0) discard;')
        .replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\n  float fr = 1.0 - abs(dot(normalize(vViewPosition), normal));\n  gl_FragColor.a = clamp(opacity * (0.5 + 3.5 * fr * fr * fr), 0.0, 0.85);');
    };
    this.shellMesh = new THREE.Mesh(this.shellGeo, this.shellMat);
    this.shellMesh.renderOrder = 2;
    this.root.add(this.shellMesh);

    // 아웃솔
    this.soleGeo = new THREE.BufferGeometry();
    this.soleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, clippingPlanes: clipPlanes });
    this.soleMesh = new THREE.Mesh(this.soleGeo, this.soleMat);
    this.root.add(this.soleMesh);

    this.productGroup = new THREE.Group();
    this.productGroup.visible = false;
    this.root.add(this.productGroup);
    this.dimensionGroup = new THREE.Group();
    this.dimensionGroup.visible = false;
    scene.add(this.dimensionGroup);
    this.showDimensions = false;
    this.productAsset = null;
    this.contactLayers = null;
    this.contactLayerKey = null;
    this.assetAxis = null;
    this.assetReverse = false;
    this.assetOpacity = 0.3;
    this.assetRegistration = null;
    this.assetMeshes = [];
    this.assetField = null;
    this.assetDrapeCache = null;
    this.deformationEnabled = true;
    this.assetStats = { maxMm: 0, stretchMm: 0, closeMm: 0, snugClosureMm: 0, maxDisplacementMm: 0,
      deformedVertexCount: 0, vertexCount: 0, ...emptyCollisionStats(), visualRemainingPenetrationMm: 0,
      collisionSolverAvailable: false, exaggeration: 1, enabled: true, worn: true };

    // 바닥: mm 그리드 + 접지 그림자
    this.grid = new THREE.GridHelper(800, 80, 0x999999, 0x999999);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.28;
    scene.add(this.grid);
    const sc = document.createElement('canvas');
    sc.width = sc.height = 128;
    const g2 = sc.getContext('2d');
    const grd = g2.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.42)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g2.fillStyle = grd;
    g2.fillRect(0, 0, 128, 128);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.shadow);

    // 단면 위치 표시 프레임
    const fr = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -45, -75), new THREE.Vector3(0, -45, 75), new THREE.Vector3(0, 120, 75), new THREE.Vector3(0, 120, -75), new THREE.Vector3(0, -45, -75),
    ]);
    this.cutFrame = new THREE.Line(fr, new THREE.LineBasicMaterial({ color: 0x2b59c3, transparent: true, opacity: 0.7 }));
    this.cutFrame.visible = false;
    scene.add(this.cutFrame);

    this.orbit = new Orbit(this.camera, renderer.domElement, () => (this.dirty = true));
    this.mode = 'fit';
    this.showShoe = true;
    this.exaggerate = 1;
    this.autoRotate = false;
    this.lastFrameTime = 0;
    this.sectionPosition = null;
    this.dirty = true;
    this.applyTheme();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(el);
    this.resize();
    const loop = (time) => {
      const dt = Math.min(0.06, (time - (this.lastFrameTime || time)) / 1000);
      this.lastFrameTime = time;
      if (this.autoRotate && !this.orbit.pointers.size && document.visibilityState !== 'hidden') {
        this.orbit.goal.th += dt * 0.24;
        this.dirty = true;
      }
      const moving = this.orbit.update();
      if (moving || this.dirty) {
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  Viewer.prototype.resize = function () {
    const w = Math.max(10, this.el.clientWidth);
    const h = Math.max(10, this.el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.9 ? 40 : 30;
    this.camera.updateProjectionMatrix();
    // 신발 길이(약 400mm 폭)가 가로로 들어오도록 카메라 거리를 맞춘다
    const half = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
    this.orbit.fit = Math.max(1, 215 / half / 560);
    this.renderNow(); // 크기 변경은 캔버스를 지우므로 즉시 다시 그린다(탭이 숨겨져 rAF가 멈춘 경우 포함)
  };

  Viewer.prototype.renderNow = function () {
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  };

  Viewer.prototype.applyTheme = function () {
    this.skin = new THREE.Color(cssVar('--skin', '#d6cfc7')).convertSRGBToLinear();
    this.shellColor = new THREE.Color(cssVar('--shell', '#f4f7f8')).convertSRGBToLinear();
    this.legMat.color.copy(this.skin);
    const gc = new THREE.Color(cssVar('--grid', '#b4bcb7'));
    this.grid.material.color.copy(gc);
    this.dirty = true;
  };

  Viewer.prototype.setView = function (name) {
    this.orbit.setView(VIEWS[name] || VIEWS.persp);
    this.dirty = true;
  };

  function setAttr(geo, name, arr, size) {
    const a = geo.getAttribute(name);
    if (a && a.array.length === arr.length) {
      a.array.set(arr);
      a.needsUpdate = true;
    } else {
      // BufferAttribute retains its input array. The renderer must own this copy:
      // Three.js updates existing normals in place when shading a compressed foot.
      geo.setAttribute(name, new THREE.BufferAttribute(arr.slice(), size));
    }
  }

  // 표시 결과 반영: display = engine.evaluate(...).display, deform = engine.shoeDeflection(display)
  Viewer.prototype.update = function (display, deform, model) {
    this.footPreview = false;
    const { foot, shoe, sim, ctx } = display;
    this.last = { display, deform, model };
    const Ls = shoe.Ls;
    this.root.position.set(-Ls / 2, 0, 0);

    this.updateFootGeometry(display, deform);

    this.placeLeg(display);

    // 신발 셸
    if (this.shellGeo.userData.key !== shoe) {
      this.shellGeo.setIndex(new THREE.BufferAttribute(GM.gridIndex(shoe), 1));
      this.shellGeo.userData.key = shoe;
      setAttr(this.shellGeo, 'aOpen', shoe.openVal, 1);
      setAttr(this.shellGeo, 'normal', shoe.nrm, 3);
      const sole = GM.buildSole(shoe, model, 40);
      this.soleGeo.setIndex(new THREE.BufferAttribute(GM.gridIndex(sole), 1));
      setAttr(this.soleGeo, 'position', sole.pos, 3);
      setAttr(this.soleGeo, 'normal', sole.nrm, 3);
      const top = new THREE.Color(model.sole.color).convertSRGBToLinear();
      const bot = new THREE.Color(model.sole.bottom).convertSRGBToLinear();
      const col = new Float32Array(sole.n * 3);
      const c = new THREE.Color();
      for (let k = 0; k < sole.n; k++) {
        c.copy(top).lerp(bot, clamp((-sole.vv[k] - 0.55) / 0.3, 0, 1));
        col[3 * k] = c.r; col[3 * k + 1] = c.g; col[3 * k + 2] = c.b;
      }
      setAttr(this.soleGeo, 'color', col, 3);
      this.soleGeo.computeBoundingSphere();
      const floor = -model.sole.heel - 0.8;
      this.grid.position.y = floor;
      this.shadow.position.set(0, floor + 0.3, 0);
      this.shadow.scale.set(Ls * 1.45, 150, 1);
    }
    this.deformShell();
    this.paintShell();
    if (this.productKey !== shoe) {
      this.buildProductExterior();
      this.productKey = shoe;
      this.updateDimensions();
      this.normalizeProductAsset();
    }
    this.updateContactLayers(shoe);
    this.deformAsset();
    if (LF.diorFit && LF.diorFit.enabled(model)) this.paintFoot();
    this.paintAsset();
    this.updateAssetFloor();
    this.applyVisibility();
    this.renderNow();
  };

  Viewer.prototype.updateFootGeometry = function (display, deform) {
    const foot = display.foot;
    if (this.footGeo.userData.key !== foot) {
      this.footGeo.setIndex(new THREE.BufferAttribute(GM.gridIndex(foot), 1));
      this.footGeo.userData.key = foot;
    }
    setAttr(this.footGeo, 'position', deform.fpos, 3);
    setAttr(this.footGeo, 'normal', foot.nrm, 3);
    // Tissue compression changes the rendered surface, not the measured source
    // normals used by the pressure solver. Recompute only this owned geometry.
    if (display.compressedFpos) this.footGeo.computeVertexNormals();
    this.paintFoot();
    this.footGeo.computeBoundingSphere();
  };

  Viewer.prototype.setFootSide = function (side) {
    if (!['left','right'].includes(side)) throw new RangeError('왼발 또는 오른발을 선택하세요.');
    this.footSide = side;
    this.root.scale.z = side === 'left' ? 1 : -1;
    this.dirty = true;
  };

  Viewer.prototype.setAnatomyOpacity = function (opacity) {
    for (const material of [this.footMat,this.legMat]) if (material) {
      const transparent = opacity < 1;
      if (material.transparent !== transparent) material.needsUpdate = true;
      material.transparent = transparent;material.opacity = opacity;material.depthWrite = !transparent;
    }
  };

  Viewer.prototype.updateAnatomyOpacity = function () {
    // Shoe visibility controls the foot and ankle together, including after
    // recalculation. Previewing the original foot always keeps solid shading.
    const blocked = this.mode !== 'product' && Number(this.assetStats && this.assetStats.remainingPenetrationMm) > .5;
    const opacity = this.footPreview ? 1 : this.mode === 'fit' && !this.showShoe ? .55 : blocked ? .2 : 1;
    this.setAnatomyOpacity(opacity);
  };

  Viewer.prototype.showFootPreview = function (foot) {
    this.footPreview = true;this.previewFootData = foot;
    this.root.position.set(-foot.L/2,0,0);
    this.updateFootGeometry({foot},{fpos:foot.pos});
    const leg = foot.leg;
    this.legMesh.position.set(leg.x,leg.y0,leg.z);
    this.legMesh.scale.set(leg.rx,leg.y1-leg.y0,leg.rz);
    this.setAnatomyOpacity(1);
    this.grid.position.y=-.8;this.shadow.position.set(0,-.5,0);
    this.shadow.scale.set(foot.L*1.3,foot.shape.W*1.4,1);
    this.applyVisibility();this.renderNow();
  };

  Viewer.prototype.placeLeg = function (display) {
    const L = display.foot.leg, ctx = display.ctx, seat = ctx.seat || { x: 0, y: 0, z: 0 };
    const p=LF.sim && LF.sim.transformFootPoint ? LF.sim.transformFootPoint(ctx,L.x,L.y0,L.z) : {x:L.x+ctx.sock+.5+ctx.slide+seat.x,y:L.y0+ctx.sock+seat.y,z:L.z+seat.z};
    this.legMesh.position.set(p.x,p.y,p.z);
    this.legMesh.scale.set(L.rx + ctx.sock, L.y1 - L.y0, L.rz + ctx.sock);
  };

  Viewer.prototype.buildProductExterior = function () {
    if (!this.last) return;
    disposeObject(this.productGroup);
    this.productGroup.clear();
    this.root.add(this.productGroup);
    const { display, model } = this.last;
    const shoe = display.shoe;
    const palette = PRODUCT_COLORS[model.id] || (model.upper === 'leather' ? PRODUCT_COLORS.derby : PRODUCT_COLORS.aero);
    const color = new THREE.Color(palette.upper).convertSRGBToLinear();
    const panel = new THREE.Color(palette.panel).convertSRGBToLinear();
    const accent = new THREE.Color(palette.trim).convertSRGBToLinear();
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(shoe.n * 3), colors = new Float32Array(shoe.n * 3), uv = new Float32Array(shoe.n * 2);
    for (let k = 0; k < shoe.n; k++) {
      const c = model.toecap === 'toecap_rigid' && shoe.mat[k] === GM.M.TOECAP ? accent : shoe.mat[k] === GM.M.COUNTER ? panel : color;
      for (let axis = 0; axis < 3; axis++) {
        positions[3 * k + axis] = shoe.pos[3 * k + axis] + shoe.nrm[3 * k + axis] * 2.2;
      }
      colors[3 * k] = c.r; colors[3 * k + 1] = c.g; colors[3 * k + 2] = c.b;
      uv[2 * k] = shoe.pos[3 * k] / shoe.Ls;
      uv[2 * k + 1] = (k % shoe.nt) / shoe.nt;
    }
    geometry.setIndex(new THREE.BufferAttribute(GM.gridIndex(shoe), 1));
    setAttr(geometry, 'position', positions, 3);
    setAttr(geometry, 'normal', shoe.nrm.slice(), 3);
    setAttr(geometry, 'aOpen', shoe.openVal.slice(), 1);
    setAttr(geometry, 'color', colors, 3);
    setAttr(geometry, 'uv', uv, 2);
    const texture = materialTexture(model.upper);
    const fabric = model.upper === 'knit' || model.upper === 'mesh';
    const upperMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide, roughness: fabric ? 0.92 : model.upper === 'leather' ? 0.46 : 0.62,
      metalness: 0, bumpMap: texture, bumpScale: fabric ? 0.42 : 0.12,
    });
    upperMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aOpen; varying float vOpen;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOpen = aOpen;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vOpen;')
        .replace('void main() {', 'void main() {\nif (vOpen > 0.0) discard;');
    };
    this.productGroup.add(new THREE.Mesh(geometry, upperMaterial));
    const trimMaterial = new THREE.MeshStandardMaterial({ color: palette.trim, roughness: 0.82, side: THREE.DoubleSide });
    const panelMaterial = new THREE.MeshStandardMaterial({ color: palette.panel, roughness: fabric ? 0.91 : 0.57, side: THREE.DoubleSide });
    const laceMaterial = new THREE.MeshStandardMaterial({ color: palette.lace, roughness: 0.98 });
    const stitchMaterial = new THREE.MeshStandardMaterial({ color: model.upper === 'leather' ? '#ad8c71' : '#bbc1b4', roughness: 0.9 });
    const attachTube = (points, radius, material, closed) => {
      const object = tube(points, radius, material, closed);
      if (object) this.productGroup.add(object);
    };

    // Padded collar follows the same opening boundary as the analytic last.
    const collarA = [], collarB = [];
    for (let i = 0; i < shoe.nx; i++) {
      const crosses = [];
      for (let j = 0; j < shoe.nt / 2; j++) {
        const k0 = i * shoe.nt + j, k1 = k0 + 1;
        const a = shoe.openVal[k0], b = shoe.openVal[k1];
        if ((a <= 0 && b > 0) || (a > 0 && b <= 0)) {
          const f = a / (a - b);
          const p = new THREE.Vector3();
          for (let axis = 0; axis < 3; axis++) {
            p.setComponent(axis, positions[k0 * 3 + axis] * (1 - f) + positions[k1 * 3 + axis] * f);
          }
          crosses.push(p);
        }
      }
      if (crosses.length === 2) { collarA.push(crosses[0]); collarB.push(crosses[1]); }
    }
    attachTube(collarA.concat(collarB.reverse()), model.id === 'derby' ? 2.1 : 3.4, trimMaterial, true);
    const insole = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ color: '#292e28', roughness: 1, side: THREE.DoubleSide }));
    insole.rotation.x = -Math.PI / 2;
    insole.scale.set(shoe.S * 0.14, shoe.shape.Hs * 0.40, 1);
    insole.position.set(shoe.S * 0.15, 9, 0);
    this.productGroup.add(insole);

    // Tongue, eyelet panels and crossed round laces distinguish footwear from a bare last.
    if (model.lacing) {
      this.productGroup.add(ribbon(shoe, shoe.S * 0.31, shoe.S * 0.67, -0.35, 0.35, 3, panelMaterial));
      for (const sign of [-1, 1]) {
        this.productGroup.add(ribbon(shoe, shoe.S * 0.35, shoe.S * 0.65, sign * 0.30, sign * 0.46, 3.6, trimMaterial));
        const edge = [];
        for (let i = 0; i < 18; i++) edge.push(upperPoint(shoe, shoe.S * (0.35 + i / 17 * 0.30), sign * 0.49, 4.4));
        attachTube(edge, 0.45, stitchMaterial);
      }
      const count = model.id === 'trail' ? 7 : model.id === 'derby' ? 4 : 6;
      for (let i = 0; i < count; i++) {
        const x = shoe.S * (0.37 + i / (count - 1) * 0.25);
        for (const sign of [-1, 1]) {
          const eyelet = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.7, 6, 14), trimMaterial);
          eyelet.position.copy(upperPoint(shoe, x, sign * 0.38, 5.1));
          eyelet.rotation.x = Math.PI / 2;
          this.productGroup.add(eyelet);
        }
        if (i < count - 1) {
          const next = shoe.S * (0.37 + (i + 1) / (count - 1) * 0.25);
          for (const sign of [-1, 1]) {
            const points = [];
            for (let step = 0; step <= 6; step++) {
              const t = step / 6;
              points.push(upperPoint(shoe, x + (next - x) * t, sign * (0.38 - 0.76 * t), 5.7 + Math.sin(Math.PI * t) * 1.2));
            }
            attachTube(points, model.id === 'derby' ? 0.85 : 1.15, laceMaterial);
          }
        }
      }
    }
    // Side reinforcement and toe seam give an immediately legible product silhouette.
    for (const sign of [-1, 1]) {
      this.productGroup.add(ribbon(shoe, shoe.S * 0.28, shoe.S * 0.67, sign * 0.77, sign * 0.95, 2.8, panelMaterial));
      const edge = [];
      for (let i = 0; i < 28; i++) edge.push(upperPoint(shoe, shoe.S * (0.25 + i / 27 * 0.51), sign * 0.95, 3.8));
      attachTube(edge, 0.55, stitchMaterial);
    }
    const toeSeam = [];
    for (let i = 0; i <= 30; i++) toeSeam.push(upperPoint(shoe, shoe.S * 0.78, -0.97 + i / 30 * 1.94, 2.7));
    attachTube(toeSeam, model.id === 'derby' ? 0.38 : 0.55, stitchMaterial);
    this.dirty = true;
  };

  Viewer.prototype.updateDimensions = function () {
    disposeObject(this.dimensionGroup);
    this.dimensionGroup.clear();
    this.scene.add(this.dimensionGroup);
    if (!this.last) return;
    const { shoe } = this.last.display, model = this.last.model;
    const size = shoe.S;
    const base = LF.product.dimensions(model, size, 0, 0.5);
    const widthIndex = (shoe.shape.Wb - base.width) / 4.5;
    const lacing = model.lacing ? 0.5 - (shoe.shape.Is - base.instepHeight - widthIndex * 1.6) / 8 : 0.5;
    const d = LF.product.dimensions(model, size, widthIndex, lacing);
    const floor = -model.sole.heel - 0.8;
    const lineMaterial = new THREE.LineBasicMaterial({ color: '#477e67', transparent: true, opacity: 0.9, depthTest: false });
    const line = (points) => {
      const object = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p))), lineMaterial);
      object.renderOrder = 7;
      this.dimensionGroup.add(object);
    };
    const label = (text, position) => {
      const object = dimensionLabel(text); object.position.set(...position); this.dimensionGroup.add(object);
    };
    const text = (v) => Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1);
    const z = d.width / 2 + 33;
    line([[-d.length / 2, floor + 3, z], [d.length / 2, floor + 3, z]]);
    for (const x of [-d.length / 2, d.length / 2]) line([[x, floor + 3, z - 6], [x, floor + 3, z + 6]]);
    label(`내부 길이 ${text(d.length)} mm`, [0, floor + 14, z + 12]);
    const x = d.length / 2 + 30;
    line([[x, floor + 3, -d.width / 2], [x, floor + 3, d.width / 2]]);
    for (const side of [-d.width / 2, d.width / 2]) line([[x - 6, floor + 3, side], [x + 6, floor + 3, side]]);
    label(`내부 볼 너비 ${text(d.width)} mm`, [x + 4, floor + 15, 0]);
    const hx = -d.length / 2 - 23, hz = -d.width / 2 - 12;
    line([[hx, 0, hz], [hx, d.instepHeight, hz]]);
    for (const y of [0, d.instepHeight]) line([[hx - 6, y, hz], [hx + 6, y, hz]]);
    label(`발등 내부 높이 ${text(d.instepHeight)} mm`, [hx, d.instepHeight + 20, hz]);
    this.dimensionGroup.visible = this.showDimensions;
  };

  Viewer.prototype.applyVisibility = function () {
    this.updateAnatomyOpacity();
    if (this.footPreview) {
      this.footMesh.visible=this.legMesh.visible=true;
      this.shellMesh.visible=this.soleMesh.visible=this.productGroup.visible=this.dimensionGroup.visible=false;
      if(this.productAsset)this.productAsset.visible=false;
      this.cutFrame.visible=false;this.clip.constant=1e5;this.grid.material.opacity=.18;
      this.dirty=true;return;
    }
    const product = this.mode === 'product';
    this.footMesh.visible = !product;
    this.legMesh.visible = !product;
    this.shellMesh.visible = !product && this.showShoe && !this.productAsset;
    this.soleMesh.visible = this.showShoe && !this.productAsset;
    this.productGroup.visible = product && this.showShoe && !this.productAsset;
    if (this.productAsset) this.productAsset.visible = this.showShoe;
    this.dimensionGroup.visible = this.showDimensions;
    this.grid.material.opacity = product ? 0.14 : 0.28;
    const xModel = this.sectionPosition;
    if (xModel == null) {
      this.clip.constant = 1e5;
      this.cutFrame.visible = false;
    } else {
      const xw = this.root.position.x + xModel;
      this.clip.constant = xw;
      this.cutFrame.position.set(xw, 0, 0);
      this.cutFrame.visible = true;
    }
    this.dirty = true;
  };

  Viewer.prototype.setAutoRotate = function (on) {
    this.autoRotate = Boolean(on);
    this.dirty = true;
  };

  Viewer.prototype.resetView = function () {
    this.setView('persp');
  };

  Viewer.prototype.setDimensions = function (on) {
    this.showDimensions = Boolean(on);
    this.dimensionGroup.visible = this.showDimensions;
    this.dirty = true;
  };

  // The library owns the parsed template. The viewer owns independent geometry,
  // material and texture instances, so switching/deforming a model cannot alter it.
  Viewer.prototype.setCalibratedAsset = function (object, registration, options) {
    options = options || {};
    if (!object || !object.isObject3D || !registration || !Array.isArray(registration.meshes) || !registration.meshes.length) {
      throw new TypeError('실제 치수로 보정한 3D 신발 모델이 필요합니다.');
    }
    const group = new THREE.Group(), meshes = [], materialCopies = new Map(), textureCopies = new Map(), materials = new Map();
    group.userData.name = options.name || '가져온 제품 모델';
    const copyTexture = (original) => {
      if (!textureCopies.has(original)) {
        const copy = original.clone(); copy.needsUpdate = true; textureCopies.set(original, copy);
      }
      return textureCopies.get(original);
    };
    const copyMaterial = (original) => {
      if (!original) original = new THREE.MeshStandardMaterial({ color: '#c5cbc7', roughness: 0.85 });
      if (materialCopies.has(original)) return materialCopies.get(original);
      const copy = original.clone();
      copy.onBeforeCompile = original.onBeforeCompile;
      // r128's GLTFLoader enables a tangent shader and reverses normalScale.y
      // when a source TANGENT exists. Canonical geometry drops those tangents;
      // switch the owned material to derivative TBN as well, or it reads a zero
      // missing attribute and renders a black upper. Restore glTF's derivative
      // normal-map sign without mutating the cached source material.
      if (original.vertexTangents) {
        copy.vertexTangents = false;
        if (copy.normalScale) copy.normalScale.y *= -1;
        if (copy.clearcoatNormalScale) copy.clearcoatNormalScale.y *= -1;
      }
      copy.skinning = false; copy.morphTargets = false; copy.morphNormals = false;
      for (const [key, value] of Object.entries(copy)) if (value && value.isTexture) copy[key] = copyTexture(value);
      if (copy.uniforms) for (const uniform of Object.values(copy.uniforms)) {
        if (uniform && uniform.value && uniform.value.isTexture) uniform.value = copyTexture(uniform.value);
      }
      copy.clippingPlanes = [this.clip];
      materialCopies.set(original, copy);
      materials.set(copy, {
        opacity: original.opacity, transparent: original.transparent, depthWrite: original.depthWrite,
        vertexColors: Boolean(original.vertexColors), color: original.color ? original.color.clone() : null,
      });
      return copy;
    };
    try {
      registration.meshes.forEach((entry) => {
        const source = entry.mesh, baseline = entry.canonicalPositions;
        if (!source || !source.geometry || !baseline || !baseline.length || baseline.length % 3 ||
            baseline.length !== source.geometry.getAttribute('position').count * 3) {
          throw new RangeError('보정된 3D 정점 정보가 올바르지 않습니다.');
        }
        const originalPositions = new Float32Array(baseline);
        for (const value of originalPositions) if (!Number.isFinite(value)) throw new RangeError('3D 모델에 유효하지 않은 치수가 있습니다.');
        const geometry = source.geometry.clone();
        geometry.setAttribute('position', new THREE.BufferAttribute(originalPositions.slice(), 3));
        // Baking the canonical transform also invalidates stored skin/morph/tangent transforms.
        geometry.deleteAttribute('skinIndex'); geometry.deleteAttribute('skinWeight'); geometry.deleteAttribute('tangent');
        geometry.morphAttributes = {};
        if (typeof entry.toCanonical === 'function') {
          const origin = entry.toCanonical({ x: 0, y: 0, z: 0 });
          const bases = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }].map((p) => {
            const q = entry.toCanonical(p); return { x: q.x - origin.x, y: q.y - origin.y, z: q.z - origin.z };
          });
          const [a, b, c] = bases;
          const determinant = a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x);
          // A mirrored source node or width axis changes winding when baked.
          // Correct it before normals are recalculated, preserving the outer face.
          if (determinant < 0) {
            const index = geometry.index;
            const count = index ? index.count : originalPositions.length / 3;
            const values = new Uint32Array(count);
            for (let k = 0; k < count; k++) values[k] = index ? index.getX(k) : k;
            for (let k = 0; k + 2 < count; k += 3) { const temp = values[k + 1]; values[k + 1] = values[k + 2]; values[k + 2] = temp; }
            geometry.setIndex(new THREE.BufferAttribute(values, 1));
          }
        }
        geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
        const canonicalNormals = geometry.getAttribute('normal');
        const originalNormals = canonicalNormals ? canonicalNormals.array.slice() : null;
        const list = Array.isArray(source.material) ? source.material.map(copyMaterial) : copyMaterial(source.material);
        const mesh = new THREE.Mesh(geometry, list);
        mesh.name = source.name;
        mesh.renderOrder = 2;
        const colorAttribute = geometry.getAttribute('color');
        const colorSize = colorAttribute ? colorAttribute.itemSize : 3;
        let originalColors = null;
        if (colorAttribute) {
          originalColors = new Float32Array(colorAttribute.count * colorSize);
          const array = colorAttribute.array || (colorAttribute.data && colorAttribute.data.array);
          const normalize = (v) => !colorAttribute.normalized ? v
            : array instanceof Uint8Array ? v / 255
              : array instanceof Uint16Array ? v / 65535
                : array instanceof Int8Array ? Math.max(-1, v / 127)
                  : array instanceof Int16Array ? Math.max(-1, v / 32767) : v;
          for (let k = 0; k < colorAttribute.count; k++) {
            originalColors[k * colorSize] = normalize(colorAttribute.getX(k));
            originalColors[k * colorSize + 1] = normalize(colorAttribute.getY(k));
            originalColors[k * colorSize + 2] = normalize(colorAttribute.getZ(k));
            if (colorSize === 4) originalColors[k * colorSize + 3] = normalize(colorAttribute.getW(k));
          }
          geometry.setAttribute('color', new THREE.BufferAttribute(originalColors.slice(), colorSize));
        }
        group.add(mesh);
        const fixedMask = entry.fixedSoleMask ? new Uint8Array(entry.fixedSoleMask) : entry.supportFloorMask ? new Uint8Array(entry.supportFloorMask) : null;
        const lining = LF.diorLining && LF.diorLining.prepare(registration, originalPositions, geometry.index, fixedMask);
        meshes.push({
          mesh, originalPositions, originalNormals, originalColors, colorSize,
          fixedMask, fitBasePositions: lining && lining.positions,
          originalIndex: geometry.index, fitIndex: lining && new THREE.BufferAttribute(lining.indices, 1), liningPreparation: lining && lining.stats,
          pressures: new Float32Array(originalPositions.length / 3),
          pressureUnknown: new Uint8Array(originalPositions.length / 3),
          zones: new Uint8Array(originalPositions.length / 3),
          rigidSole: /(?:^|[\s_.-])(?:outsole|midsole|sole|rubber)(?:$|[\s_.-])/i.test(source.name || ''),
        });
      });
    } catch (error) {
      disposeObject(group);
      throw error;
    }
    this.clearProductAsset();
    this.productAsset = group;
    this.assetSource = object;
    this.assetRegistration = registration;
    this.assetMaterials = materials;
    this.assetMeshes = meshes;
    this.assetAxis = registration.calibration && registration.calibration.axis;
    this.assetAutoAxis = this.assetAxis || 'x';
    this.assetReverse = Boolean(registration.calibration && registration.calibration.reverse);
    this.assetOpacity = options.opacity == null ? 0.3 : clamp(Number(options.opacity), 0, 1);
    if (!Number.isFinite(this.assetOpacity)) this.assetOpacity = 0.3;
    // Shared reflection and root translation put the imported exterior and foot
    // in the same heel→toe, insole-at-zero, millimetre frame.
    this.root.add(group);
    if(!options.deferDeformation) {
      this.deformAsset();
      this.paintAsset();
    }
    this.updateAssetFloor();
    this.applyVisibility();
    this.dirty = true;
  };

  Viewer.prototype.setProductAsset = function (object, options) {
    options = options || {};
    if (!LF.glbFit || typeof LF.glbFit.analyzeScene !== 'function') throw new Error('3D 치수 보정 도구를 불러오지 못했습니다.');
    const registration = options.registration || LF.glbFit.analyzeScene(object, options.calibration || options);
    this.setCalibratedAsset(object, registration, options);
  };

  // Calibration is fixed when selected. Editing the foot, lacing or internal
  // dimensions must never silently stretch the product to a guessed exterior size.
  Viewer.prototype.normalizeProductAsset = function () {};

  Viewer.prototype.setAssetOrientation = function (axis, reverse) {
    if (axis == null || axis === 'auto') axis = this.assetAutoAxis || 'x';
    if (!['x', 'y', 'z'].includes(axis)) throw new RangeError('길이 축은 X, Y, Z 중 선택해 주세요.');
    if (!this.assetSource || !LF.glbFit) return;
    const calibration = this.assetRegistration.calibration || {};
    const options = { ...(calibration.options || calibration), axis, reverse: Boolean(reverse) };
    const registration = LF.glbFit.analyzeScene(this.assetSource, options);
    this.setCalibratedAsset(this.assetSource, registration, { name: this.productAsset.userData.name, opacity: this.assetOpacity });
  };

  Viewer.prototype.setAssetOpacity = function (value) {
    const opacity = Number(value);
    if (!Number.isFinite(opacity)) return;
    this.assetOpacity = clamp(opacity, 0, 1);
    this.paintAsset();
  };

  Viewer.prototype.updateAssetFloor = function () {
    if (!this.assetRegistration) return;
    const calibration = this.assetRegistration.calibration || {};
    const floor = -Number(calibration.soleThickness || 0) - 0.8;
    this.grid.position.y = floor;
    this.shadow.position.set(0, floor + 0.3, 0);
    const d = this.assetRegistration.dimensions;
    if (d) this.shadow.scale.set(d.length * 1.3, d.width * 1.4, 1);
  };

  // Logical layers belong to this calibrated runtime instance. The original GLB
  // and its render primitives remain intact; this proxy is never an upper mesh.
  Viewer.prototype.updateContactLayers = function (shoe) {
    if (!this.productAsset || !LF.plantarContact || this.contactLayerKey === shoe) return;
    if (this.contactLayers) disposeObject(this.contactLayers);
    this.contactLayers = null;
    this.contactLayerKey = shoe;
    const surface = LF.plantarContact.surfaceGeometry(shoe);
    if (!surface) return;
    const layers = new THREE.Group();
    layers.name = 'ContactLayers';
    layers.visible = false;
    layers.userData = { role: 'simulation-contact-layers', originalGlbModified: false };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
    geometry.setAttribute('supportVerified', new THREE.BufferAttribute(surface.verifiedMask, 1));
    geometry.setAttribute('supportEstimated', new THREE.BufferAttribute(surface.estimatedMask, 1));
    geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({ color: 0x73a695, side: THREE.DoubleSide, wireframe: true });
    const insole = new THREE.Mesh(geometry, material);
    insole.name = 'Insole_ContactSurface';
    insole.userData = { role: 'fixed-insole-support', source: surface.source,
      sourceProfile: surface.sourceProfile, physicalModel: surface.physicalModel,
      measurement: surface.measurement };
    layers.add(insole);
    this.productAsset.add(layers);
    this.contactLayers = layers;
  };

  Viewer.prototype.deformAsset = function () {
    if (!this.productAsset || !this.assetMeshes.length) return;
    const fit = LF.glbFit, drape = LF.contactDrape, display = this.last && this.last.display, deform = this.last && this.last.deform;
    if (display && LF.diorFit && LF.diorFit.enabled(display.shoe.model)) {
      this.deformDiorAsset(display, deform);
      return;
    }
    const renderPositions = display && (display.compressedFpos || deform.fpos);
    let cache = this.assetDrapeCache;
    if (!cache || cache.display !== display || cache.deform !== deform || cache.renderPositions !== renderPositions ||
        cache.closure !== (display && display.contactClosure) || cache.solver !== drape) {
      const field = display && fit && fit.createDeformationField ? fit.createDeformationField(display, deform.defl) : null;
      const collider = drape && drape.prepare && display && display.foot ? drape.prepare(display) : null;
      cache = { display, deform, renderPositions, closure: display && display.contactClosure, solver: drape, field, collider,
        parts: new Map(), maxMm: 0, closeMm: 0, maxDisplacementMm: 0, deformedVertexCount: 0, vertexCount: 0,
        collisionStats: emptyCollisionStats() };
      this.assetMeshes.forEach((entry) => {
        const { mesh, originalPositions, pressures, zones } = entry;
        if (!entry.pressureUnknown) entry.pressureUnknown = new Uint8Array(pressures.length);
        const mapped = new Float32Array(originalPositions.length), stretchVectors = new Float32Array(originalPositions.length), closeVectors = new Float32Array(originalPositions.length);
        for (let i = 0, k = 0; i < originalPositions.length; i += 3, k++) {
          const x = originalPositions[i], y = originalPositions[i + 1], z = originalPositions[i + 2];
          const sampled = field ? fit.displacementAt(field, x, y, z) : { x: 0, y: 0, z: 0, pressure: 0, material: GM.M.UPPER };
          const fixed = entry.rigidSole || y <= 0 || entry.fixedMask && entry.fixedMask[k];
          let dx = fixed ? 0 : Number(sampled.x) || 0, dy = fixed ? 0 : Number(sampled.y) || 0, dz = fixed ? 0 : Number(sampled.z) || 0;
          const separate = Number.isFinite(sampled.stretchX) && Number.isFinite(sampled.closeX);
          for (let axis = 0; axis < 3; axis++) {
            const total = [dx, dy, dz][axis], suffix = ['X', 'Y', 'Z'][axis];
            stretchVectors[i + axis] = fixed ? 0 : separate ? Number(sampled['stretch' + suffix]) || 0 : total;
            closeVectors[i + axis] = 0;
          }
          // The proxy cavity's normal can point into a detailed GLB lining or
          // heel panel. Keep the solved stretch magnitude/pressure, but direct
          // it along the actual canonical garment's outward anatomical guide.
          if (!fixed && field && field.shoe && drape && drape.outwardDirection) {
            const normals = entry.originalNormals;
            const guide = drape.outwardDirection(x, y, z, normals ? normals[i] : 0, normals ? normals[i + 1] : 0,
              normals ? normals[i + 2] : 0, collider, field);
            const requestedMm = Number.isFinite(sampled.stretch) ? Math.max(0, sampled.stretch)
              : Math.hypot(stretchVectors[i], stretchVectors[i + 1], stretchVectors[i + 2]);
            let zone=sampled.material == null ? sampled.mat == null ? GM.M.UPPER : sampled.mat : sampled.material;
            if(zone===GM.M.INSOLE)zone=GM.M.UPPER;
            const mp=display.shoe.mats && display.shoe.mats[zone];
            const solvedMm=drape.materialStretchLimit && mp ? Math.min(requestedMm,drape.materialStretchLimit(mp,display.ctx && display.ctx.b)) : requestedMm;
            stretchVectors[i] = guide.x * solvedMm; stretchVectors[i + 1] = guide.y * solvedMm; stretchVectors[i + 2] = guide.z * solvedMm;
          }
          dx = stretchVectors[i] + closeVectors[i]; dy = stretchVectors[i + 1] + closeVectors[i + 1]; dz = stretchVectors[i + 2] + closeVectors[i + 2];
          mapped[i] = x + dx; mapped[i + 1] = y + dy; mapped[i + 2] = z + dz;
          const mm = Math.hypot(dx, dy, dz);
          if (mm > 0.0001) cache.deformedVertexCount++;
          const stretch = fixed ? 0 : Math.hypot(stretchVectors[i],stretchVectors[i+1],stretchVectors[i+2]);
          const close = 0;
          cache.maxMm = Math.max(cache.maxMm, stretch); cache.closeMm = Math.max(cache.closeMm, close);
          cache.maxDisplacementMm = Math.max(cache.maxDisplacementMm, mm); cache.vertexCount++;
          entry.pressureUnknown[k] = sampled.pressureUnknown > 0.05 ? 1 : 0;
          pressures[k] = Number(sampled.pressure) || 0;
          zones[k] = fixed ? GM.M.INSOLE : sampled.material == null ? sampled.mat == null ? GM.M.UPPER : sampled.mat : sampled.material;
          if(!fixed && zones[k]===GM.M.INSOLE)zones[k]=GM.M.UPPER;
        }
        const input = { positions: mapped, originalPositions, index: mesh.geometry.index, normals: entry.originalNormals,
          elasticVectors: stretchVectors, closureVectors: closeVectors, fixedMask: entry.fixedMask, field, collider, zones, wearB:display && display.ctx && display.ctx.b, meshName: mesh.name };
        const solved = collider && drape.solve ? drape.solve(input, { fixedAll: entry.rigidSole }) : { positions: mapped, stats: {} };
        const stats = solved.stats || {};
        for (const key of ['collisionCorrectedVertexCount', 'contactVertexCount', 'elasticLimitExceededVertexCount', 'rigidContactVertexCount','displacementLimitedVertexCount']) {
          cache.collisionStats[key] += Number(stats[key]) || 0;
        }
        for (const key of ['remainingPenetrationMm', 'remainingFlexiblePenetrationMm', 'remainingRigidPenetrationMm', 'initialPenetrationMm', 'maxDrapeMm', 'collisionReactionKPa', 'iterations','maxElasticExpansionMm','maxAllowedElasticExpansionMm','maxPhysicalDisplacementMm','maxInwardDisplacementMm']) {
          cache.collisionStats[key] = Math.max(cache.collisionStats[key], Number(stats[key]) || 0);
        }
        cache.parts.set(entry, { positions: solved.positions || mapped, mappedPositions: mapped, stretchVectors, closeVectors, stats,
          reactionsKPa: solved.reactionsKPa || null, visualVariants: new Map() });
      });
      this.assetDrapeCache = cache;
    }
    this.assetField = cache.field;
    const amount = Number.isFinite(this.exaggerate) ? this.exaggerate : 1;
    const worn = this.deformationEnabled !== false && this.mode !== 'product';
    let visualRemainingPenetrationMm = 0;
    this.assetMeshes.forEach((entry) => {
      const { mesh, originalPositions, zones } = entry;
      const part = cache.parts.get(entry);
      const positions = mesh.geometry.getAttribute('position').array;
      let result = { positions: originalPositions, stats: {} };
      if (worn && amount === 1) result = { positions: part.positions, stats: part.stats };
      else if (worn) {
        result = part.visualVariants.get(amount);
        if (!result) {
          const mapped = new Float32Array(originalPositions.length);
          for (let i = 0; i < mapped.length; i++) mapped[i] = originalPositions[i] + part.closeVectors[i] + part.stretchVectors[i] * amount;
          // Exaggeration is a visual comparison. Run the same contact pass on it
          // rather than allowing an exaggerated upper to cut through the foot.
          const exaggeratedElastic = part.stretchVectors.map((v) => v * amount);
          const input = { positions: mapped, originalPositions, index: mesh.geometry.index, normals: entry.originalNormals,
            elasticVectors: exaggeratedElastic, closureVectors: part.closeVectors, fixedMask: entry.fixedMask,
            field: cache.field, collider: cache.collider, zones, wearB:display && display.ctx && display.ctx.b, meshName: mesh.name };
          result = cache.collider && drape.solve ? drape.solve(input, { fixedAll: entry.rigidSole }) : { positions: mapped, stats: {} };
          part.visualVariants.set(amount, result);
        }
      }
      positions.set(result.positions);
      visualRemainingPenetrationMm = Math.max(visualRemainingPenetrationMm, Number(result.stats && result.stats.remainingPenetrationMm) || 0);
      entry.collisionReactions = part.reactionsKPa;
      mesh.geometry.getAttribute('position').needsUpdate = true;
      mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingSphere(); mesh.geometry.computeBoundingBox();
    });
    this.assetStats = { maxMm: cache.maxMm, stretchMm: cache.maxMm, closeMm: cache.closeMm, snugClosureMm: cache.closeMm,
      maxDisplacementMm: cache.maxDisplacementMm, deformedVertexCount: cache.deformedVertexCount, vertexCount: cache.vertexCount,
      ...cache.collisionStats, visualRemainingPenetrationMm, collisionSolverAvailable: Boolean(cache.collider),
      exaggeration: amount, enabled: this.deformationEnabled !== false, worn };
    this.dirty = true;
  };

  // Dior's layered render islands follow one solved garment surface. Running
  // another independent collision solve per island would separate glued layers.
  Viewer.prototype.deformDiorAsset = function (display, deform) {
    const physics = LF.diorFit, profile = display.shoe.model.fitPhysicsProfile, renderPositions = display.compressedFpos || deform.fpos;
    let cache = this.assetDrapeCache;
    if (!cache || cache.profile !== profile || cache.display !== display || cache.deform !== deform || cache.renderPositions !== renderPositions) {
      const raw = LF.glbFit.createDeformationField(display, deform.defl);
      const field = physics.enhanceField(raw, display);
      const collider = LF.contactDrape.prepare(display);
      const parts = physics.renderPositions(this.assetMeshes, field, display);
      const collisionStats = emptyCollisionStats();
      let vertexCount = 0, deformedVertexCount = 0, maxMm = 0;
      for (const entry of this.assetMeshes) {
        const part = parts.get(entry), stats = part.stats || {};
        part.visualVariants = part.visualVariants || new Map();
        if (!entry.pressureUnknown) entry.pressureUnknown = new Uint8Array(entry.pressures.length);
        for (let k = 0; k < entry.pressures.length; k++) {
          const i = k * 3, source = entry.originalPositions;
          const sampled = LF.glbFit.displacementAt(field, source[i], source[i + 1], source[i + 2]);
          const fixed = part.fixedMask ? part.fixedMask[k] : entry.rigidSole || source[i + 1] <= 0 || entry.fixedMask && entry.fixedMask[k];
          entry.pressures[k] = fixed ? 0 : Number(sampled.pressure) || 0;
          entry.pressureUnknown[k] = !fixed && sampled.pressureUnknown > .05 ? 1 : 0;
          entry.zones[k] = fixed ? GM.M.INSOLE : sampled.mat === GM.M.INSOLE ? GM.M.UPPER : sampled.mat;
          const baseline = entry.fitBasePositions || source;
          const displacement = Math.hypot(part.positions[i] - baseline[i], part.positions[i + 1] - baseline[i + 1], part.positions[i + 2] - baseline[i + 2]);
          if (displacement > .0001) deformedVertexCount++;
          maxMm = Math.max(maxMm, displacement);
          vertexCount++;
        }
        for (const key of ['collisionCorrectedVertexCount', 'contactVertexCount', 'elasticLimitExceededVertexCount', 'rigidContactVertexCount', 'displacementLimitedVertexCount'])
          collisionStats[key] += Number(stats[key]) || 0;
        for (const key of Object.keys(collisionStats)) if (!/Count$/.test(key))
          collisionStats[key] = Math.max(collisionStats[key], Number(stats[key]) || 0);
      }
      cache = this.assetDrapeCache = { profile, display, deform, renderPositions, field, collider, parts,
        maxMm, vertexCount, deformedVertexCount, collisionStats, closeMm: 0, maxDisplacementMm: maxMm };
    }
    this.assetField = cache.field;
    const worn = this.deformationEnabled !== false && this.mode !== 'product';
    for (const entry of this.assetMeshes) {
      const part = cache.parts.get(entry), geometry = entry.mesh.geometry;
      geometry.getAttribute('position').array.set(worn ? part.positions : entry.originalPositions);
      const index = worn && entry.fitIndex || entry.originalIndex;
      if(index && geometry.index !== index)geometry.setIndex(index);
      geometry.getAttribute('position').needsUpdate = true;
      geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
      entry.collisionReactions = part.reactionsKPa || null;
    }
    this.assetStats = { maxMm: cache.maxMm, stretchMm: cache.maxMm, closeMm: 0, snugClosureMm: 0,
      maxDisplacementMm: cache.maxMm, deformedVertexCount: cache.deformedVertexCount, vertexCount: cache.vertexCount,
      ...cache.collisionStats, visualRemainingPenetrationMm: cache.collisionStats.remainingPenetrationMm,
      collisionSolverAvailable: true, exaggeration: 1, enabled: this.deformationEnabled !== false, worn,
      fitPhysicsProfile: profile, shell: cache.field.shellStats };
    this.dirty = true;
  };

  Viewer.prototype.deformationStats = function () {
    return { ...this.assetStats };
  };

  Viewer.prototype.paintAsset = function () {
    if (!this.productAsset || !this.assetMaterials) return;
    const product = this.mode === 'product', materialMode = this.mode === 'material';
    this.updateAnatomyOpacity();
    // The dense GLB includes lining and layered panels. Normal depth occlusion
    // keeps those hidden behind the exterior while fit colours remain visible.
    const opacity = materialMode ? Math.max(this.assetOpacity, .65) : 1;
    this.assetMaterials.forEach((original, material) => {
      const vertexColors = product ? original.vertexColors : true;
      const transparent = opacity < 1 || original.transparent;
      if (material.vertexColors !== vertexColors || material.transparent !== transparent) material.needsUpdate = true;
      material.opacity = original.opacity * opacity;
      material.transparent = transparent;
      material.depthWrite = opacity < 1 ? false : original.depthWrite;
      material.vertexColors = vertexColors;
      if (original.color && material.color) material.color.copy(original.color);
    });
    const mats = MAT_COLORS.map((h) => new THREE.Color(h).convertSRGBToLinear());
    const color = new THREE.Color(), white = new THREE.Color(1, 1, 1);
    this.assetMeshes.forEach((entry) => {
      const geometry = entry.mesh.geometry;
      if (product) {
        if (entry.originalColors) setAttr(geometry, 'color', entry.originalColors, entry.colorSize);
        else geometry.deleteAttribute('color');
        return;
      }
      const colors = new Float32Array(entry.pressures.length * entry.colorSize);
      for (let k = 0; k < entry.pressures.length; k++) {
        if (materialMode) color.copy(mats[entry.zones[k]] || mats[0]).lerp(white, 0.1);
        else if (entry.pressureUnknown && entry.pressureUnknown[k]) color.copy(UNKNOWN_PRESSURE);
        else if (entry.pressures[k] > 0) heatColor(entry.pressures[k], color).lerp(white, 0.45);
        else color.copy(white);
        const i = k * entry.colorSize;
        colors[i] = color.r * (entry.originalColors ? entry.originalColors[i] : 1);
        colors[i + 1] = color.g * (entry.originalColors ? entry.originalColors[i + 1] : 1);
        colors[i + 2] = color.b * (entry.originalColors ? entry.originalColors[i + 2] : 1);
        if (entry.colorSize === 4) colors[i + 3] = entry.originalColors ? entry.originalColors[i + 3] : 1;
      }
      setAttr(geometry, 'color', colors, entry.colorSize);
    });
    this.dirty = true;
  };

  Viewer.prototype.clearProductAsset = function () {
    if (this.productAsset) disposeObject(this.productAsset);
    this.productAsset = null;
    this.contactLayers = null;
    this.contactLayerKey = null;
    this.assetOrientation = null;
    this.assetSource = null;
    this.assetRegistration = null;
    this.assetMaterials = null;
    this.assetMeshes = [];
    this.assetField = null;
    this.assetDrapeCache = null;
    this.assetStats = { maxMm: 0, stretchMm: 0, closeMm: 0, snugClosureMm: 0, maxDisplacementMm: 0, deformedVertexCount: 0, vertexCount: 0,
      ...emptyCollisionStats(), visualRemainingPenetrationMm: 0, collisionSolverAvailable: false,
      exaggeration: this.exaggerate || 1, enabled: this.deformationEnabled !== false, worn: this.deformationEnabled !== false && this.mode !== 'product' };
    if (this.last) {
      const floor = -this.last.model.sole.heel - 0.8;
      this.grid.position.y = floor;
      this.shadow.position.set(0, floor + 0.3, 0);
      this.shadow.scale.set(this.last.display.shoe.Ls * 1.45, 150, 1);
    }
    this.applyVisibility();
  };

  Viewer.prototype.deformShell = function () {
    if (!this.last) return;
    const { display, deform } = this.last;
    const shoe = display.shoe;
    const worn = display.wornLast || shoe;
    const wearing = this.deformationEnabled !== false && this.mode !== 'product';
    const amount = wearing ? this.exaggerate : 0;
    const pos = new Float32Array(shoe.n * 3);
    const wall = 1.8;
    for (let k = 0; k < shoe.n; k++) {
      for (let axis = 0; axis < 3; axis++) {
        const i = k * 3 + axis;
        pos[i] = shoe.pos[i] + shoe.nrm[i] * wall
          + amount * worn.nrm[i] * Math.max(0, deform.defl[k]);
      }
    }
    setAttr(this.shellGeo, 'position', pos, 3);
    this.shellGeo.computeVertexNormals();
    this.shellGeo.computeBoundingSphere();
  };

  Viewer.prototype.paintFoot = function () {
    if (!this.footPreview && !this.last) return;
    const foot=this.footPreview ? this.previewFootData : this.last.display.foot;
    const sim=this.footPreview ? null : this.fitSimulation(this.last.display);
    const col = new Float32Array(foot.n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < foot.n; i++) {
      if (this.footPreview || this.mode !== 'fit' || sim.ex[i]) c.copy(this.skin);
      else if (sim.pressureStatus && sim.pressureStatus[i] === 1) c.copy(UNKNOWN_PRESSURE);
      else if (foot.zone[i] === GM.Z.SOLE || foot.zone[i] === GM.Z.ARCH) heatColor(Math.max(-1.5, Math.min(sim.eff[i], 0)) * 0.6, c);
      else heatColor(sim.P[i] > 0 ? sim.P[i] : sim.eff[i], c);
      col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
    }
    setAttr(this.footGeo, 'color', col, 3);
  };

  // A local membrane pressure is not a verified result where the added shared
  // shell constraints still leave contact unresolved. Mask that display without
  // changing the engine's local equilibrium data or measured source geometry.
  Viewer.prototype.fitSimulation = function (display) {
    const sim = display.sim, cache = this.assetDrapeCache;
    if (!sim || !sim.pressureStatus || !LF.diorFit || !LF.diorFit.enabled(display.shoe.model) ||
        !cache || cache.display !== display || !cache.field || !cache.field.shellStats) return sim;
    if (cache.viewSim) return cache.viewSim;
    const unknown = cache.field.pressureUnknown, status = sim.pressureStatus.slice(), valid = sim.pressureValid.slice();
    for (let i = 0; i < status.length; i++) {
      if (sim.ex[i] || status[i] !== 0) continue;
      let unresolved = 0;
      if (sim.contactVertices && sim.contactBary) {
        for (let j = 0; j < 3; j++) {
          const q = sim.contactVertices[i * 3 + j];
          if (q >= 0) unresolved += (unknown[q] || 0) * sim.contactBary[i * 3 + j];
        }
      } else if (sim.near[i] >= 0) unresolved = unknown[sim.near[i]] || 0;
      if (unresolved > .05) { status[i] = 1; valid[i] = 0; }
    }
    return (cache.viewSim = { ...sim, pressureStatus: status, pressureValid: valid,
      pressureScope: 'local-equilibrium-with-shared-shell-constraint-mask' });
  };

  Viewer.prototype.paintShell = function () {
    if (!this.last) return;
    const shoe = this.last.display.shoe;
    const col = new Float32Array(shoe.n * 3);
    const mats = MAT_COLORS.map((h) => new THREE.Color(h).convertSRGBToLinear());
    for (let k = 0; k < shoe.n; k++) {
      const c = this.mode === 'material' ? mats[shoe.mat[k]] : this.shellColor;
      col[3 * k] = c.r; col[3 * k + 1] = c.g; col[3 * k + 2] = c.b;
    }
    setAttr(this.shellGeo, 'color', col, 3);
    this.shellMat.opacity = this.mode === 'material' ? 0.55 : 0.16;
    this.applyVisibility();
    this.dirty = true;
  };

  Viewer.prototype.setMode = function (mode) {
    this.mode = ['product', 'fit', 'material'].includes(mode) ? mode : 'fit';
    if (this.mode === 'material' || this.mode === 'product') this.showShoe = true;
    this.deformShell();
    this.deformAsset();
    this.paintFoot();
    this.paintShell();
    this.paintAsset();
    this.applyVisibility();
  };

  Viewer.prototype.setShowShoe = function (on) {
    this.showShoe = on;
    this.paintShell();
    this.applyVisibility();
  };

  Viewer.prototype.setExaggerate = function (f) {
    this.exaggerate = Number.isFinite(Number(f)) ? clamp(Number(f), 0, 8) : 1;
    this.deformShell();
    this.deformAsset();
    this.paintAsset();
    this.dirty = true;
  };

  Viewer.prototype.setDeformationEnabled = function (on) {
    this.deformationEnabled = Boolean(on);
    this.deformShell();
    this.deformAsset();
    this.paintAsset();
    this.dirty = true;
  };

  // xModel: 신발 프레임 x(mm). null이면 단면 해제
  Viewer.prototype.setSection = function (xModel) {
    this.sectionPosition = xModel;
    this.applyVisibility();
    this.dirty = true;
  };

  Viewer.heatColor = heatColor;
  Viewer.HEAT = HEAT;
  Viewer.MAT_COLORS = MAT_COLORS;
  LF.Viewer = Viewer;
})((window.LF = window.LF || {}));
