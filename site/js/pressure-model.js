// Reduced quasi-static upper contact model. MPa=N/mm²; pressure output is kPa.
// Generalized Laplace membrane balance + incompressible Neo-Hookean tissue.
// Geometry/material defaults are estimates, not product-specific measurements.
(function (LF) {
  'use strict';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function tissuePressure(d, tissue) {
    if (!(d > 0)) return 0;
    const lambda = Math.max(0.001, 1 - d / tissue.thicknessMm);
    return tissue.shearKPa * (1 / lambda - lambda * lambda);
  }
  function membranePressure(d, m) {
    if (!(d > 0)) return 0;
    const k1 = Math.max(0, m.kappa1), k2 = Math.max(0, m.kappa2);
    const a = m.span1Mm, b = m.span2Mm;
    // Local normal offset: conformal strain plus a shallow panel bulge.
    // This reduced geometry assumption is separate from the Laplace law.
    const e1 = k1 * d + 0.5 * (d / a) ** 2, e2 = k2 * d + 0.5 * (d / b) ** 2;
    const factor = m.youngMPa * m.thicknessMm / (1 - m.poisson * m.poisson);
    const n1 = factor * (e1 + m.poisson * e2), n2 = factor * (e2 + m.poisson * e1);
    const c1 = k1 / (1 + k1 * d) + 2 * d / (a * a), c2 = k2 / (1 + k2 * d) + 2 * d / (b * b);
    return 1000 * (n1 * c1 + n2 * c2);
  }
  function inverse(law, p, cap) {
    let lo = 0, hi = cap;
    for (let j = 0; j < 32; j++) { const mid = (lo + hi) / 2; if (law(mid) < p) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  function solve(delta, membrane, tissue, shoeCap, tissueCap, result) {
    const out = result || {}, sCap = Math.max(0, shoeCap), tCap = Math.max(0, Math.min(tissueCap, tissue.thicknessMm * 0.45));
    Object.assign(out, { pressure: 0, shoe: 0, tissue: 0, unresolved: 0, valid: true, maximumStretch: sCap, shoeLimit: sCap, shoeDemand: 0 });
    if (!(delta > 0)) return out; // Unilateral contact: a gap carries no tension/pressure.
    const shoeLaw = (d) => membranePressure(d, membrane), tissueLaw = (d) => tissuePressure(d, tissue);
    if (sCap === 0 || tCap === 0) {
      out.shoe = tCap === 0 ? Math.min(delta, sCap) : 0;
      out.tissue = sCap === 0 ? Math.min(delta, tCap) : 0;
      out.pressure = sCap === 0 ? tissueLaw(out.tissue) : shoeLaw(out.shoe);
    } else {
      const ps = shoeLaw(sCap), pt = tissueLaw(tCap), capacity = Math.min(ps, pt);
      const sAtCap = ps <= pt ? sCap : inverse(shoeLaw, capacity, sCap);
      const tAtCap = pt <= ps ? tCap : inverse(tissueLaw, capacity, tCap);
      if (delta > sAtCap + tAtCap + 1e-7) {
        out.pressure = capacity; out.shoe = sAtCap; out.tissue = tAtCap;
      } else {
        let lo = Math.max(0, delta - tCap), hi = Math.min(delta, sCap);
        for (let j = 0; j < 32; j++) {
          const s = (lo + hi) / 2;
          if (shoeLaw(s) < tissueLaw(delta - s)) lo = s; else hi = s;
        }
        out.shoe = (lo + hi) / 2; out.tissue = delta - out.shoe; out.pressure = shoeLaw(out.shoe);
      }
    }
    out.unresolved = Math.max(0, delta - out.shoe - out.tissue);
    out.valid = out.unresolved <= 0.001;
    out.shoeDemand = Math.max(out.shoe, delta - out.tissue);
    return out;
  }
  // Area is lumped equally to the triangle's vertices (mm²). It does not depend
  // on how many vertices were placed in a particular part of the foot.
  function vertexAreas(mesh) {
    const out = new Float32Array(mesh.n);
    if (!mesh.nx || !mesh.nt) return out;
    const triangles = LF.geom.gridIndex(mesh), p = mesh.pos;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
      const u = [p[b*3]-p[a*3], p[b*3+1]-p[a*3+1], p[b*3+2]-p[a*3+2]];
      const v = [p[c*3]-p[a*3], p[c*3+1]-p[a*3+1], p[c*3+2]-p[a*3+2]];
      const share = Math.hypot(u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]) / 6;
      out[a] += share; out[b] += share; out[c] += share;
    }
    return out;
  }
  function surfaceGeometry(shoe) {
    const out = { kappa1: new Float32Array(shoe.n), kappa2: new Float32Array(shoe.n), span1Mm: new Float32Array(shoe.n).fill(35), span2Mm: new Float32Array(shoe.n).fill(25) };
    const p = shoe.pos, normals = shoe.nrm;
    const curvature = (a, b) => {
      let den = 0, num = 0;
      for (let d = 0; d < 3; d++) { const dx = p[b*3+d]-p[a*3+d]; den += dx*dx; num += (normals[b*3+d]-normals[a*3+d])*dx; }
      // A minimum 10mm resolved radius regularizes sharp seams/poles in the
      // inferred cavity. It is a model resolution limit, not measured padding.
      return den > 1e-6 ? clamp(num / den, 0, 0.1) : 0;
    };
    const dr = Math.max(1, Math.round(8 * shoe.nx / Math.max(1, shoe.Ls)));
    for (let r = 0; r < shoe.nx; r++) {
      let minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
      for (let j=0;j<shoe.nt;j++) { const k=r*shoe.nt+j; minY=Math.min(minY,p[k*3+1]);maxY=Math.max(maxY,p[k*3+1]);minZ=Math.min(minZ,p[k*3+2]);maxZ=Math.max(maxZ,p[k*3+2]); }
      const radius=Math.max(10,Math.min((maxY-minY)/2,(maxZ-minZ)/2));
      for (let j = 0; j < shoe.nt; j++) {
      const k = r * shoe.nt + j;
      const dj = Math.max(1, Math.min(Math.floor(shoe.nt / 8), Math.round(8 * shoe.nt / (2 * Math.PI * radius))));
      out.kappa1[k] = curvature(Math.max(0,r-dr)*shoe.nt+j, Math.min(shoe.nx-1,r+dr)*shoe.nt+j);
      out.kappa2[k] = curvature(r*shoe.nt+(j-dj+shoe.nt)%shoe.nt, r*shoe.nt+(j+dj)%shoe.nt);
      out.span1Mm[k] = clamp(shoe.Ls * 0.14, 25, 45);
      out.span2Mm[k] = clamp(radius * 0.6, 15, 35);
      }
    }
    for (const [pole, row] of [[shoe.S0,0],[shoe.E0,shoe.nx-1]]) if (Number.isInteger(pole)) {
      out.kappa1[pole] = out.kappa2[pole] = 0.05;
      out.span1Mm[pole] = 25; out.span2Mm[pole] = 20;
    }
    return out;
  }
  LF.pressureModel = { tissuePressure, membranePressure, solve, vertexAreas, surfaceGeometry, name: 'laplace-membrane-neo-hookean-v1' };
})((window.LF = window.LF || {}));
