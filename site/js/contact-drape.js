// LastFit — local triangle contact and an elastic drape correction, in millimetres.
// This is a deterministic contact approximation, not a finite-element material solver.
(function (LF) {
  'use strict';
  const footCache = new WeakMap(), topologyCache = new WeakMap();
  const EPS = 1e-9;
  const arrayOf = (value) => value && (value.array || value);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // A geometric contact correction cannot supply unlimited stretch after a
  // spring has already used the material's compliance. Beyond this small
  // post-elastic allowance, keep the obstruction and report the fit limit.
  function materialStretchLimit(material, wear = 0) {
    const lim = Math.max(.05, Number(material && material.lim) || 3) * (1 + 1.5 * (Number(material && material.soften) || 0) * wear);
    return (Number(material && material.k1) || 11) >= 100 ? lim : lim + Math.min(.5, lim * .25);
  }

  function createCollider(source, sourceIndex, sourceNormals) {
    const positions = new Float32Array(arrayOf(source));
    if (!positions.length || positions.length % 3) throw new RangeError('접촉 표면 좌표가 올바르지 않습니다.');
    for (let k = 0; k < positions.length; k++) if (!Number.isFinite(positions[k])) throw new RangeError('접촉 표면에 유효하지 않은 좌표가 있습니다.');
    const count = positions.length / 3, rawIndex = arrayOf(sourceIndex);
    const indices = rawIndex ? Uint32Array.from(rawIndex) : Uint32Array.from({ length: count }, (_, k) => k);
    const triangleCount = Math.floor(indices.length / 3), triangleBounds = new Float64Array(triangleCount * 6);
    const centroids = new Float64Array(triangleCount * 3), normals = new Float64Array(triangleCount * 3);
    const vertexNormals = new Float64Array(positions.length), bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let volume6 = 0;
    for (let t = 0; t < triangleCount; t++) {
      const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
      if (a >= count || b >= count || c >= count) throw new RangeError('접촉 표면의 삼각형 인덱스가 올바르지 않습니다.');
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
      const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
      normals.set([nx, ny, nz], t * 3);
      volume6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
      for (let d = 0; d < 3; d++) {
        const min = Math.min(positions[a * 3 + d], positions[b * 3 + d], positions[c * 3 + d]);
        const max = Math.max(positions[a * 3 + d], positions[b * 3 + d], positions[c * 3 + d]);
        triangleBounds[t * 6 + d] = min; triangleBounds[t * 6 + 3 + d] = max;
        centroids[t * 3 + d] = (positions[a * 3 + d] + positions[b * 3 + d] + positions[c * 3 + d]) / 3;
        bounds[d] = Math.min(bounds[d], min); bounds[d + 3] = Math.max(bounds[d + 3], max);
      }
      for (const vertex of [a, b, c]) {
        vertexNormals[vertex * 3] += nx; vertexNormals[vertex * 3 + 1] += ny; vertexNormals[vertex * 3 + 2] += nz;
      }
    }
    const orientation = volume6 < 0 ? -1 : 1;
    for (let k = 0; k < normals.length; k += 3) {
      const inverse = orientation / (Math.hypot(normals[k], normals[k + 1], normals[k + 2]) || 1);
      normals[k] *= inverse; normals[k + 1] *= inverse; normals[k + 2] *= inverse;
    }
    const supplied = arrayOf(sourceNormals);
    for (let k = 0; k < vertexNormals.length; k += 3) {
      if (supplied && supplied.length === vertexNormals.length) {
        vertexNormals[k] = supplied[k]; vertexNormals[k + 1] = supplied[k + 1]; vertexNormals[k + 2] = supplied[k + 2];
      } else {
        const inverse = orientation / (Math.hypot(vertexNormals[k], vertexNormals[k + 1], vertexNormals[k + 2]) || 1);
        vertexNormals[k] *= inverse; vertexNormals[k + 1] *= inverse; vertexNormals[k + 2] *= inverse;
      }
    }
    const nodes = [], order = [];
    function build(triangles) {
      const index = nodes.length, box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const t of triangles) for (let d = 0; d < 3; d++) {
        box[d] = Math.min(box[d], triangleBounds[t * 6 + d]); box[d + 3] = Math.max(box[d + 3], triangleBounds[t * 6 + d + 3]);
      }
      const node = { box, left: -1, right: -1, start: 0, count: 0 }; nodes.push(node);
      if (triangles.length <= 8) { node.start = order.length; node.count = triangles.length; order.push(...triangles); }
      else {
        const sizes = [box[3] - box[0], box[4] - box[1], box[5] - box[2]], axis = sizes.indexOf(Math.max(...sizes));
        triangles.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
        const middle = triangles.length >> 1;
        node.left = build(triangles.slice(0, middle)); node.right = build(triangles.slice(middle));
      }
      return index;
    }
    if (!triangleCount) throw new RangeError('접촉 표면에 삼각형이 없습니다.');
    build(Array.from({ length: triangleCount }, (_, t) => t));
    // Conservative narrow-phase bounds follow the foot's height and width along x.
    // A high tongue above the low forefoot should not traverse a complete foot BVH.
    const slabWidth = 5, slabPadding = 5, slabCount = Math.ceil((bounds[3] - bounds[0] + slabPadding * 2) / slabWidth) + 1;
    const slabOrigin = bounds[0] - slabPadding, slabs = new Float64Array(slabCount * 4);
    for (let s = 0; s < slabCount; s++) slabs.set([Infinity, Infinity, -Infinity, -Infinity], s * 4);
    for (let t = 0; t < triangleCount; t++) {
      const begin = clamp(Math.floor((triangleBounds[t * 6] - slabPadding - slabOrigin) / slabWidth), 0, slabCount - 1);
      const end = clamp(Math.floor((triangleBounds[t * 6 + 3] + slabPadding - slabOrigin) / slabWidth), 0, slabCount - 1);
      for (let s = begin; s <= end; s++) {
        slabs[s * 4] = Math.min(slabs[s * 4], triangleBounds[t * 6 + 1]); slabs[s * 4 + 1] = Math.min(slabs[s * 4 + 1], triangleBounds[t * 6 + 2]);
        slabs[s * 4 + 2] = Math.max(slabs[s * 4 + 2], triangleBounds[t * 6 + 4]); slabs[s * 4 + 3] = Math.max(slabs[s * 4 + 3], triangleBounds[t * 6 + 5]);
      }
    }
    const stack = new Int32Array(128), candidate = new Float64Array(6);
    let paritySign = false, parityTriangles = null;
    function boxDistance(box, x, y, z) {
      const dx = Math.max(box[0] - x, 0, x - box[3]), dy = Math.max(box[1] - y, 0, y - box[4]), dz = Math.max(box[2] - z, 0, z - box[5]);
      return dx * dx + dy * dy + dz * dz;
    }
    // Ericson's closest-point regions include triangle interiors, edges and vertices.
    function closest(t, x, y, z) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
      const abx = positions[b] - ax, aby = positions[b + 1] - ay, abz = positions[b + 2] - az;
      const acx = positions[c] - ax, acy = positions[c + 1] - ay, acz = positions[c + 2] - az;
      const apx = x - ax, apy = y - ay, apz = z - az;
      const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
      let u = 1, v = 0, w = 0;
      if (!(d1 <= 0 && d2 <= 0)) {
        const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
        const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
        if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; }
        else {
          const vc = d1 * d4 - d3 * d2;
          if (vc <= 0 && d1 >= 0 && d3 <= 0) { v = d1 / (d1 - d3 || EPS); u = 1 - v; }
          else {
            const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
            const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
            if (d6 >= 0 && d5 <= d6) { u = 0; w = 1; }
            else {
              const vb = d5 * d2 - d1 * d6;
              if (vb <= 0 && d2 >= 0 && d6 <= 0) { w = d2 / (d2 - d6 || EPS); u = 1 - w; }
              else {
                const va = d3 * d6 - d5 * d4;
                if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { w = (d4 - d3) / (d4 - d3 + d5 - d6 || EPS); v = 1 - w; u = 0; }
                else { const inverse = 1 / (va + vb + vc || EPS); v = vb * inverse; w = vc * inverse; u = 1 - v - w; }
              }
            }
          }
        }
      }
      candidate[0] = ax + abx * v + acx * w; candidate[1] = ay + aby * v + acy * w; candidate[2] = az + abz * v + acz * w;
      candidate[3] = u; candidate[4] = v; candidate[5] = w;
      return (x - candidate[0]) ** 2 + (y - candidate[1]) ** 2 + (z - candidate[2]) ** 2;
    }
    function query(x, y, z, result) {
      const out = result || { point: {}, normal: {}, triangle: [], barycentric: [] };
      out.point = out.point || {}; out.normal = out.normal || {}; out.triangle = out.triangle || []; out.barycentric = out.barycentric || [];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new RangeError('접촉 위치가 유효하지 않습니다.');
      let best = Infinity, bestT = -1, stackCount = 1;
      stack[0] = 0;
      while (stackCount) {
        const node = nodes[stack[--stackCount]];
        if (boxDistance(node.box, x, y, z) > best + EPS) continue;
        if (node.count) {
          for (let k = node.start; k < node.start + node.count; k++) {
            const t = order[k], distance = closest(t, x, y, z);
            if (distance >= best) continue;
            best = distance; bestT = t;
            out.point.x = candidate[0]; out.point.y = candidate[1]; out.point.z = candidate[2];
            out.barycentric[0] = candidate[3]; out.barycentric[1] = candidate[4]; out.barycentric[2] = candidate[5];
          }
        } else {
          const left = boxDistance(nodes[node.left].box, x, y, z), right = boxDistance(nodes[node.right].box, x, y, z);
          if (left < right) { if (right <= best) stack[stackCount++] = node.right; if (left <= best) stack[stackCount++] = node.left; }
          else { if (left <= best) stack[stackCount++] = node.left; if (right <= best) stack[stackCount++] = node.right; }
        }
      }
      const a = indices[bestT * 3], b = indices[bestT * 3 + 1], c = indices[bestT * 3 + 2];
      out.triangle[0] = a; out.triangle[1] = b; out.triangle[2] = c;
      const weights = out.barycentric;
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < 3; k++) { const vertex = out.triangle[k] * 3; nx += vertexNormals[vertex] * weights[k]; ny += vertexNormals[vertex + 1] * weights[k]; nz += vertexNormals[vertex + 2] * weights[k]; }
      const length = Math.hypot(nx, ny, nz);
      if (length > EPS) { nx /= length; ny /= length; nz /= length; }
      else { nx = normals[bestT * 3]; ny = normals[bestT * 3 + 1]; nz = normals[bestT * 3 + 2]; }
      const projection = (x - out.point.x) * nx + (y - out.point.y) * ny + (z - out.point.z) * nz;
      out.normal.x = nx; out.normal.y = ny; out.normal.z = nz;
      const needsParity = paritySign && (!parityTriangles || parityTriangles[bestT]);
      out.signedDistance = Math.sqrt(best) * (needsParity ? contains(x, y, z) ? -1 : 1 : projection < -EPS ? -1 : 1);
      out.inside = out.signedDistance < 0; out.triangleIndex = bestT;
      return out;
    }
    function raycast(x, y, z, dx, dy, dz, maxDistance = Infinity, result, allDistances) {
      const out = result || { point: {}, normal: {} };
      const directionLength = Math.hypot(dx, dy, dz); if (directionLength < EPS) return null;
      dx /= directionLength; dy /= directionLength; dz /= directionLength;
      const inverse = [1 / dx, 1 / dy, 1 / dz], origin = [x, y, z];
      function rayBox(box, maximum) {
        let lo = 0, hi = maximum;
        for (let d = 0; d < 3; d++) {
          if (!Number.isFinite(inverse[d])) { if (origin[d] < box[d] || origin[d] > box[d + 3]) return false; continue; }
          const a = (box[d] - origin[d]) * inverse[d], b = (box[d + 3] - origin[d]) * inverse[d];
          lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); if (hi < lo) return false;
        }
        return true;
      }
      let best = maxDistance, found = -1, stackCount = 1; stack[0] = 0;
      while (stackCount) {
        const node = nodes[stack[--stackCount]]; if (!rayBox(node.box, allDistances ? maxDistance : best)) continue;
        if (!node.count) { stack[stackCount++] = node.left; stack[stackCount++] = node.right; continue; }
        for (let k = node.start; k < node.start + node.count; k++) {
          const t = order[k], a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
          const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
          const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const determinant = e1x * px + e1y * py + e1z * pz; if (Math.abs(determinant) < EPS) continue;
          const inv = 1 / determinant, tx = x - positions[a], ty = y - positions[a + 1], tz = z - positions[a + 2];
          const u = (tx * px + ty * py + tz * pz) * inv; if (u < -EPS || u > 1 + EPS) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < -EPS || u + v > 1 + EPS) continue;
          const distance = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (distance > 0.00001 && distance < maxDistance) {
            if (allDistances) allDistances.push(distance);
            if (distance < best) { best = distance; found = t; }
          }
        }
      }
      if (found < 0) return null;
      out.point = out.point || {}; out.normal = out.normal || {};
      out.point.x = x + dx * best; out.point.y = y + dy * best; out.point.z = z + dz * best;
      out.normal.x = normals[found * 3]; out.normal.y = normals[found * 3 + 1]; out.normal.z = normals[found * 3 + 2]; out.distance = best;
      return out;
    }
    function contains(x, y, z) {
      if (boxDistance(bounds, x, y, z) > EPS) return false;
      const distances = [];
      raycast(x, y, z, 1, 0.000137, 0.000319, Infinity, null, distances);
      distances.sort((a, b) => a - b);
      let crossings = 0, previous = -Infinity;
      for (const distance of distances) if (distance - previous > 0.00001) { crossings++; previous = distance; }
      return crossings % 2 === 1;
    }
    function narrowBoundsDistance(x, y, z) {
      const global = boxDistance(bounds, x, y, z), slab = clamp(Math.floor((x - slabOrigin) / slabWidth), 0, slabCount - 1) * 4;
      const dy = Math.max(slabs[slab] - y, 0, y - slabs[slab + 2]), dz = Math.max(slabs[slab + 1] - z, 0, z - slabs[slab + 3]);
      return Math.max(global, dy * dy + dz * dz);
    }
    function centerAt(x) {
      const slab = clamp(Math.floor((x - slabOrigin) / slabWidth), 0, slabCount - 1) * 4;
      return { x: (bounds[0] + bounds[3]) * 0.5, y: (slabs[slab] + slabs[slab + 2]) * 0.5, z: (slabs[slab + 1] + slabs[slab + 3]) * 0.5 };
    }
    return { positions, indices, bounds, triangleCount, query, raycast, contains, centerAt,
      useRayParity: (enabled = true, triangles = null) => { paritySign = Boolean(enabled); parityTriangles = triangles; }, boxDistanceSquared: narrowBoundsDistance };
  }

  function prepare(display) {
    if (!display || !display.foot) throw new TypeError('착화된 발 형상이 필요합니다.');
    const foot = display.foot, sim = display.sim || {}, ctx = display.ctx || {};
    const cached = footCache.get(display), supplied = display.renderFootPositions || display.compressedFpos || sim.fpos || foot.pos;
    if (cached && cached.sourcePositions === supplied) return cached.collider;
    const positions = display.renderFootPositions || display.compressedFpos ||
      (ctx.snugWear && LF.sim && LF.sim.compressedFootPositions && sim.near ? LF.sim.compressedFootPositions(foot, display.wornLast || display.shoe, sim, ctx) : sim.fpos || foot.pos);
    const collider = createCollider(positions, LF.geom.gridIndex(foot));
    // Closest-surface pseudonormals are exact for an unfolded closed skin. Use a
    // parity fallback if a supplied render surface reverses a triangle locally.
    let inversions = 0;
    const idx = collider.indices, original = foot.pos || positions;
    const affected = new Uint8Array(positions.length / 3), parityFaces = new Uint8Array(idx.length / 3);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const normal = (p) => { const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2], acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2]; return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx]; };
      const before = normal(original), after = normal(positions);
      if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] < -0.000001) { inversions++; affected[idx[t]] = affected[idx[t + 1]] = affected[idx[t + 2]] = 1; }
    }
    for (let t = 0; t < idx.length; t += 3) parityFaces[t / 3] = affected[idx[t]] || affected[idx[t + 1]] || affected[idx[t + 2]];
    collider.invertedTriangleCount = inversions;
    collider.useRayParity(inversions > 0, parityFaces);
    collider.source = 'rendered-compressed-foot-triangles';
    footCache.set(display, { collider, sourcePositions: supplied });
    return collider;
  }

  function topology(positions, inputIndex) {
    const index = arrayOf(inputIndex), cached = topologyCache.get(positions);
    if (cached && cached.index === index) return cached;
    const n = positions.length / 3, count = index ? index.length : n, degree = new Uint32Array(n), largeFaces = [], vertexNormals = new Float64Array(positions.length);
    const representatives = new Uint32Array(n), welded = new Map();
    for (let k = 0; k < n; k++) {
      // UV/material seams often repeat the same physical point. Weld only submicron
      // baseline coincidences so contact does not tear an otherwise continuous panel.
      const key = `${Math.round(positions[k * 3] * 1000)}:${Math.round(positions[k * 3 + 1] * 1000)}:${Math.round(positions[k * 3 + 2] * 1000)}`;
      if (welded.has(key)) representatives[k] = welded.get(key); else { representatives[k] = k; welded.set(key, k); }
    }
    let volume6 = 0;
    const at = (k) => index ? index[k] : k;
    for (let k = 0; k + 2 < count; k += 3) {
      const a = at(k), b = at(k + 1), c = at(k + 2);
      if (a >= n || b >= n || c >= n) continue;
      degree[a] += 2; degree[b] += 2; degree[c] += 2;
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      volume6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
      for (const vertex of [a, b, c]) { vertexNormals[vertex * 3] += nx; vertexNormals[vertex * 3 + 1] += ny; vertexNormals[vertex * 3 + 2] += nz; }
      const edge = (u, v) => Math.hypot(positions[u * 3] - positions[v * 3], positions[u * 3 + 1] - positions[v * 3 + 1], positions[u * 3 + 2] - positions[v * 3 + 2]);
      if (Math.max(edge(a, b), edge(b, c), edge(c, a)) > 7) largeFaces.push(a, b, c);
    }
    const starts = new Uint32Array(n + 1);
    for (let k = 0; k < n; k++) starts[k + 1] = starts[k] + degree[k];
    const next = starts.slice(), neighbors = new Uint32Array(starts[n]);
    for (let k = 0; k + 2 < count; k += 3) {
      const a = at(k), b = at(k + 1), c = at(k + 2);
      if (a >= n || b >= n || c >= n) continue;
      neighbors[next[a]++] = b; neighbors[next[a]++] = c;
      neighbors[next[b]++] = a; neighbors[next[b]++] = c;
      neighbors[next[c]++] = a; neighbors[next[c]++] = b;
    }
    const orientation = volume6 < 0 ? -1 : 1;
    const combinedNormals = new Float64Array(vertexNormals.length);
    for (let k = 0; k < n; k++) for (let d = 0; d < 3; d++) combinedNormals[representatives[k] * 3 + d] += vertexNormals[k * 3 + d];
    for (let k = 0; k < vertexNormals.length; k += 3) {
      const source = representatives[k / 3] * 3, inverse = orientation / (Math.hypot(combinedNormals[source], combinedNormals[source + 1], combinedNormals[source + 2]) || 1);
      vertexNormals[k] = combinedNormals[source] * inverse; vertexNormals[k + 1] = combinedNormals[source + 1] * inverse; vertexNormals[k + 2] = combinedNormals[source + 2] * inverse;
    }
    const result = { index, starts, neighbors, representatives, normals: vertexNormals, largeFaces: Uint32Array.from(largeFaces) };
    topologyCache.set(positions, result); return result;
  }

  function outwardDirection(x, y, z, nx, ny, nz, collider, field) {
    let dx = Number(nx) || 0, dy = Number(ny) || 0, dz = Number(nz) || 0;
    const shape = field && field.shoe && field.shoe.shape;
    if (shape && LF.geom && LF.geom.lastSection) {
      const section = LF.geom.lastSection(shape, clamp(x, 0.01, shape.Ls - 0.01)), u = (z - section.c) / Math.max(0.5, section.a);
      if (x < shape.Ls * 0.12 && Math.abs(u) < 0.65) { dx = -1; dy = 0; dz = 0; }
      else if (x > shape.Ls * 0.94 && Math.abs(u) < 0.7) { dx = 1; dy = 0; dz = 0; }
      else {
        // A continuous radial guide prevents neighboring points on either side of
        // an arbitrary panel threshold from escaping above and below a foot.
        // Choose a panel's outward side from the undeformed shoe. An already
        // seated foot can sit above a roof that needs to expand; using the foot
        // centre here would send neighbouring roof vertices below the foot.
        // Use the same reference centre as the original measured cavity. A
        // guessed origin near the floor can call upward motion on a low sidewall
        // "outward" even when that motion actually closes the original space.
        const center = { y: section.ys, z: section.c };
        dx = 0;
        dy = (y - center.y) / Math.max(2, (section.ytC - section.ybC) * 0.5);
        dz = (z - center.z) / Math.max(2, section.a);
        if (Math.hypot(dy, dz) < 0.05) { dy = y >= center.y ? 1 : -1; dz = u * 0.3; }
      }
    } else if (collider && collider.centerAt) {
      const center = collider.centerAt(x), radial = dx * (x - center.x) * 0.2 + dy * (y - center.y) + dz * (z - center.z);
      if (radial < 0) { dx = -dx; dy = -dy; dz = -dz; }
      if (Math.hypot(dx, dy, dz) < EPS) { dx = x - center.x; dy = y - center.y; dz = z - center.z; }
    }
    const length = Math.hypot(dx, dy, dz);
    return length > EPS ? { x: dx / length, y: dy / length, z: dz / length } : { x: 0, y: 1, z: 0 };
  }

  function solve(input, options = {}) {
    const mapped = arrayOf(input.positions), baseline = arrayOf(input.originalPositions || input.baseline || mapped), collider = input.collider;
    if (!mapped || mapped.length !== baseline.length || mapped.length % 3 || !collider || typeof collider.query !== 'function') throw new TypeError('발·신발 접촉 입력이 올바르지 않습니다.');
    const n = mapped.length / 3, positions = Float32Array.from(mapped), reactionsKPa = new Float32Array(n), corrected = new Uint8Array(n);
    const rigid = new Uint8Array(n), stiffness = new Float32Array(n), limits = new Float32Array(n), postStiffness = new Float32Array(n), budgets = new Float32Array(n), limited = new Uint8Array(n);
    const zones = input.zones, fixedMask = input.fixedMask || options.fixedMask, mats = options.materials || input.materials || input.field && input.field.shoe && input.field.shoe.mats || [];
    // The original upper is the unilateral rest boundary. A wearing solve may
    // expand it; roomy panels retain their original clearance around the foot.
    const anchors = baseline;
    const clearance = clamp(Number(options.clearanceMm == null ? 0.8 : options.clearanceMm), 0, 5);
    const maxIterations = clamp(Math.round(Number(options.iterations || 2)), 1, 8);
    const mesh = topology(baseline, input.index), query = { point: {}, normal: {}, triangle: [], barycentric: [] }, ray = { point: {}, normal: {} };
    const guideVectors = new Float32Array(n * 3), guideReady = new Uint8Array(n);
    function guide(vertex) {
      const offset = vertex * 3;
      if (guideReady[vertex]) return;
      guideReady[vertex] = 1;
      const supplied = arrayOf(input.normals), normal = supplied && supplied.length === baseline.length ? supplied : mesh.normals;
      const direction = outwardDirection(baseline[offset], baseline[offset + 1], baseline[offset + 2], normal[offset], normal[offset + 1], normal[offset + 2], collider, input.field);
      guideVectors[offset] = direction.x; guideVectors[offset + 1] = direction.y; guideVectors[offset + 2] = direction.z;
    }
    function place(vertex, x, y, z) {
      const offset = vertex * 3;
      if (rigid[vertex] === 2) { positions[offset] = baseline[offset]; positions[offset + 1] = baseline[offset + 1]; positions[offset + 2] = baseline[offset + 2]; return; }
      guide(vertex);
      const gx = guideVectors[offset], gy = guideVectors[offset + 1], gz = guideVectors[offset + 2];
      // Project onto the rest panel's outward ray, rather than coordinate signs.
      // This is reapplied after contact, smoothing, edge relaxation and welding.
      // Tangential/negative motion cannot move a panel through its original shell.
      const requested = (x - anchors[offset]) * gx + (y - anchors[offset + 1]) * gy + (z - anchors[offset + 2]) * gz;
      const amount = Math.min(budgets[vertex], Math.max(0, requested));
      if (requested > budgets[vertex] || requested < -EPS) limited[vertex] = 1;
      positions[offset] = anchors[offset] + gx * amount;
      positions[offset + 1] = anchors[offset + 1] + gy * amount;
      positions[offset + 2] = anchors[offset + 2] + gz * amount;
    }
    let initialPenetrationMm = 0, remainingPenetrationMm = 0, remainingFlexiblePenetrationMm = 0, remainingRigidPenetrationMm = 0;
    let contactSampleCount = 0, completedIterations = 0, exactQueryCount = 0, worstContact = null;
    for (let k = 0; k < n; k++) {
      const zone = zones ? zones[k] : LF.geom && LF.geom.M.UPPER || 0;
      // The proxy's closest insole label is not evidence that a sidewall is
      // foam. Verified support masks anchor the real bed; other imported shell
      // vertices use the upper's tensile limit rather than expanding like EVA.
      const material = input.field && LF.geom && zone===LF.geom.M.INSOLE && !(fixedMask && fixedMask[k]) ? mats[LF.geom.M.UPPER] || options.material || {k1:11,lim:3,k2:90} : mats[zone] || options.material || { k1: 11, lim: 3, k2: 90 };
      stiffness[k] = Math.max(0.1, Number(material.k1) || 11); limits[k] = Math.max(0.05, Number(material.lim) || 3); postStiffness[k] = Math.max(stiffness[k], Number(material.k2) || 90);
      budgets[k] = Math.min(materialStretchLimit(material, Number(input.wearB) || 0), Number(options.maxDrapeMm) || Infinity);
      rigid[k] = options.fixedAll || fixedMask && fixedMask[k] || baseline[k * 3 + 1] <= (options.soleHeightMm == null ? 0 : options.soleHeightMm) ? 2 : stiffness[k] >= 100 ? 1 : 0;
      place(k, positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]);
    }
    function sample(x, y, z) {
      if (collider.boxDistanceSquared(x, y, z) > clearance * clearance + EPS) return null;
      exactQueryCount++;
      const contact = collider.query(x, y, z, query);
      return contact.signedDistance < clearance - 0.002 ? contact : null;
    }
    function constrain(vertex, dx, dy, dz, magnitude) {
      vertex = mesh.representatives[vertex];
      const offset = vertex * 3;
      reactionsKPa[vertex] = Math.max(reactionsKPa[vertex], stiffness[vertex] * Math.min(magnitude, limits[vertex]) + postStiffness[vertex] * Math.max(0, magnitude - limits[vertex]));
      if (rigid[vertex] === 2) return false;
      const step = Math.hypot(dx, dy, dz), stepLimit = Number(options.maxStepMm) || 8;
      if (step > stepLimit) { const ratio = stepLimit / step; dx *= ratio; dy *= ratio; dz *= ratio; limited[vertex] = 1; }
      let nx = positions[offset] + dx, ny = positions[offset + 1] + dy, nz = positions[offset + 2] + dz;
      const rx = nx - anchors[offset], ry = ny - anchors[offset + 1], rz = nz - anchors[offset + 2], length = Math.hypot(rx, ry, rz), cap = budgets[vertex];
      if (length > cap) { nx = anchors[offset] + rx * cap / length; ny = anchors[offset + 1] + ry * cap / length; nz = anchors[offset + 2] + rz * cap / length; limited[vertex] = 1; }
      place(vertex, nx, ny, nz);
      corrected[vertex] = 1; return true;
    }
    function syncWelds() {
      for (let k = 0; k < n; k++) {
        const representative = mesh.representatives[k]; if (representative === k || rigid[k] === 2) continue;
        const source = representative * 3, offset = k * 3;
        // Preserve tiny baseline offsets and explicitly entered mapped displacement.
        let dx = positions[source] - anchors[source], dy = positions[source + 1] - anchors[source + 1], dz = positions[source + 2] - anchors[source + 2];
        const length = Math.hypot(dx, dy, dz), cap = budgets[k];
        if (length > cap) { dx *= cap / length; dy *= cap / length; dz *= cap / length; limited[k] = 1; }
        place(k, anchors[offset] + dx, anchors[offset + 1] + dy, anchors[offset + 2] + dz);
        corrected[k] = corrected[representative]; reactionsKPa[k] = reactionsKPa[representative];
        limited[k] |= limited[representative];
      }
    }
    function correction(contact, x, y, z, directionX = 0, directionY = 0, directionZ = 0) {
      // The closest point provides all three components, including a front-wall x collision.
      // Preserve the garment's outward panel orientation: adjacent corners must not
      // escape to opposite sides of a foot and leave a triangle passing through it.
      if (contact.inside && collider.raycast && Math.hypot(directionX, directionY, directionZ) > 0.5) {
        // An inner lining has the opposite render normal from the outside panel.
        // Both must move away from the foot volume, rather than shoot across it.
        if (collider.centerAt && !(input.field && input.field.shoe && input.field.shoe.shape)) {
          const center = collider.centerAt(x), radial = directionX * (x - center.x) * 0.2 + directionY * (y - center.y) + directionZ * (z - center.z);
          if (radial < 0) { directionX = -directionX; directionY = -directionY; directionZ = -directionZ; }
        }
        const exit = collider.raycast(x, y, z, directionX, directionY, directionZ, 200, ray);
        if (exit) {
          const length = Math.hypot(directionX, directionY, directionZ);
          return [exit.point.x + directionX / length * clearance - x, exit.point.y + directionY / length * clearance - y, exit.point.z + directionZ / length * clearance - z];
        }
      }
      let nx = contact.normal.x, ny = contact.normal.y, nz = contact.normal.z;
      const distance = Math.abs(contact.signedDistance);
      if (distance > EPS) {
        const sign = contact.inside ? -1 : 1;
        nx = (x - contact.point.x) / distance * sign; ny = (y - contact.point.y) / distance * sign; nz = (z - contact.point.z) / distance * sign;
      }
      return [contact.point.x + nx * clearance - x, contact.point.y + ny * clearance - y, contact.point.z + nz * clearance - z];
    }
    const lastContact = new Uint8Array(n);
    function vertexPass(recordInitial, retryOnly) {
      let moved = 0;
      for (let k = 0; k < n; k++) {
        if (mesh.representatives[k] !== k) continue;
        if (retryOnly && !lastContact[k]) continue;
        if ((!recordInitial && rigid[k]===2) || (retryOnly && limited[k])) continue;
        if (!recordInitial && !corrected[k] && !reactionsKPa[k]) continue;
        const offset = k * 3, x = positions[offset], y = positions[offset + 1], z = positions[offset + 2], contact = sample(x, y, z);
        lastContact[k] = contact ? 1 : 0;
        if (!contact) continue;
        const penetration = Math.max(0, -contact.signedDistance);
        if (recordInitial) initialPenetrationMm = Math.max(initialPenetrationMm, penetration);
        contactSampleCount++;
        guide(k);
        const delta = correction(contact, x, y, z, guideVectors[offset], guideVectors[offset + 1], guideVectors[offset + 2]), magnitude = Math.hypot(...delta);
        if (constrain(k, delta[0], delta[1], delta[2], magnitude)) moved++;
      }
      syncWelds();
      return moved;
    }
    const activeFaces = new Uint8Array(mesh.largeFaces.length / 3), faceSamples = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]];
    function facePass(recordInitial) {
      let moved = 0;
      const faces = mesh.largeFaces;
      // A sparse triangle can cut through a foot although all three corners are outside.
      // Centroid plus three edge midpoints constrain the actual rendered surface.
      for (let t = 0; t < faces.length; t += 3) {
        const vertices = [faces[t], faces[t + 1], faces[t + 2]];
        if (!recordInitial && !activeFaces[t / 3] && !corrected[vertices[0]] && !corrected[vertices[1]] && !corrected[vertices[2]]) continue;
        for (const weights of faceSamples) {
          let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, inverseMass = 0;
          for (let j = 0; j < 3; j++) { guide(vertices[j]); const offset = vertices[j] * 3; x += positions[offset] * weights[j]; y += positions[offset + 1] * weights[j]; z += positions[offset + 2] * weights[j]; nx += guideVectors[offset] * weights[j]; ny += guideVectors[offset + 1] * weights[j]; nz += guideVectors[offset + 2] * weights[j]; if (rigid[vertices[j]] < 2) inverseMass += weights[j] * weights[j] / Math.sqrt(stiffness[vertices[j]]); }
          const contact = sample(x, y, z); if (!contact) continue;
          activeFaces[t / 3] = 1;
          initialPenetrationMm = Math.max(initialPenetrationMm, -contact.signedDistance);
          contactSampleCount++;
          const delta = correction(contact, x, y, z, nx, ny, nz), magnitude = Math.hypot(...delta);
          for (let j = 0; j < 3; j++) {
            const vertex = vertices[j], scale = inverseMass > EPS ? weights[j] / Math.sqrt(stiffness[vertex]) / inverseMass : 0;
            if (weights[j] && constrain(vertex, delta[0] * scale, delta[1] * scale, delta[2] * scale, magnitude)) moved++;
          }
        }
      }
      syncWelds();
      return moved;
    }
    function smoothDisplacements() {
      const before = positions.slice(), { starts, neighbors } = mesh;
      for (let k = 0; k < n; k++) {
        if (mesh.representatives[k] !== k) continue;
        if (rigid[k] || !starts[k + 1] || starts[k + 1] === starts[k]) continue;
        const offset = k * 3, degree = starts[k + 1] - starts[k];
        let dx = 0, dy = 0, dz = 0, active = corrected[k], weightSum = 0;
        for (let q = starts[k]; q < starts[k + 1]; q++) {
          const other = mesh.representatives[neighbors[q]], target = other * 3;
          if (zones && zones[k] !== zones[other]) continue;
          active |= corrected[other];
          const weight = 1 / Math.max(0.5, Math.hypot(baseline[offset] - baseline[target], baseline[offset + 1] - baseline[target + 1], baseline[offset + 2] - baseline[target + 2]));
          dx += (before[target] - mapped[target]) * weight; dy += (before[target + 1] - mapped[target + 1]) * weight; dz += (before[target + 2] - mapped[target + 2]) * weight; weightSum += weight;
        }
        if (!active || !weightSum || !degree) continue;
        // Stiff panels resist a sharp local fold; flexible panels follow contact more locally.
        const blend = clamp(0.14 + stiffness[k] / 250, 0.16, 0.36);
        positions[offset] = mapped[offset] + (before[offset] - mapped[offset]) * (1 - blend) + dx / weightSum * blend;
        positions[offset + 1] = mapped[offset + 1] + (before[offset + 1] - mapped[offset + 1]) * (1 - blend) + dy / weightSum * blend;
        positions[offset + 2] = mapped[offset + 2] + (before[offset + 2] - mapped[offset + 2]) * (1 - blend) + dz / weightSum * blend;
        const rx = positions[offset] - anchors[offset], ry = positions[offset + 1] - anchors[offset + 1], rz = positions[offset + 2] - anchors[offset + 2], length = Math.hypot(rx, ry, rz);
        if (length > budgets[k]) { const scale = budgets[k] / length; positions[offset] = anchors[offset] + rx * scale; positions[offset + 1] = anchors[offset + 1] + ry * scale; positions[offset + 2] = anchors[offset + 2] + rz * scale; limited[k] = 1; }
        place(k, positions[offset], positions[offset + 1], positions[offset + 2]);
        corrected[k] = 1;
      }
      syncWelds();
    }
    function constrainEdges() {
      const { starts, neighbors, representatives } = mesh;
      // Local distance constraints prevent a single contact sample from turning a
      // small cloth triangle into a long spike. Rest geometry keeps the reference.
      for (let k = 0; k < n; k++) {
        if (representatives[k] !== k) continue;
        const offset = k * 3;
        for (let q = starts[k]; q < starts[k + 1]; q++) {
          const other = representatives[neighbors[q]]; if (other <= k || (!corrected[k] && !corrected[other])) continue;
          const target = other * 3, dx = positions[target] - positions[offset], dy = positions[target + 1] - positions[offset + 1], dz = positions[target + 2] - positions[offset + 2], length = Math.hypot(dx, dy, dz);
          const restLength = Math.hypot(baseline[target] - baseline[offset], baseline[target + 1] - baseline[offset + 1], baseline[target + 2] - baseline[offset + 2]);
          const strain = clamp(Math.min(limits[k], limits[other]) / 80, 0.005, 0.07), maximum = restLength * (1 + strain) + 0.05;
          if (length <= maximum || length < EPS) continue;
          const a = rigid[k] === 2 ? 0 : 1 / Math.sqrt(stiffness[k]), b = rigid[other] === 2 ? 0 : 1 / Math.sqrt(stiffness[other]), sum = a + b; if (!sum) continue;
          const scale = (length - maximum) / length * 0.5;
          if (a) constrain(k, dx * scale * a / sum, dy * scale * a / sum, dz * scale * a / sum, length - maximum);
          if (b) constrain(other, -dx * scale * b / sum, -dy * scale * b / sum, -dz * scale * b / sum, length - maximum);
          limited[k] = limited[other] = 1;
        }
      }
      syncWelds();
    }
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const moved = vertexPass(iteration === 0) + facePass(iteration === 0); completedIterations = iteration + 1;
      if (!moved) break;
      constrainEdges();
      if (iteration + 1 < maxIterations) smoothDisplacements();
    }
    // Terminal projection settles contacts after the edge relaxation. Retry only
    // the remaining contacts so a deep but feasible wall resolves without a large step.
    facePass(false);
    vertexPass(false);
    vertexPass(false, true);
    vertexPass(false, true);
    let collisionCorrectedVertexCount = 0, contactVertexCount = 0, maxDrapeMm = 0, maxPhysicalDisplacementMm = 0, maxElasticExpansionMm = 0, maxAllowedElasticExpansionMm = 0, maxInwardDisplacementMm = 0, collisionReactionKPa = 0, elasticLimitExceededVertexCount = 0, rigidContactVertexCount = 0, displacementLimitedVertexCount = 0;
    for (let k = 0; k < n; k++) {
      const offset = k * 3, displacement = Math.hypot(positions[offset] - mapped[offset], positions[offset + 1] - mapped[offset + 1], positions[offset + 2] - mapped[offset + 2]);
      const contact = mesh.representatives[k] === k && (corrected[k] || reactionsKPa[k]) ? sample(positions[offset], positions[offset + 1], positions[offset + 2]) : null;
      if (contact) {
        if (-contact.signedDistance > remainingPenetrationMm) worstContact = { kind: 'vertex', vertex: k, rigid: Boolean(rigid[k]), position: [positions[offset], positions[offset + 1], positions[offset + 2]], baseline: [baseline[offset], baseline[offset + 1], baseline[offset + 2]], mapped: [mapped[offset], mapped[offset + 1], mapped[offset + 2]] };
        remainingPenetrationMm = Math.max(remainingPenetrationMm, -contact.signedDistance);
        if (rigid[k]) remainingRigidPenetrationMm = Math.max(remainingRigidPenetrationMm, -contact.signedDistance);
        else remainingFlexiblePenetrationMm = Math.max(remainingFlexiblePenetrationMm, -contact.signedDistance);
      }
      if (displacement > 0.001) collisionCorrectedVertexCount++;
      maxDrapeMm = Math.max(maxDrapeMm, displacement); collisionReactionKPa = Math.max(collisionReactionKPa, reactionsKPa[k]);
      maxPhysicalDisplacementMm = Math.max(maxPhysicalDisplacementMm, Math.hypot(positions[offset] - baseline[offset], positions[offset + 1] - baseline[offset + 1], positions[offset + 2] - baseline[offset + 2]));
      guide(k);
      maxInwardDisplacementMm = Math.max(maxInwardDisplacementMm, -((positions[offset] - baseline[offset]) * guideVectors[offset] + (positions[offset + 1] - baseline[offset + 1]) * guideVectors[offset + 1] + (positions[offset + 2] - baseline[offset + 2]) * guideVectors[offset + 2]));
      maxElasticExpansionMm=Math.max(maxElasticExpansionMm,Math.hypot(positions[offset]-anchors[offset],positions[offset+1]-anchors[offset+1],positions[offset+2]-anchors[offset+2]));
      if(rigid[k]<2)maxAllowedElasticExpansionMm=Math.max(maxAllowedElasticExpansionMm,budgets[k]);
      if (reactionsKPa[k] > 0) { contactVertexCount++; if (rigid[k]) rigidContactVertexCount++; }
      if (displacement > limits[k] + 0.001) elasticLimitExceededVertexCount++;
      if (limited[k]) displacementLimitedVertexCount++;
    }
    // Include unresolved sparse-face collisions, especially next to a fixed outsole.
    for (let t = 0; t < mesh.largeFaces.length; t += 3) {
      if (!activeFaces[t / 3] && !corrected[mesh.largeFaces[t]] && !corrected[mesh.largeFaces[t + 1]] && !corrected[mesh.largeFaces[t + 2]]) continue;
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < 3; j++) { const offset = mesh.largeFaces[t + j] * 3; x += positions[offset] / 3; y += positions[offset + 1] / 3; z += positions[offset + 2] / 3; }
      const contact = sample(x, y, z); if (contact) {
        if (-contact.signedDistance > remainingPenetrationMm) worstContact = { kind: 'triangle', vertices: [mesh.largeFaces[t], mesh.largeFaces[t + 1], mesh.largeFaces[t + 2]], position: [x, y, z] };
        remainingPenetrationMm = Math.max(remainingPenetrationMm, -contact.signedDistance);
        if (rigid[mesh.largeFaces[t]] || rigid[mesh.largeFaces[t + 1]] || rigid[mesh.largeFaces[t + 2]]) remainingRigidPenetrationMm = Math.max(remainingRigidPenetrationMm, -contact.signedDistance);
        else remainingFlexiblePenetrationMm = Math.max(remainingFlexiblePenetrationMm, -contact.signedDistance);
      }
    }
    return { positions, reactionsKPa, reactionKind: 'numerical-collision-penalty-not-contact-pressure', stats: { collisionCorrectedVertexCount, contactVertexCount, contactSampleCount, initialPenetrationMm,
      remainingPenetrationMm: Math.max(0, remainingPenetrationMm), maxDrapeMm, collisionReactionKPa, elasticLimitExceededVertexCount,
      maxPhysicalDisplacementMm, maxElasticExpansionMm, maxAllowedElasticExpansionMm, maxInwardDisplacementMm, expansionOnly: true,
      remainingFlexiblePenetrationMm: Math.max(0, remainingFlexiblePenetrationMm), remainingRigidPenetrationMm: Math.max(0, remainingRigidPenetrationMm),
      rigidContactVertexCount, displacementLimitedVertexCount, worstContact, exactQueryCount, iterations: completedIterations, clearanceMm: clearance, source: 'triangle-contact-expansion-only-drape' } };
  }

  LF.contactDrape = { createCollider, prepare, solve, outwardDirection, guideAt: outwardDirection, materialStretchLimit };
})((window.LF = window.LF || {}));
