// LastFit — register GLB geometry in the millimetre fit frame and transfer contact deformation.
// The exterior envelope is measurable. Its internal cavity is an estimate until an internal scan is supplied.
(function (LF) {
  'use strict';
  const { clamp, smoothstep } = LF.util;
  const AXES = ['x', 'y', 'z'];
  const UNIT_MM = { m: 1000, cm: 10, mm: 1 };
  const DEMO_LENGTH_MM = 260;
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  function pointTransform(e, x, y, z) {
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const inv = w ? 1 / w : 1;
    return [(e[0] * x + e[4] * y + e[8] * z + e[12]) * inv,
      (e[1] * x + e[5] * y + e[9] * z + e[13]) * inv,
      (e[2] * x + e[6] * y + e[10] * z + e[14]) * inv];
  }

  // Strip only the display pose: retain the complete metric (scale, shear and reflection).
  // A proper orthogonal frame avoids silently turning a negative node scale into a second mirror.
  function neutralPoseMatrix(e) {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const columns = [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]];
    const lengths = columns.map((v) => Math.hypot(...v));
    if (lengths.some((value) => !Number.isFinite(value) || value < 1e-10)) throw new RangeError('GLB 노드의 축척이 유효하지 않습니다.');
    const determinant = dot(columns[0], cross(columns[1], columns[2]));
    const xSign = determinant < 0 ? -1 : 1;
    const qx = columns[0].map((v) => v / lengths[0] * xSign);
    const xy = dot(qx, columns[1]);
    const yResidual = columns[1].map((v, k) => v - xy * qx[k]);
    const yLength = Math.hypot(...yResidual);
    if (yLength < 1e-10) throw new RangeError('GLB 노드의 회전·축척을 분리할 수 없습니다.');
    const qy = yResidual.map((v) => v / yLength), qz = cross(qx, qy);
    const frame = [qx, qy, qz], out = IDENTITY.slice();
    for (let column = 0; column < 3; column++) for (let row = 0; row < 3; row++) out[column * 4 + row] = dot(frame[row], columns[column]);
    out[12] = out[13] = out[14] = 0;
    const inversePose = IDENTITY.slice();
    for (let column = 0; column < 3; column++) for (let row = 0; row < 3; row++) inversePose[column * 4 + row] = frame[row][column];
    for (let row = 0; row < 3; row++) inversePose[12 + row] = -dot(frame[row], [e[12], e[13], e[14]]);
    return { matrix: out, inversePose, worldScale: lengths, reflected: determinant < 0 };
  }

  function boundsOf(points) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const value = points[i + k];
        if (!Number.isFinite(value)) throw new RangeError('GLB에 유효하지 않은 정점 좌표가 있습니다.');
        min[k] = Math.min(min[k], value); max[k] = Math.max(max[k], value);
      }
    }
    return { min, max, size: max.map((value, k) => value - min[k]) };
  }

  function finiteDimension(value, fallback, min, max, label) {
    if (value == null || value === '') return fallback;
    const v = Number(value);
    if (!Number.isFinite(v) || v < min || v > max) throw new RangeError(`${label}은 ${min}~${max} mm로 입력해 주세요.`);
    return v;
  }

  function demoLengthOptions(options = {}) {
    return { ...options, outerLength: DEMO_LENGTH_MM, lengthSource: 'demo-preset' };
  }

  // Slice triangle edges, rather than only vertices: sparse CAD meshes still produce full profiles.
  function extractProfiles(meshes, outerLength, wallThickness, cavityInsetMm = wallThickness) {
    const count = 65, innerLength = outerLength - 2 * wallThickness;
    const rows = Array.from({ length: count }, (_, k) => ({ t: k / (count - 1), min: Infinity, max: -Infinity, top: -Infinity, allMin: Infinity, allMax: -Infinity }));
    function add(row, y, z) {
      row.top = Math.max(row.top, y);
      row.allMin = Math.min(row.allMin, z); row.allMax = Math.max(row.allMax, z);
      // The outsole flares out farther than the upper. Exclude the portion below the insole.
      if (y >= 1) { row.min = Math.min(row.min, z); row.max = Math.max(row.max, z); }
    }
    function edge(p, a, b) {
      const x0 = p[a * 3], x1 = p[b * 3], dx = x1 - x0;
      if (Math.abs(dx) < 1e-9) return;
      const lo = Math.max(0, Math.ceil(Math.min(x0, x1) / innerLength * (count - 1)));
      const hi = Math.min(count - 1, Math.floor(Math.max(x0, x1) / innerLength * (count - 1)));
      for (let r = lo; r <= hi; r++) {
        const f = (rows[r].t * innerLength - x0) / dx;
        add(rows[r], p[a * 3 + 1] + f * (p[b * 3 + 1] - p[a * 3 + 1]), p[a * 3 + 2] + f * (p[b * 3 + 2] - p[a * 3 + 2]));
      }
    }
    for (const item of meshes) {
      const p = item.canonicalPositions, geo = item.mesh.geometry;
      const index = geo.index;
      const n = index ? index.count : p.length / 3;
      const at = (k) => index ? (index.getX ? index.getX(k) : index.array[k]) : k;
      for (let k = 0; k + 2 < n; k += 3) {
        const a = at(k), b = at(k + 1), c = at(k + 2);
        edge(p, a, b); edge(p, b, c); edge(p, c, a);
      }
      // Also include vertices for a point-only / degenerate CAD surface.
      for (let k = 0; k < p.length; k += 3) {
        const r = clamp(Math.round(p[k] / innerLength * (count - 1)), 0, count - 1);
        add(rows[r], p[k + 1], p[k + 2]);
      }
    }
    const valid = rows.filter((r) => Number.isFinite(r.top) && Number.isFinite(r.allMin));
    if (valid.length < 3) throw new RangeError('신발의 3D 단면을 추출할 수 없습니다. 입체 신발 GLB를 사용해 주세요.');
    for (const row of rows) {
      if (!Number.isFinite(row.top)) {
        const nearest = valid.reduce((best, r) => Math.abs(r.t - row.t) < Math.abs(best.t - row.t) ? r : best);
        Object.assign(row, { min: nearest.min, max: nearest.max, top: nearest.top, allMin: nearest.allMin, allMax: nearest.allMax });
      }
      if (!Number.isFinite(row.min) || row.max - row.min < 1) { row.min = row.allMin; row.max = row.allMax; }
    }
    // Preserve asymmetric plan geometry, with the rear-foot centre as the registration origin.
    const heels = rows.filter((r) => r.t >= 0.09 && r.t <= 0.24);
    const heelCenter = heels.reduce((sum, r) => sum + (r.min + r.max) * 0.5, 0) / heels.length;
    const contour = rows.map((r) => {
      const mid = (r.min + r.max) * 0.5 - heelCenter;
      const half = Math.max(0.15, (r.max - r.min) * 0.5 - cavityInsetMm);
      // Close the cavity smoothly at the front/back wall; retain the measured centreline.
      const taper = Math.sqrt(Math.max(0, Math.min(1, r.t / 0.025, (1 - r.t) / 0.025)));
      return { t: r.t, width: 2 * half * taper, med: mid + half * taper, lat: half * taper - mid, center: mid };
    });
    const heights = rows.map((r) => ({ t: r.t, height: Math.max(0.5, r.top - cavityInsetMm) }));
    return { contour, heights, heelCenter, innerLength };
  }

  // Width and height extrema alone describe a rectangle, not the upper's actual
  // cross-section. Slice the source triangles in a radial frame so the cavity
  // follows the sloped sidewalls, rounded toe box and asymmetric heel.
  // This is still an exterior-minus-lining estimate, not a measured inner scan.
  function extractCavityProfile(registration) {
    if (!LF.contactDrape || !LF.contactDrape.createCollider) return null;
    const nt = 60, length = registration.productInput.length;
    const wall = registration.calibration.cavityInsetMm;
    const colliders = registration.meshes.map((item) => {
      const index = item.mesh.geometry.index;
      const indices = index && (index.array || Array.from({ length: index.count }, (_, k) => index.getX(k)));
      return LF.contactDrape.createCollider(item.canonicalPositions, indices);
    });
    let rayHitCount = 0, fallbackCount = 0, floorCount = 0;
    const points = registration.contour.points.map((outline, row) => {
      const t = outline.t, x = t * length;
      const bed = registration.supportBedProfile;
      const measuredFloor = LF.supportBed && LF.supportBed.heightAt(bed, x, true);
      const inferredFloor = LF.supportBed && LF.supportBed.heightAt(bed, x, false);
      const floorY = Number.isFinite(measuredFloor) ? measuredFloor : Number.isFinite(inferredFloor) ? inferredFloor : 0;
      const outerTop = registration.heightProfile.points[row].height + wall;
      const centerY = floorY + Math.max(1, outerTop - floorY) * .3, centerZ = outline.center;
      const ring = [], valid = [], boundary = [], outerRadius = [];
      for (let j = 0; j < nt; j++) {
        const theta = 2 * Math.PI * j / nt, dy = Math.sin(theta), dz = Math.cos(theta);
        const hits = [];
        for (const collider of colliders) collider.raycast(x, centerY, centerZ, 0, dy, dz, Infinity, null, hits);
        // A GLB can contain a lining or decorative layers. The furthest ray hit
        // is the observed exterior; the nearest hit is not necessarily its wall.
        const radius = hits.length ? Math.max(...hits) : null;
        let innerRadius, source;
        if (Number.isFinite(radius) && radius > .00001) {
          innerRadius = Math.max(.05, radius - wall); source = 'glb-exterior'; rayHitCount++;
        } else {
          // Open collars and degenerate end slices have no exterior hit. Keep
          // their fallback explicit so they cannot masquerade as measured walls.
          const halfWidth = Math.max(.1, outline.width * .5);
          const vertical = Math.max(.1, dy >= 0 ? outerTop - wall - centerY : centerY - floorY);
          innerRadius = 1 / Math.sqrt((dz / halfWidth) ** 2 + (dy / vertical) ** 2);
          source = 'fallback-open-or-missing'; fallbackCount++;
        }
        if (dy < -.000001) {
          const toFloor = Math.max(0, (floorY - centerY) / dy);
          if (innerRadius > toFloor) { innerRadius = toFloor; source = 'support-floor'; floorCount++; }
        }
        const z= centerZ + dz * innerRadius;
        const localFloor = LF.supportBed && LF.supportBed.heightAt(bed,x,false,z);
        const supportY = Number.isFinite(localFloor) ? localFloor : floorY;
        ring.push([Math.max(supportY, centerY + dy * innerRadius), z]);
        valid.push(source !== 'fallback-open-or-missing' ? 1 : 0);
        boundary.push(source); outerRadius.push(radius);
      }
      return { t, centerY, centerZ, floorY, floorSource: Number.isFinite(measuredFloor) ? 'verified-file-support' : Number.isFinite(inferredFloor) ? 'inferred-support-plane' : 'estimated-flat-insole',
        ring, valid, boundary, outerRadius };
    });
    return { source: 'actual-glb-radial-exterior-inset', unit: 'mm', nt, wallThickness: wall, points, rayHitCount, fallbackCount, floorCount,
      internalSource: 'exterior-minus-wall-estimate', missingBoundarySource: 'explicit-open-or-missing-section-fallback' };
  }

  function analyzeScene(scene, options = {}) {
    if (!scene || typeof scene.traverse !== 'function') throw new TypeError('GLB 장면을 먼저 불러와 주세요.');
    if (scene.updateMatrixWorld) scene.updateMatrixWorld(true);
    const sourceMeshes = [], sourcePoints = [];
    scene.traverse((mesh) => {
      const attr = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
      if (!mesh.isMesh || !attr || !attr.count || mesh.visible === false) return;
      const e = Array.from(mesh.matrixWorld && mesh.matrixWorld.elements || IDENTITY);
      const originalPositions = new Float32Array(attr.count * 3), worldPositions = new Float64Array(attr.count * 3);
      for (let k = 0; k < attr.count; k++) {
        const local = [attr.getX(k), attr.getY(k), attr.getZ(k)];
        originalPositions.set(local, k * 3);
        const world = pointTransform(e, ...local);
        worldPositions.set(world, k * 3); sourcePoints.push(...world);
      }
      const fileMeshIndex = mesh.userData && mesh.userData.sourceGltfMeshIndex;
      sourceMeshes.push({ mesh, originalPositions, worldPositions, worldMatrix: e,
        sourceMeshIndex: Number.isInteger(fileMeshIndex) && fileMeshIndex >= 0 ? fileMeshIndex : sourceMeshes.length });
    });
    if (!sourceMeshes.length) throw new RangeError('GLB에 표시 가능한 신발 메시가 없습니다.');
    const pose = options.pose || 'world';
    if (!['world', 'mesh'].includes(pose)) throw new RangeError('착화 자세는 원본 장면 또는 메시 기준으로 선택해 주세요.');
    const selectedIndex = options.meshIndex == null ? null : Number(options.meshIndex);
    const selectedIndices = options.meshIndices == null ? null : options.meshIndices;
    if (selectedIndices != null && (!Array.isArray(selectedIndices) || !selectedIndices.length || selectedIndices.some(value => !Number.isInteger(value) || value < 0 || !sourceMeshes.some(item => item.sourceMeshIndex === value)))) throw new RangeError('착화 대상 메시 번호 목록이 올바르지 않습니다.');
    if (selectedIndex != null && selectedIndices != null) throw new RangeError('메시 번호 또는 메시 번호 목록 중 하나만 선택해 주세요.');
    if (selectedIndex != null && (!Number.isInteger(selectedIndex) || selectedIndex < 0 || !sourceMeshes.some(item => item.sourceMeshIndex === selectedIndex))) throw new RangeError('착화 대상 메시 번호가 올바르지 않습니다.');
    if (pose === 'mesh' && selectedIndex == null && selectedIndices == null && sourceMeshes.length > 1) throw new RangeError('여러 신발이 있는 GLB는 착화 대상 한쪽을 선택해 주세요.');
    const meshes = selectedIndices ? sourceMeshes.filter(item => selectedIndices.includes(item.sourceMeshIndex)) : selectedIndex == null ? sourceMeshes : sourceMeshes.filter(item => item.sourceMeshIndex === selectedIndex), all = [], selectedWorld = [];
    // One side can comprise several transformed parts. Remove a common display
    // pose while retaining every part's rotation and translation in that assembly.
    const commonPose = pose === 'mesh' ? neutralPoseMatrix(meshes[0].worldMatrix).inversePose : null;
    const multiplyMatrix = (a, b) => {
      const out = new Array(16).fill(0);
      for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
      return out;
    };
    for (const item of meshes) {
      const neutral = pose === 'mesh' ? neutralPoseMatrix(item.worldMatrix) : null;
      item.analysisMatrix = neutral ? multiplyMatrix(commonPose, item.worldMatrix) : item.worldMatrix;
      item.worldScale = neutral ? neutral.worldScale : [0, 1, 2].map((a) => Math.hypot(item.worldMatrix[a * 4], item.worldMatrix[a * 4 + 1], item.worldMatrix[a * 4 + 2]));
      item.reflected = neutral ? neutral.reflected : false;
      item.framePositions = new Float64Array(item.originalPositions.length);
      for (let k = 0; k < item.framePositions.length; k += 3) {
        const frame = pose === 'mesh' ? pointTransform(item.analysisMatrix, ...item.originalPositions.subarray(k, k + 3)) : Array.from(item.worldPositions.subarray(k, k + 3));
        item.framePositions.set(frame, k); all.push(...frame); selectedWorld.push(...item.worldPositions.subarray(k, k + 3));
      }
    }
    const originalBounds = boundsOf(all);
    const autoAxis = AXES[originalBounds.size.indexOf(Math.max(...originalBounds.size))];
    const axis = options.axis == null || options.axis === 'auto' ? autoAxis : options.axis;
    if (!AXES.includes(axis)) throw new RangeError('길이 축을 X, Y, Z 중 선택해 주세요.');
    const xi = AXES.indexOf(axis), yi = AXES.indexOf(options.upAxis || (axis === 'y' ? 'z' : 'y'));
    if (yi < 0 || yi === xi) throw new RangeError('높이 축과 길이 축을 다르게 선택해 주세요.');
    const zi = [0, 1, 2].find((k) => k !== xi && k !== yi);
    if (originalBounds.size.some((s) => !Number.isFinite(s) || s < 1e-7)) throw new RangeError('평면 모델은 착화 형상으로 사용할 수 없습니다. 입체 신발 GLB를 사용해 주세요.');
    const unit = options.unit || 'm', mm = UNIT_MM[unit];
    if (!mm) throw new RangeError('GLB 좌표 단위는 m, cm, mm 중 선택해 주세요.');
    const originalDimensions = { length: originalBounds.size[xi] * mm, width: originalBounds.size[zi] * mm, height: originalBounds.size[yi] * mm };
    const hasValue = (key) => options[key] != null && options[key] !== '';
    // A demo preset changes display/fit scale, without claiming a measured product dimension.
    // Changing its length explicitly cancels a stale preset tag and restores manual provenance.
    const preset = options.lengthSource === 'demo-preset' && (!hasValue('outerLength') || Math.abs(Number(options.outerLength) - DEMO_LENGTH_MM) < 1e-6);
    const lengthSource = preset ? 'demo-preset' : hasValue('outerLength') ? 'manual' : 'glb-units';
    const length = finiteDimension(options.outerLength, preset ? DEMO_LENGTH_MM : originalDimensions.length, 180, 410, preset ? '데모 외부 길이' : '실측 외부 길이');
    const uniform = length / originalBounds.size[xi];
    const width = finiteDimension(options.outerWidth, originalBounds.size[zi] * uniform, 65, 180, '실측 외부 너비');
    const height = finiteDimension(options.outerHeight, originalBounds.size[yi] * uniform, 35, 240, '실측 외부 높이');
    if (length < 180 || length > 410 || width < 65 || width > 180 || height < 35 || height > 240) {
      throw new RangeError('GLB 좌표만으로 신발의 실제 크기를 확인할 수 없습니다. 좌표 단위 또는 실측 외부 길이를 입력해 주세요.');
    }
    const wallThickness = finiteDimension(options.wallThickness, 3, 0.5, 15, '앞뒤 기준 벽 두께');
    const cavityInsetMm = finiteDimension(options.cavityInsetMm, wallThickness, 0.5, 15, '내부 형상 오프셋');
    const soleThickness = finiteDimension(options.soleThickness, 22, 3, 70, '바닥~인솔 두께');
    if (soleThickness >= height - 15) throw new RangeError('바닥~인솔 두께는 외부 높이보다 최소 15 mm 작아야 합니다.');
    const sign = options.reverse ? -1 : 1, widthSign = (axis === 'z' ? -1 : 1) * (options.reverse ? -1 : 1) * (options.mirror ? -1 : 1);
    const scales = [length / originalBounds.size[xi], height / originalBounds.size[yi], width / originalBounds.size[zi]];
    function canonical(world) {
      const vx = (world[xi] - originalBounds.min[xi]) * scales[0];
      return [(sign > 0 ? vx : length - vx) - wallThickness,
        (world[yi] - originalBounds.min[yi]) * scales[1] - soleThickness,
        widthSign * (world[zi] - (originalBounds.min[zi] + originalBounds.max[zi]) * 0.5) * scales[2]];
    }
    for (const item of meshes) {
      const result = new Float32Array(item.framePositions.length);
      for (let k = 0; k < result.length; k += 3) result.set(canonical(item.framePositions.subarray(k, k + 3)), k);
      item.canonicalPositions = result;
    }
    const profiles = extractProfiles(meshes, length, wallThickness, cavityInsetMm);
    for (const item of meshes) {
      for (let k = 2; k < item.canonicalPositions.length; k += 3) item.canonicalPositions[k] -= profiles.heelCenter;
      item.toCanonical = (local) => {
        const p = Array.isArray(local) ? local : [local.x, local.y, local.z];
        const out = canonical(pointTransform(item.analysisMatrix, ...p)); out[2] -= profiles.heelCenter;
        return { x: out[0], y: out[1], z: out[2] };
      };
    }
    const contour = { unit: 'mm', source: 'glb-exterior-inset', points: profiles.contour };
    const heightProfile = { unit: 'mm', source: 'glb-exterior-inset', points: profiles.heights };
    const inRange = (rows, lo, hi, key) => Math.max(...rows.filter((r) => r.t >= lo && r.t <= hi).map((r) => r[key]));
    const innerWidth = Math.max(...contour.points.map((r) => r.width));
    const heelWidth = inRange(contour.points, 0.07, 0.30, 'width');
    // Field labels describe the section at midfoot / toes. A tall tongue tip is kept in the
    // full profile, but does not become the single midfoot-height measurement.
    function heightAt(t) {
      const f = t * (heightProfile.points.length - 1), a = Math.floor(f), b = Math.min(a + 1, heightProfile.points.length - 1);
      return heightProfile.points[a].height * (1 - (f - a)) + heightProfile.points[b].height * (f - a);
    }
    const instepHeight = heightAt(0.5);
    const toeHeight = heightAt(0.90);
    const referenceSize = finiteDimension(options.referenceSize, clamp(Math.round((profiles.innerLength - 12) / 5) * 5, 180, 340), 180, 340, '기준 사이즈');
    const manual = (!preset && hasValue('outerLength')) || hasValue('outerWidth') || hasValue('outerHeight');
    const source = preset ? 'demo-length-preset' : manual ? 'manual-outer-measurements' : 'glb-coordinate-units';
    const dimensionSources = {
      length: preset ? 'demo-length-preset' : hasValue('outerLength') ? 'manual-outer-measurement' : 'glb-coordinate-units',
      width: hasValue('outerWidth') ? 'manual-outer-measurement' : preset ? 'proportional-demo-length-preset' : hasValue('outerLength') ? 'proportional-length-calibration' : 'glb-coordinate-units',
      height: hasValue('outerHeight') ? 'manual-outer-measurement' : preset ? 'proportional-demo-length-preset' : hasValue('outerLength') ? 'proportional-length-calibration' : 'glb-coordinate-units',
    };
    const calibration = { axis, autoAxis, upAxis: AXES[yi], widthAxis: AXES[zi], unit, reverse: Boolean(options.reverse), mirror: Boolean(options.mirror),
      scale: scales, source, lengthSource, originalDimensions: { ...originalDimensions }, originalDimensionSource: 'glb-coordinate-units',
      uniformScale: length / originalDimensions.length, dimensionSources, demoLengthMm: preset ? DEMO_LENGTH_MM : null, wallThickness, cavityInsetMm, soleThickness,
      pose, meshIndex: selectedIndex, meshIndices: selectedIndices && selectedIndices.slice(), sourceMeshCount: sourceMeshes.length, worldScale: meshes[0].worldScale.slice(), reflectedNode: meshes[0].reflected,
      heelCenter: profiles.heelCenter, outerLength: length, outerWidth: width, outerHeight: height,
      internalSource: 'exterior-inset-estimate', referenceSizeEstimated: preset || !hasValue('referenceSize'),
      referenceSizeSource: preset ? 'demo-preset' : hasValue('referenceSize') ? 'user-reference-label' : 'estimated-from-internal-length' };
    calibration.options = { ...options, axis, unit, reverse: Boolean(options.reverse), wallThickness, cavityInsetMm, soleThickness, lengthSource };
    const productInput = {
      name: String(options.name || scene.name || 'GLB 신발'), referenceSize, length: profiles.innerLength,
      width: innerWidth, heelWidth, instepHeight, toeHeight, toeShape: 'round',
      silhouetteProfile: { source: contour.source, referenceWidth: innerWidth, points: contour.points.map((r) => ({ t: r.t, width: r.width / innerWidth, med: r.med / innerWidth, lat: r.lat / innerWidth })) },
      heightProfile: { ...heightProfile, referenceHeight: instepHeight, referenceToeHeight: toeHeight },
      collar: { back: inRange(heightProfile.points, 0, 0.20, 'height'), low: inRange(heightProfile.points, 0.23, 0.30, 'height') * 0.78, throat: 0.40 },
      // No external model establishes an insole's arch support or heel cup.
      // Use a flat estimated insole rather than silently inheriting a catalog shoe's support.
      arch: 0, cup: 0,
      dimensionSource: preset ? 'demo-length-preset' : manual ? 'glb-calibrated-estimate' : 'glb-units-estimate', glbCalibration: calibration,
    };
    const registration = { meshes, originalBounds, sourceBounds: boundsOf(selectedWorld), sceneBounds: boundsOf(sourcePoints), sourceMeshCount: sourceMeshes.length,
      dimensions: { length, width, height }, originalDimensions, calibration, contour, heightProfile, productInput };
    if (LF.supportBed) LF.supportBed.attach(registration);
    if (!options.skipCavityProfile) {
      const radialProfile = extractCavityProfile(registration);
      if (radialProfile) { registration.radialProfile = radialProfile; productInput.radialProfile = radialProfile; }
    }
    return registration;
  }

  // Transfer the same solved contact pressure / material stretch that produced the fit score.
  // Keep each material panel's boundary and the stiff outsole fixed; no whole-model scaling is applied.
  function createDeformationField(display, suppliedDeflection) {
    const { shoe, sim } = display;
    const worn = display.wornLast || shoe;
    const n = shoe.n, pressure = new Float32Array(n), stretch = new Float32Array(n), weight = new Float32Array(n);
    const pressureUnknown = new Float32Array(n);
    const peakPressure = new Float32Array(n), peakStretch = new Float32Array(n);
    const deflection = suppliedDeflection && suppliedDeflection.defl || suppliedDeflection;
    for (let i = 0; i < sim.near.length; i++) {
      const k = sim.near[i];
      if (sim.pressureStatus && sim.pressureStatus[i] === 3) continue;
      if (k < 0 || sim.ex[i] || worn.open[k] || (sim.P[i] <= 0 && sim.d[i] <= 0)) continue;
      const set = Math.max(0, sim.d[i] - Math.max(0, sim.eff[i]));
      const displacement = sim.defl[i] + set;
      const hasTriangle = sim.contactVertices && sim.contactBary;
      for (let corner = 0; corner < (hasTriangle ? 3 : 1); corner++) {
        const q = hasTriangle ? sim.contactVertices[i * 3 + corner] : k;
        const w = hasTriangle ? sim.contactBary[i * 3 + corner] : 1;
        if (q < 0 || q >= n || w <= 0.00001 || worn.open[q] || shoe.mat[q] !== shoe.mat[k]) continue;
        const invalid = sim.pressureValid && !sim.pressureValid[i];
        if (invalid) pressureUnknown[q] = 1;
        pressure[q] += (invalid ? 0 : sim.P[i]) * w; stretch[q] += displacement * w; weight[q] += w;
        // A contact must not lose its displacement when averaged with nearby air.
        peakPressure[q] = Math.max(peakPressure[q], sim.pressureValid && !sim.pressureValid[i] ? 0 : sim.P[i]);
        peakStretch[q] = Math.max(peakStretch[q], displacement);
      }
    }
    // Heel/toe poles are not part of the regular ring smoothing loop. Carry their
    // contacts to the corresponding end ring, retaining material boundaries.
    for (const [pole, row] of [[shoe.S0, 0], [shoe.E0, shoe.nx - 1]]) {
      if (!Number.isInteger(pole) || pole < 0 || pole >= n || !weight[pole]) continue;
      const ring = [];
      for (let j = 0; j < shoe.nt; j++) {
        const q = row * shoe.nt + j;
        if (!worn.open[q] && shoe.mat[q] === shoe.mat[pole]) ring.push(q);
      }
      for (const q of ring) {
        pressure[q] += pressure[pole] / ring.length; stretch[q] += stretch[pole] / ring.length; weight[q] += weight[pole] / ring.length;
        pressureUnknown[q] = Math.max(pressureUnknown[q], pressureUnknown[pole]);
        peakPressure[q] = Math.max(peakPressure[q], peakPressure[pole]);
        peakStretch[q] = Math.max(peakStretch[q], peakStretch[pole]);
      }
    }
    for (let k = 0; k < n; k++) {
      if (weight[k]) { pressure[k] /= weight[k]; stretch[k] /= weight[k]; }
      if (deflection && Number.isFinite(deflection[k])) stretch[k] = Math.max(stretch[k], deflection[k]);
    }
    const finalUnknown = new Float32Array(n), finalP = new Float32Array(n), finalD = new Float32Array(n);
    for (let r = 0; r < shoe.nx; r++) for (let j = 0; j < shoe.nt; j++) {
      const k = r * shoe.nt + j;
      if (worn.open[k]) continue;
      let sumP = 0, sumD = 0, sumW = 0, sumUnknown = 0;
      for (let dr = -2; dr <= 2; dr++) for (let dj = -2; dj <= 2; dj++) {
        const row = r + dr;
        if (row < 0 || row >= shoe.nx) continue;
        const q = row * shoe.nt + (j + dj + shoe.nt) % shoe.nt;
        if (worn.open[q] || shoe.mat[q] !== shoe.mat[k]) continue;
        const w = Math.exp(-0.5 * (dr * dr / 1.4 + dj * dj / 1.8));
        sumW += w; sumUnknown += pressureUnknown[q] * w; sumP += pressure[q] * w; sumD += stretch[q] * w;
      }
      finalUnknown[k] = Math.max(pressureUnknown[k], sumW ? sumUnknown / sumW : 0);
      finalP[k] = Math.max(peakPressure[k], sumW ? sumP / sumW : 0);
      finalD[k] = Math.max(peakStretch[k], sumW ? sumD / sumW : 0);
    }
    for (const pole of [shoe.S0, shoe.E0]) if (Number.isInteger(pole) && pole >= 0 && pole < n && !worn.open[pole]) {
      finalUnknown[pole] = pressureUnknown[pole];
      finalP[pole] = Math.max(peakPressure[pole], pressure[pole]);
      finalD[pole] = Math.max(peakStretch[pole], stretch[pole]);
    }
    const vectors = new Float32Array(n * 3), stretchVectors = new Float32Array(n * 3), closureVectors = new Float32Array(n * 3), closeMm = new Float32Array(n);
    let maxMm = 0, maxCloseMm = 0, maxDisplacementMm = 0;
    for (let k = 0; k < n; k++) {
      const fixed = shoe.mat[k] === LF.geom.M.INSOLE || shoe.pos[k * 3 + 1] <= 0;
      for (let a = 0; a < 3; a++) {
        const i = k * 3 + a;
        // Never propagate legacy inward closure into the original product cavity.
        closureVectors[i] = 0;
        stretchVectors[i] = fixed ? 0 : worn.nrm[i] * finalD[k];
        vectors[i] = stretchVectors[i];
      }
      if (fixed) finalD[k] = 0;
      closeMm[k] = Math.hypot(closureVectors[k * 3], closureVectors[k * 3 + 1], closureVectors[k * 3 + 2]);
      maxMm = Math.max(maxMm, finalD[k]); maxCloseMm = Math.max(maxCloseMm, closeMm[k]);
      maxDisplacementMm = Math.max(maxDisplacementMm, Math.hypot(vectors[k * 3], vectors[k * 3 + 1], vectors[k * 3 + 2]));
    }
    return { shoe, wornLast: worn, pressure: finalP, pressureUnknown: finalUnknown, stretch: finalD, closeMm, vectors, stretchVectors, closureVectors,
      maxMm, maxCloseMm, maxDisplacementMm, source: 'solved-contact-material-expansion-only' };
  }

  function displacementAt(field, x, y, z) {
    const shoe = field.shoe, T = shoe.shape;
    if (x < -15 || x > T.Ls + 15) return { x: 0, y: 0, z: 0, pressure: 0, stretch: 0, closeMm: 0, mat: LF.geom.M.UPPER };
    const xx = clamp(x, 0.01, T.Ls - 0.01);
    const sec = LF.geom.lastSection(T, xx);
    let angle;
    if (T.radialProfile) angle = Math.atan2(y - sec.ys, z - sec.c);
    else {
      const u = clamp((z - sec.c) / Math.max(0.5, sec.a), -1, 1);
      const v = clamp((y - sec.ys) / Math.max(0.5, y >= sec.ys ? sec.ytC - sec.ys : sec.ys - sec.ybC), -1, 1);
      const exponent = v >= 0 ? 2.8 : 6;
      angle = Math.atan2(Math.sign(v) * Math.pow(Math.abs(v), exponent / 2), Math.sign(u) * Math.pow(Math.abs(u), exponent / 2));
    }
    if (angle < 0) angle += 2 * Math.PI;
    const f = angle / (2 * Math.PI) * shoe.nt, j0 = Math.floor(f) % shoe.nt, j1 = (j0 + 1) % shoe.nt, jf = f - Math.floor(f);
    const rows = LF.geom.sectionRows(shoe, xx), out = { x: 0, y: 0, z: 0, pressure: 0, pressureUnknown: 0, stretch: 0, closeMm: 0,
      stretchX: 0, stretchY: 0, stretchZ: 0, closeX: 0, closeY: 0, closeZ: 0, mat: LF.geom.M.UPPER };
    const samples = [];
    let closestWeight = -1;
    for (const [row, rw] of [[rows.i0, 1 - rows.f], [rows.i1, rows.f]]) for (const [j, jw] of [[j0, 1 - jf], [j1, jf]]) {
      const k = row * shoe.nt + j, w = rw * jw;
      samples.push({ k, w });
      if (w > closestWeight) { closestWeight = w; out.mat = shoe.mat[k]; }
    }
    let samePanelWeight = 0;
    for (const { k, w } of samples) {
      if (shoe.mat[k] !== out.mat) continue;
      samePanelWeight += w;
      out.x += field.vectors[k * 3] * w; out.y += field.vectors[k * 3 + 1] * w; out.z += field.vectors[k * 3 + 2] * w;
      if (field.pressureUnknown) out.pressureUnknown += field.pressureUnknown[k] * w;
      out.pressure += field.pressure[k] * w; out.stretch += field.stretch[k] * w;
      if (field.stretchVectors) {
        out.stretchX += field.stretchVectors[k * 3] * w; out.stretchY += field.stretchVectors[k * 3 + 1] * w; out.stretchZ += field.stretchVectors[k * 3 + 2] * w;
      }
    }
    if (samePanelWeight > 0) for (const key of ['x', 'y', 'z', 'pressure', 'pressureUnknown', 'stretch', 'closeMm', 'stretchX', 'stretchY', 'stretchZ', 'closeX', 'closeY', 'closeZ']) out[key] /= samePanelWeight;
    // Stretch is the only wearing displacement. Ignore stale closure fields.
    const support = smoothstep(0, 7, y);
    out.stretch *= support;
    if (field.stretchVectors) {
      for (const key of ['stretchX', 'stretchY', 'stretchZ']) out[key] *= support;
      out.x = out.stretchX; out.y = out.stretchY; out.z = out.stretchZ;
    } else {
      out.x *= support; out.y *= support; out.z *= support;
    }
    if (support === 0) out.mat = LF.geom.M.INSOLE;
    out.pressureValid = out.pressureUnknown <= 0.05 && support > 0;
    if (!out.pressureValid) out.pressure = 0;
    return out;
  }

  function deformPositions(positions, field, amount = 1) {
    const result = new Float32Array(positions.length);
    const expansion = Number.isFinite(amount) ? Math.max(0, amount) : 1;
    for (let k = 0; k < result.length; k += 3) {
      const d = displacementAt(field, positions[k], positions[k + 1], positions[k + 2]);
      // Even API callers cannot turn positive stretch into inward shrink by
      // supplying a negative display multiplier or an obsolete closure field.
      const separate = field.stretchVectors;
      result[k] = positions[k] + (separate ? d.stretchX : d.x) * expansion;
      result[k + 1] = positions[k + 1] + (separate ? d.stretchY : d.y) * expansion;
      result[k + 2] = positions[k + 2] + (separate ? d.stretchZ : d.z) * expansion;
    }
    return result;
  }

  LF.glbFit = { analyzeScene, demoLengthOptions, DEMO_LENGTH_MM, boundsOf, pointTransform, neutralPoseMatrix, extractProfiles, extractCavityProfile, createDeformationField, displacementAt, sampleField: displacementAt, deformPositions };
})((window.LF = window.LF || {}));
