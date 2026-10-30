// LastFit — 2D 단면 비교: 같은 x 위치에서 발 윤곽(히트맵)과 신발 내부 윤곽(원형/변형)을 겹쳐 그린다
(function (LF) {
  'use strict';
  const GM = LF.geom;
  const { fmt } = LF.util;

  function regionName(t) {
    if (t < 0.22) return '뒤꿈치';
    if (t < 0.4) return '발목 앞 · 중족 뒤';
    if (t < 0.58) return '발등 · 아치';
    if (t < 0.79) return '볼 라인';
    return '토박스';
  }

  function cssVar(name, fb) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  }

  // Intersect the displayed triangular surface, including its local tissue compression.
  // A nominal rowX lookup would put the compressed toe at the wrong section position.
  function sliceFoot(foot, sim, positions, x) {
    const points = new Map();
    const edge = (a, b) => {
      const ax = positions[3 * a], bx = positions[3 * b], dx = bx - ax;
      if (Math.abs(dx) < 1e-8 || x < Math.min(ax, bx) - 1e-6 || x > Math.max(ax, bx) + 1e-6) return;
      const f = Math.max(0, Math.min(1, (x - ax) / dx));
      const lerp = (array, offset) => array[a * 3 + offset] * (1 - f) + array[b * 3 + offset] * f;
      const z = lerp(positions, 2), y = lerp(positions, 1);
      points.set(`${Math.round(z * 10000)}:${Math.round(y * 10000)}`, {
        x, z, y, P: sim.P[a] * (1 - f) + sim.P[b] * f,
        unknown: !!(sim.pressureStatus && ((f < .999 && sim.pressureStatus[a] === 1) || (f > .001 && sim.pressureStatus[b] === 1))),
        e: sim.eff[a] * (1 - f) + sim.eff[b] * f,
        ex: !!(sim.ex[a] && sim.ex[b]),
        sole: [GM.Z.SOLE,GM.Z.ARCH].includes(foot.zone[a]) && [GM.Z.SOLE,GM.Z.ARCH].includes(foot.zone[b]),
      });
    };
    for (let r = 0; r + 1 < foot.nx; r++) for (let j = 0; j < foot.nt; j++) {
      const a = r * foot.nt + j, b = (r + 1) * foot.nt + j;
      const c = (r + 1) * foot.nt + (j + 1) % foot.nt, d = r * foot.nt + (j + 1) % foot.nt;
      edge(a, b); edge(b, c); edge(c, a); edge(a, c); edge(c, d); edge(d, a);
    }
    if (Number.isInteger(foot.S0) && Number.isInteger(foot.E0)) {
      const last = (foot.nx - 1) * foot.nt;
      for (let j = 0; j < foot.nt; j++) {
        const next = (j + 1) % foot.nt;
        edge(foot.S0, j); edge(j, next); edge(next, foot.S0);
        edge(foot.E0, last + next); edge(last + next, last + j); edge(last + j, foot.E0);
      }
    }
    const result = Array.from(points.values());
    if (result.length < 3) return [];
    const cy = result.reduce((sum, p) => sum + p.y, 0) / result.length;
    const cz = result.reduce((sum, p) => sum + p.z, 0) / result.length;
    return result.sort((a, b) => Math.atan2(a.y - cy, a.z - cz) - Math.atan2(b.y - cy, b.z - cz));
  }

  // display: engine.evaluate().display, deform: engine.shoeDeflection(display), xShoe: 신발 프레임 x(mm)
  function drawSection(canvas, display, deform, xShoe) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return null;
    if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
    if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);

    const { foot, sim, ctx } = display;
    const shoe = display.wornLast || display.shoe, original = display.shoe;
    const xOff = ctx.sock + 0.5 + ctx.slide + (ctx.seat ? ctx.seat.x : 0);

    // 신발 단면
    const sr = GM.sectionRows(shoe, xShoe);
    const nt = shoe.nt;
    const inner = [], deformed = [], wallMid = [], open = [];
    let maxDefl = 0, maxClosure = 0;
    for (let j = 0; j < nt; j++) {
      const a = sr.i0 * nt + j, b = sr.i1 * nt + j;
      const f = sr.f;
      const L = (arr, k) => arr[3 * a + k] * (1 - f) + arr[3 * b + k] * f;
      const z = L(shoe.pos, 2), y = L(shoe.pos, 1);
      const nz = L(shoe.nrm, 2), ny = L(shoe.nrm, 1);
      const nl = Math.hypot(nz, ny) || 1;
      const df = deform.defl[a] * (1 - f) + deform.defl[b] * f;
      maxDefl = Math.max(maxDefl, df);
      const oz = L(original.pos, 2), oy = L(original.pos, 1);
      maxClosure = Math.max(maxClosure, Math.hypot(z - oz, y - oy));
      inner.push([oz, oy]);
      deformed.push([z + (nz / nl) * df, y + (ny / nl) * df]);
      wallMid.push([z + (nz / nl) * (df + 1.4), y + (ny / nl) * (df + 1.4)]);
      open.push(shoe.open[a] && shoe.open[b]);
    }

    // 발 단면(표시 위치 기준)
    const fpts = sliceFoot(foot, sim, deform.fpos, xShoe);
    const fnt = fpts.length;
    let worst = null, best = null, unresolved = null;
    for (const { z, y, ex, P, e, sole, unknown } of fpts) {
      if (!ex && !sole && unknown) { unresolved = { z,y };continue; }
      if (!ex && !sole) {
        if (P > 0.5 && (!worst || P > worst.P)) worst = { z, y, P };
        if (P <= 0 && e < 0 && (!best || e < best.e)) best = { z, y, e };
      }
    }
    const footInside = fpts.length >= 3;

    // 화면 맞춤
    let minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    const grow = (z, y) => { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
    wallMid.forEach(([z, y], j) => { if (!open[j]) grow(z, y); });
    if (footInside) fpts.forEach((p) => grow(p.z, p.y));
    if (!Number.isFinite(minZ)) return null;
    maxY = Math.max(maxY, minY + 30);
    const padX = 34, padTop = 30, padBot = 26;
    const s = Math.min((cw - 2 * padX) / (maxZ - minZ), (ch - padTop - padBot) / (maxY - minY));
    const cx = cw / 2 - ((minZ + maxZ) / 2) * s;
    const cy = padTop + (maxY - minY) * s / 2 + ((minY + maxY) / 2) * s;
    // 모델 프레임 +z(안쪽)를 화면 오른쪽에: 앞에서 본 오른발 단면
    const X = (z) => cx + z * s;
    const Y = (y) => cy - y * s;

    const ink = cssVar('--ink', '#161a1d');
    const muted = cssVar('--muted', '#6a7479');
    const wallC = cssVar('--wall', '#9aa5a0');
    const footFill = cssVar('--foot-fill', '#ece7e1');

    // 바닥선
    g.strokeStyle = cssVar('--line-strong', '#b9c1bc');
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(padX * 0.5, Y(0) + 0.5);
    g.lineTo(cw - padX * 0.5, Y(0) + 0.5);
    g.stroke();

    // 신발 벽
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = wallC;
    g.lineWidth = Math.max(2, 2.8 * s);
    for (let j = 0; j < nt; j++) {
      const k = (j + 1) % nt;
      if (open[j] || open[k]) continue;
      g.beginPath();
      g.moveTo(X(wallMid[j][0]), Y(wallMid[j][1]));
      g.lineTo(X(wallMid[k][0]), Y(wallMid[k][1]));
      g.stroke();
    }
    // 원래 내부 형상(점선) — 변형이 있을 때만
    if (maxDefl > 0.15 || maxClosure > 0.15) {
      g.setLineDash([3, 3]);
      g.strokeStyle = muted;
      g.lineWidth = 1;
      g.beginPath();
      let pen = false;
      for (let j = 0; j <= nt; j++) {
        const k = j % nt;
        if (open[k]) { pen = false; continue; }
        if (!pen) { g.moveTo(X(inner[k][0]), Y(inner[k][1])); pen = true; }
        else g.lineTo(X(inner[k][0]), Y(inner[k][1]));
      }
      g.stroke();
      g.setLineDash([]);
    }

    // 발
    if (footInside) {
      g.fillStyle = footFill;
      g.beginPath();
      fpts.forEach((p, j) => (j ? g.lineTo(X(p.z), Y(p.y)) : g.moveTo(X(p.z), Y(p.y))));
      g.closePath();
      g.fill();
      const col = new THREE.Color();
      g.lineWidth = 3.2;
      for (let j = 0; j < fnt; j++) {
        const p = fpts[j], q = fpts[(j + 1) % fnt];
        if (p.ex || q.ex) col.set(cssVar('--skin', '#d6cfc7'));
        else if (p.unknown || q.unknown) col.set('#e32636');
        else {
          const v = p.sole ? Math.min(0, Math.max(-1.5, p.e)) * 0.6 : p.P > 0 ? p.P : p.e;
          LF.Viewer.heatColor(v, col);
          col.convertLinearToSRGB();
        }
        g.strokeStyle = '#' + col.getHexString();
        g.beginPath();
        g.moveTo(X(p.z), Y(p.y));
        g.lineTo(X(q.z), Y(q.y));
        g.stroke();
      }
    }

    // 주석
    g.font = '600 11px "IBM Plex Mono", ui-monospace, monospace';
    g.textBaseline = 'middle';
    const label = (px, py, text, color) => {
      const w = g.measureText(text).width + 10;
      const lx = Math.min(cw - w - 4, Math.max(4, px - w / 2));
      const ly = Math.max(10, Math.min(ch - 12, py));
      g.fillStyle = cssVar('--raised', '#ffffff');
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.beginPath();
      g.rect(lx, ly - 9, w, 18);
      g.fill();
      g.stroke();
      g.fillStyle = ink;
      g.fillText(text, lx + 5, ly + 0.5);
    };
    if (footInside && worst) {
      g.fillStyle = '#d63a3a';
      g.beginPath();
      g.arc(X(worst.z), Y(worst.y), 3.5, 0, Math.PI * 2);
      g.fill();
      label(X(worst.z), Y(worst.y) - 18, `${fmt(worst.P, 0)} kPa`, '#d63a3a');
    }
    if (footInside && unresolved) label(X(unresolved.z),Y(unresolved.y)-18,'변형 한계 초과', '#e32636');
    if (footInside && best && best.e < -1.5) {
      label(X(best.z), Y(best.y) + (best.y > (minY + maxY) / 2 ? -18 : 18), `여유 ${fmt(-best.e)}mm`, '#2b59c3');
    }
    g.font = '500 10.5px "IBM Plex Sans KR", system-ui, sans-serif';
    g.fillStyle = muted;
    g.textBaseline = 'alphabetic';
    g.fillText('바깥쪽', 8, ch - 8);
    const inTxt = '안쪽 · 엄지';
    g.fillText(inTxt, cw - g.measureText(inTxt).width - 8, ch - 8);

    const t = (xShoe - xOff) / foot.L;
    return { t, region: regionName(t), maxDefl, maxClosure, footInside };
  }

  LF.drawSection = drawSection;
  LF.section = { sliceFoot };
})((window.LF = window.LF || {}));
