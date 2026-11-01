// Product-specific estimated leather shells bound to their inferred cavities.
// Panel boundaries and strain parameters are engineering assumptions,
// not Dior material measurements. No source GLB topology or texture is changed.
(function (LF) {
  'use strict';
  const PROFILE = 'dior-leather-v1', TAU = Math.PI * 2;
  const HIGH_PROFILE = 'jordan-high-leather-v1';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const enabled = model => Boolean(model && [PROFILE,HIGH_PROFILE].includes(model.fitPhysicsProfile));
  const topologyCache = new WeakMap();

  function shellDirection(shoe, x, y, z) {
    const shape = shoe.shape, section = LF.geom.lastSection(shape, clamp(x, .01, shape.Ls - .01));
    const u = (z - section.c) / Math.max(1, section.a), t = clamp(x / shape.Ls, 0, 1);
    const side = 1 - smooth(.60, .98, Math.abs(u));
    const front = smooth(.89, .995, t) * side, back = (1 - smooth(.005, .14, t)) * side;
    const dx = front - back, radial = 1 - Math.max(front, back);
    const dy = (y - section.ys) / Math.max(2, (section.ytC - section.ybC) * .5) * radial;
    const dz = u * radial, length = Math.hypot(dx, dy, dz);
    return length > 1e-8 ? { x: dx / length, y: dy / length, z: dz / length } : { x: x < shape.Ls * .5 ? -1 : 1, y: 0, z: 0 };
  }

  function supportHeight(shoe, x, z) {
    const shape = shoe.shape || shoe, profile = shape.supportBedProfile;
    const height = profile && LF.supportBed && LF.supportBed.heightAt(profile, x, false, z);
    return Number.isFinite(height) ? height : 0;
  }
  function panelAt(shoe, x, y, z) {
    const shape = shoe.shape || shoe, length = Number(shape.Ls || shoe.Ls) || 274;
    const t = clamp(x / length, 0, 1), section = LF.geom.lastSection(shape, clamp(x, .01, length - .01));
    const height = y - supportHeight(shoe, x, z), halfWidth = Math.max(1, section.a);
    const lateral = Math.abs(z - section.c) / halfWidth;
    const high = shoe.model && shoe.model.fitPhysicsProfile === HIGH_PROFILE;
    // A sole attachment and a toe overlay seam are anatomical masks, not seams
    // detected from the textured GLB. A smooth transition avoids a hard crease.
    const fixedWeight = 1 - smooth(.8, 7, height);
    const toeOverlay = smooth(.91, .965, t);
    const perimeterOverlay = smooth(.69, .91, lateral) * (1 - smooth(10, 20, height));
    const vampSeam = (1 - smooth(.012, .038, Math.abs(t - .735))) * smooth(.35, .75, lateral);
    // The High's rear quarter extends farther forward around its high collar.
    // These are annotated masks, not measured material or padding thicknesses.
    const highQuarter = high ? (1-smooth(.32,.48,t))*smooth(22,40,height)*smooth(.5,.85,lateral) : 0;
    const reinforcement = Math.max(toeOverlay, perimeterOverlay, vampSeam, highQuarter);
    const counter = 1 - smooth(high ? .20 : .16, high ? .32 : .28, t);
    const stiff = Math.max(reinforcement, counter * .85);
    const scale = (Number(shoe.S || shape.S) || length * 270 / 274) / 270;
    const maxOutwardMm = ((2.7 * (1 - stiff) + 1.3 * stiff) * (1 - counter) + .8 * counter) * scale * (1 - fixedWeight);
    return { kind: fixedWeight > .999 ? 'sole-attachment' : counter > .5 ? 'heel-counter' : reinforcement > .5 ? 'toe-overlay-seam' : t > .67 ? 'toe-vamp-leather' : 'quarter-leather',
      stiffnessScale: 1 + reinforcement * .9 + counter * 1.1 + fixedWeight * 3,
      maxOutwardMm, fixedWeight, maxStrain: .035 * (1 - stiff) + .018 * stiff,
      maxCurvatureChangePerMm: (.018 * (1 - stiff) + .010 * stiff) / scale,
      reinforcement, source: 'estimated-anatomical-panel-mask' };
  }

  function topology(shoe) {
    if (topologyCache.has(shoe)) return topologyCache.get(shoe);
    const p = shoe.pos, edges = [], neighbors = Array.from({ length: shoe.n }, () => []), bends = [], seen = new Set();
    function edge(a, b) {
      if (a > b) [a, b] = [b, a];
      const key = a + ':' + b; if (seen.has(key)) return; seen.add(key);
      const length = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
      if (length < .05) return;
      edges.push({ a, b, length }); neighbors[a].push({ k: b, length }); neighbors[b].push({ k: a, length });
    }
    for (let r = 0; r < shoe.nx; r++) for (let j = 0; j < shoe.nt; j++) {
      const k = r * shoe.nt + j, next = r * shoe.nt + (j + 1) % shoe.nt;
      edge(k, next);
      if (r + 1 < shoe.nx) { edge(k, k + shoe.nt); edge(k, (r + 1) * shoe.nt + (j + 1) % shoe.nt); }
      if (r > 0 && r + 1 < shoe.nx) bends.push([k - shoe.nt, k, k + shoe.nt]);
      bends.push([r * shoe.nt + (j + shoe.nt - 1) % shoe.nt, k, next]);
    }
    for (const [pole, r] of [[shoe.S0, 0], [shoe.E0, shoe.nx - 1]]) if (Number.isInteger(pole))
      for (let j = 0; j < shoe.nt; j++) edge(pole, r * shoe.nt + j);
    const angle = (a, b, c, positions) => {
      let dot = 0, aa = 0, bb = 0;
      for (let d = 0; d < 3; d++) { const u = positions[b * 3 + d] - positions[a * 3 + d], v = positions[c * 3 + d] - positions[b * 3 + d]; dot += u * v; aa += u * u; bb += v * v; }
      return aa * bb > 1e-12 ? Math.acos(clamp(dot / Math.sqrt(aa * bb), -1, 1)) : 0;
    };
    const bendRows = bends.map(([a, b, c]) => ({ a, b, c, angle: angle(a, b, c, p),
      length: .5 * (Math.hypot(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]) + Math.hypot(p[c * 3] - p[b * 3], p[c * 3 + 1] - p[b * 3 + 1], p[c * 3 + 2] - p[b * 3 + 2])) }));
    const result = { edges, neighbors, bends: bendRows, angle };
    topologyCache.set(shoe, result); return result;
  }

  function enhanceField(field, display) {
    const shoe = field.shoe, model = shoe.model || display && display.ctx && display.ctx.model;
    if (!enabled(model)) return field;
    const n = shoe.n, p = shoe.pos, topologyInfo = topology(shoe), panels = Array(n), directions = new Float32Array(n * 3);
    const requested = new Float32Array(n), amounts = new Float32Array(n), caps = new Float32Array(n), fixed = new Uint8Array(n);
    const pressure = Float32Array.from(field.pressure || new Float32Array(n)), pressureUnknown = Float32Array.from(field.pressureUnknown || new Float32Array(n));
    const collider = display && display.foot && LF.contactDrape && LF.contactDrape.prepare ? LF.contactDrape.prepare(display) : null;
    const query = { point: {}, normal: {}, triangle: [], barycentric: [] }, ray = { point: {}, normal: {} };
    let contactSampleCount = 0, initialPenetrationMm = 0;
    for (let k = 0; k < n; k++) {
      const o = k * 3, x = p[o], y = p[o + 1], z = p[o + 2], panel = panels[k] = panelAt(shoe, x, y, z);
      fixed[k] = shoe.open && shoe.open[k] || panel.fixedWeight > .999 || shoe.mat && shoe.mat[k] === LF.geom.M.INSOLE ? 1 : 0;
      caps[k] = fixed[k] ? 0 : panel.maxOutwardMm;
      // Smooth the transition from side/rim to toe/heel cap. A discontinuous
      // choice of x versus radial motion would manufacture strain at a seam.
      const guide = shellDirection(shoe, x, y, z);
      directions.set([guide.x, guide.y, guide.z], o);
      requested[k] = Math.max(0, Number(field.stretch && field.stretch[k]) || 0);
      if (!(shoe.open && shoe.open[k]) && collider && (!collider.boxDistanceSquared || collider.boxDistanceSquared(x, y, z) < .64)) {
        const contact = collider.query(x, y, z, query);
        if (contact.signedDistance < .45) {
          contactSampleCount++; initialPenetrationMm = Math.max(initialPenetrationMm, -contact.signedDistance);
          let need = Math.max(0, .45 - contact.signedDistance);
          if (contact.inside && collider.raycast) {
            const hit = collider.raycast(x, y, z, guide.x, guide.y, guide.z, 120, ray);
            if (hit) need = hit.distance + .45;
          }
          requested[k] = Math.max(requested[k], need);
        }
      }
      amounts[k] = Math.min(caps[k], requested[k]);
    }
    const seed = amounts.slice();
    // An obstacle membrane with a bending-length regulariser. Weights use actual
    // rest edge lengths in mm, so the contact spreads across physical distances
    // rather than a fixed count of texture vertices. The rest tether keeps a
    // roomy, noncontact panel at its original shape; no inward closure is added.
    const regularisationLength = 9 * (Number(shoe.S || shoe.shape.S) || shoe.shape.Ls * 270 / 274) / 270;
    for (let pass = 0; pass < 40; pass++) {
      const previous = amounts.slice();
      for (let k = 0; k < n; k++) {
        if (fixed[k]) continue;
        let sum = 0, weight = 1;
        for (const neighbor of topologyInfo.neighbors[k]) {
          const q = neighbor.k, w = regularisationLength ** 2 / Math.max(.5, neighbor.length ** 2) / Math.sqrt(panels[k].stiffnessScale * panels[q].stiffnessScale);
          sum += previous[q] * w; weight += w;
        }
        amounts[k] = Math.min(caps[k], Math.max(seed[k], sum / weight));
      }
    }
    const positions = p.slice();
    const place = (k, factor = 1) => { const o = k * 3; for (let d = 0; d < 3; d++) positions[o + d] = p[o + d] + directions[o + d] * amounts[k] * factor; };
    for (let k = 0; k < n; k++) place(k);
    function edgeRatio(edge, factor = 1) {
      let length2 = 0;
      for (let d = 0; d < 3; d++) { const i = edge.a * 3 + d, j = edge.b * 3 + d, v = p[i] - p[j] + (directions[i] * amounts[edge.a] - directions[j] * amounts[edge.b]) * factor; length2 += v * v; }
      return Math.sqrt(length2) / edge.length;
    }
    function reduce(vertices, test) {
      let lo = 0, hi = 1;
      for (let pass = 0; pass < 9; pass++) { const t = (lo + hi) * .5; if (test(t)) lo = t; else hi = t; }
      for (const k of vertices) { amounts[k] *= lo; place(k); }
    }
    // Position-based projections constrain measured edge strain and change in
    // turning angle. Infeasible contact remains a residual, never extra stretch.
    const mobility = Float32Array.from(seed, (value, k) => fixed[k] ? 0 : 1 / (panels[k].stiffnessScale * (1 + 8 * value)));
    function project(vertices, gradients, violation) {
      let denominator = 0;
      for (let i = 0; i < vertices.length; i++) denominator += mobility[vertices[i]] * gradients[i] ** 2;
      if (denominator < 1e-10) return false;
      const lambda = violation / denominator;
      for (let i = 0; i < vertices.length; i++) {
        const k = vertices[i], correction = clamp(-lambda * mobility[k] * gradients[i], -.25, .25);
        amounts[k] = clamp(amounts[k] + correction, 0, caps[k]); place(k);
      }
      return true;
    }
    let constrained = 0;
    for (let iteration = 0; iteration < 24; iteration++) {
      for (const edge of topologyInfo.edges) {
        const limit = Math.min(panels[edge.a].maxStrain, panels[edge.b].maxStrain);
        if (edgeRatio(edge) > 1 + limit + .00001) {
          const a = edge.a * 3, b = edge.b * 3, dx = positions[a] - positions[b], dy = positions[a + 1] - positions[b + 1], dz = positions[a + 2] - positions[b + 2];
          const length = Math.hypot(dx, dy, dz), ga = (dx * directions[a] + dy * directions[a + 1] + dz * directions[a + 2]) / length;
          const gb = -(dx * directions[b] + dy * directions[b + 1] + dz * directions[b + 2]) / length;
          if (!project([edge.a, edge.b], [ga, gb], length - edge.length * (1 + limit)))
            reduce([edge.a, edge.b], t => edgeRatio(edge, t) <= 1 + limit);
          constrained++;
        }
      }
      for (const bend of topologyInfo.bends) {
        const vertices = [bend.a, bend.b, bend.c], curvatureLimit = Math.min(...vertices.map(k => panels[k].maxCurvatureChangePerMm));
        const limit = clamp(curvatureLimit * bend.length, .025, .20);
        const difference = topologyInfo.angle(bend.a, bend.b, bend.c, positions) - bend.angle;
        if (Math.abs(difference) > limit + .00001) {
          const gradients = vertices.map(k => {
            if (!mobility[k]) return 0;
            const amount = amounts[k], epsilon = .01;
            amounts[k] = amount + epsilon; place(k); const plus = topologyInfo.angle(bend.a, bend.b, bend.c, positions);
            amounts[k] = amount - epsilon; place(k); const minus = topologyInfo.angle(bend.a, bend.b, bend.c, positions);
            amounts[k] = amount; place(k); return Math.sign(difference) * (plus - minus) / (epsilon * 2);
          });
          if (!project(vertices, gradients, Math.abs(difference) - limit))
            reduce(vertices, t => { for (const k of vertices) place(k, t); const valid = Math.abs(topologyInfo.angle(bend.a, bend.b, bend.c, positions) - bend.angle) <= limit; for (const k of vertices) place(k); return valid; });
          constrained++;
        }
      }
    }
    // Gradient projection first transfers load to unconstrained neighbors. Near
    // fixed seams a scalar outward-only degree of freedom can be infeasible;
    // retire only that local excess before the final whole-shell audit, so one
    // tiny seam edge does not attenuate otherwise admissible toe deformation.
    for (let iteration = 0; iteration < 12; iteration++) {
      let changed = 0;
      for (const edge of topologyInfo.edges) {
        const limit = Math.min(panels[edge.a].maxStrain, panels[edge.b].maxStrain);
        if (edgeRatio(edge) > 1 + limit + .00001) { reduce([edge.a, edge.b], t => edgeRatio(edge, t) <= 1 + limit); changed++; }
      }
      for (const bend of topologyInfo.bends) {
        const vertices = [bend.a, bend.b, bend.c], limit = clamp(Math.min(...vertices.map(k => panels[k].maxCurvatureChangePerMm)) * bend.length, .025, .20);
        if (Math.abs(topologyInfo.angle(bend.a, bend.b, bend.c, positions) - bend.angle) > limit + .00001) {
          reduce(vertices, t => { for (const k of vertices) place(k, t); const valid = Math.abs(topologyInfo.angle(bend.a, bend.b, bend.c, positions) - bend.angle) <= limit; for (const k of vertices) place(k); return valid; }); changed++;
        }
      }
      constrained += changed; if (!changed) break;
    }
    // Coupled projections can slightly disturb a neighboring constraint. A final
    // common line search guarantees the complete shell respects both limits.
    function admissible(factor) {
      for (const edge of topologyInfo.edges) if (edgeRatio(edge, factor) > 1 + Math.min(panels[edge.a].maxStrain, panels[edge.b].maxStrain) + .00001) return false;
      for (let k = 0; k < n; k++) place(k, factor);
      for (const bend of topologyInfo.bends) {
        const limit = clamp(Math.min(panels[bend.a].maxCurvatureChangePerMm, panels[bend.b].maxCurvatureChangePerMm, panels[bend.c].maxCurvatureChangePerMm) * bend.length, .025, .20);
        if (Math.abs(topologyInfo.angle(bend.a, bend.b, bend.c, positions) - bend.angle) > limit + .00001) return false;
      }
      return true;
    }
    let constraintScale = 1;
    if (!admissible(1)) { let lo = 0, hi = 1; for (let i = 0; i < 12; i++) { const m = (lo + hi) * .5; if (admissible(m)) lo = m; else hi = m; } constraintScale = lo; }
    for (let k = 0; k < n; k++) { amounts[k] *= constraintScale; place(k); }
    const vectors = new Float32Array(n * 3), closureVectors = new Float32Array(n * 3), closeMm = new Float32Array(n);
    let maxMm = 0, maxAllowed = 0, maxStrain = 0, maxBending = 0, spreadVertexCount = 0, contactVertexCount = 0, limitedVertexCount = 0, constraintInducedUnknownVertexCount = 0;
    let remainingPenetrationMm = 0, remainingFlexiblePenetrationMm = 0, remainingRigidPenetrationMm = 0;
    for (let k = 0; k < n; k++) {
      const o = k * 3; for (let d = 0; d < 3; d++) vectors[o + d] = positions[o + d] - p[o + d];
      maxMm = Math.max(maxMm, amounts[k]); maxAllowed = Math.max(maxAllowed, caps[k]);
      if (amounts[k] > seed[k] + .01) spreadVertexCount++;
      if (requested[k] > amounts[k] + .05) limitedVertexCount++;
      if (!(shoe.open && shoe.open[k]) && collider && (!collider.boxDistanceSquared || collider.boxDistanceSquared(positions[o], positions[o + 1], positions[o + 2]) < .64)) {
        const contact = collider.query(positions[o], positions[o + 1], positions[o + 2], query), residual = Math.max(0, -contact.signedDistance);
        if (contact.signedDistance < .45) contactVertexCount++;
        remainingPenetrationMm = Math.max(remainingPenetrationMm, residual);
        if (fixed[k]) remainingRigidPenetrationMm = Math.max(remainingRigidPenetrationMm, residual);
        else remainingFlexiblePenetrationMm = Math.max(remainingFlexiblePenetrationMm, residual);
        if (!fixed[k] && residual > .20) { if (!pressureUnknown[k]) constraintInducedUnknownVertexCount++; pressureUnknown[k] = 1; pressure[k] = 0; }
      }
    }
    for (const edge of topologyInfo.edges) maxStrain = Math.max(maxStrain, edgeRatio(edge) - 1);
    for (const bend of topologyInfo.bends) maxBending = Math.max(maxBending, Math.abs(topologyInfo.angle(bend.a, bend.b, bend.c, positions) - bend.angle) / Math.max(.01, bend.length));
    const shellStats = { source: model.fitPhysicsProfile===HIGH_PROFILE?'high-shared-obstacle-membrane':'dior-shared-obstacle-membrane', profile: model.fitPhysicsProfile, estimatedPanels: true, expansionOnly: true,
      maxMm, maxElasticExpansionMm: maxMm, maxAllowedElasticExpansionMm: maxAllowed, maxPhysicalDisplacementMm: maxMm, maxInwardDisplacementMm: 0,
      maxTensileStrain: maxStrain, maxCurvatureChangePerMm: maxBending, constraintScale, constrainedProjectionCount: constrained,
      spreadVertexCount, contactVertexCount, contactSampleCount, initialPenetrationMm: Math.max(0, initialPenetrationMm),
      remainingPenetrationMm, remainingFlexiblePenetrationMm, remainingRigidPenetrationMm,
      constraintInducedUnknownVertexCount,
      collisionCorrectedVertexCount: amounts.filter(v => v > .001).length, displacementLimitedVertexCount: limitedVertexCount,
      elasticLimitExceededVertexCount: 0, rigidContactVertexCount: 0, collisionReactionKPa: 0, maxDrapeMm: maxMm, iterations: 76 };
    return { ...field, pressure, pressureUnknown, stretch: amounts, vectors, stretchVectors: vectors.slice(), closureVectors, closeMm,
      maxMm, maxDisplacementMm: maxMm, maxCloseMm: 0, source: shellStats.source, shellStats,
      diorShell: { positions, directions, fixed, caps, requested, panels, restPositions: p, topology: topologyInfo } };
  }

  function sampleShared(field, x, y, z) {
    const shoe = field.shoe, shape = shoe.shape, xx = clamp(x, .01, shape.Ls - .01), section = LF.geom.lastSection(shape, xx);
    // All layers bind once in the same x/polar chart. A lining, leather face and
    // appliqué along one shell ray get exactly the same interpolated vector;
    // their original radial thickness/offset is retained instead of reclamping
    // each visible mesh independently against the foot.
    let angle = Math.atan2(y - section.ys, z - section.c); if (angle < 0) angle += TAU;
    const jj = angle / TAU * shoe.nt, j0 = Math.floor(jj) % shoe.nt, j1 = (j0 + 1) % shoe.nt, f = jj - Math.floor(jj), rows = LF.geom.sectionRows(shoe, xx);
    const out = [0, 0, 0];
    for (const [r, rw] of [[rows.i0, 1 - rows.f], [rows.i1, rows.f]]) for (const [j, jw] of [[j0, 1 - f], [j1, f]])
      for (let d = 0; d < 3; d++) out[d] += field.vectors[(r * shoe.nt + j) * 3 + d] * rw * jw;
    return out;
  }

  function renderPositions(entries, field, display) {
    const result = new Map(), collider = display && display.foot && LF.contactDrape && LF.contactDrape.prepare ? LF.contactDrape.prepare(display) : null;
    const query = { point: {}, normal: {}, triangle: [], barycentric: [] };
    for (const entry of entries) {
      const original = entry.fitBasePositions || entry.originalPositions, positions = original.slice(), stretchVectors = new Float32Array(original.length), closeVectors = new Float32Array(original.length);
      const fixedMask = new Uint8Array(original.length / 3);
      let maxMm = 0, deformed = 0, rigidCount = 0, residual = 0, flexibleResidual = 0, rigidResidual = 0;
      for (let o = 0, k = 0; o < original.length; o += 3, k++) {
        const fixed = entry.rigidSole || entry.fixedMask && entry.fixedMask[k] || original[o + 1] <= supportHeight(field.shoe, original[o], original[o + 2]) + .8;
        fixedMask[k] = +!!fixed;
        const move = fixed ? [0, 0, 0] : sampleShared(field, original[o], original[o + 1], original[o + 2]);
        for (let d = 0; d < 3; d++) { positions[o + d] += move[d]; stretchVectors[o + d] = positions[o + d] - original[o + d]; }
        const mm = Math.hypot(...move); maxMm = Math.max(maxMm, mm); if (mm > .001) deformed++; if (fixed) rigidCount++;
        // This is a diagnostic only: never move layers with an independent solve.
        if (collider && (!collider.boxDistanceSquared || collider.boxDistanceSquared(positions[o], positions[o + 1], positions[o + 2]) < .64)) {
          const gap = collider.query(positions[o], positions[o + 1], positions[o + 2], query).signedDistance, penetration = Math.max(0, -gap);
          residual = Math.max(residual, penetration);
          if (fixed) rigidResidual = Math.max(rigidResidual, penetration); else flexibleResidual = Math.max(flexibleResidual, penetration);
        }
      }
      const stats = { ...(field.shellStats || {}), maxMm, maxElasticExpansionMm: maxMm, maxPhysicalDisplacementMm: maxMm, collisionCorrectedVertexCount: deformed,
        remainingPenetrationMm: residual, remainingFlexiblePenetrationMm: flexibleResidual, remainingRigidPenetrationMm: rigidResidual, fixedVertexCount: rigidCount,
        sharedLayerBinding: true, source: field.shellStats.profile===HIGH_PROFILE?'high-shared-shell-layer-binding':'dior-shared-shell-layer-binding' };
      result.set(entry, { positions, mappedPositions: positions.slice(), stretchVectors, closeVectors, fixedMask, stats, reactionsKPa: null, visualVariants: new Map() });
    }
    return result;
  }

  LF.diorFit = { PROFILE, HIGH_PROFILE, enabled, panelAt, enhanceField, renderPositions, sampleShared };
})((window.LF = window.LF || {}));
