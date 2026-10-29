// LastFit — 파라메트릭 3D 형상 생성
// 발과 신발 내부(라스트)를 같은 방식으로 만든다: 발 길이 방향(x)으로 단면을 쌓는 로프트(loft) 메시.
// 좌표계(모델 프레임, mm): x = 뒤꿈치 → 발끝, y = 위, z = 안쪽(엄지 쪽)이 +.
// 화면에서는 z를 뒤집어 오른발로 보이게 한다(viewer.js).
(function (LF) {
  'use strict';
  const { clamp, smoothstep, gauss, cap, pchip } = LF.util;

  // 구역 ID (발 정점 분류)
  const Z = { TOE_FRONT: 0, TOE_BOX: 1, BALL: 2, INSTEP: 3, ARCH: 4, HEEL: 5, SOLE: 6, NONE: 255 };
  const ZONE_KEYS = ['toeFront', 'toeBox', 'ball', 'instep', 'arch', 'heel'];

  // 신발 소재 구역 ID (신발 정점 분류)
  const M = { UPPER: 0, TOECAP: 1, COUNTER: 2, TONGUE: 3, INSOLE: 4 };

  // ---------- 공통 로프트 그리드 ----------
  // 길이 방향 샘플: 양 끝(뒤꿈치·발끝)이 촘촘하도록 선형+코사인 혼합 간격
  function rowT(i, nx) {
    const s = (i + 0.5) / nx;
    return 0.62 * s + 0.38 * (1 - Math.cos(Math.PI * s)) / 2;
  }

  // 초타원 단면 파라미터: 위쪽 반(v>=0)과 아래쪽 반(v<0)에 서로 다른 지수
  function superRing(nt, nTop, nBot) {
    const U = new Float64Array(nt);
    const V = new Float64Array(nt);
    for (let j = 0; j < nt; j++) {
      const th = (2 * Math.PI * j) / nt;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const n = s >= 0 ? nTop : nBot;
      U[j] = Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      V[j] = Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    }
    return { U, V };
  }

  function newGrid(nx, nt) {
    const n = nx * nt + 2;
    return {
      nx, nt, n,
      pos: new Float32Array(3 * n),
      nrm: new Float32Array(3 * n),
      rowX: new Float64Array(nx),
      S0: nx * nt, // 시작 극점(뒤꿈치)
      E0: nx * nt + 1, // 끝 극점(발끝)
    };
  }

  function computeNormals(G) {
    const { nx, nt, pos, nrm, S0, E0 } = G;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nt; j++) {
        const k = i * nt + j;
        const kp = i + 1 < nx ? k + nt : E0;
        const km = i > 0 ? k - nt : S0;
        const jp = i * nt + ((j + 1) % nt);
        const jm = i * nt + ((j - 1 + nt) % nt);
        const ax = pos[3 * kp] - pos[3 * km];
        const ay = pos[3 * kp + 1] - pos[3 * km + 1];
        const az = pos[3 * kp + 2] - pos[3 * km + 2];
        const bx = pos[3 * jp] - pos[3 * jm];
        const by = pos[3 * jp + 1] - pos[3 * jm + 1];
        const bz = pos[3 * jp + 2] - pos[3 * jm + 2];
        let cx = ay * bz - az * by;
        let cy = az * bx - ax * bz;
        let cz = ax * by - ay * bx;
        let len = Math.hypot(cx, cy, cz);
        if (len < 1e-9) {
          // 단면이 한 점으로 모인 곳(극점 근처): 길이 방향을 법선으로 사용
          cx = ax; cy = ay; cz = az;
          len = Math.hypot(cx, cy, cz) || 1;
        }
        nrm[3 * k] = cx / len;
        nrm[3 * k + 1] = cy / len;
        nrm[3 * k + 2] = cz / len;
      }
    }
    nrm[3 * S0] = -1; nrm[3 * S0 + 1] = 0; nrm[3 * S0 + 2] = 0;
    nrm[3 * E0] = 1; nrm[3 * E0 + 1] = 0; nrm[3 * E0 + 2] = 0;
  }

  function gridIndex(G) {
    const { nx, nt, S0, E0 } = G;
    const idx = new Uint32Array(((nx - 1) * nt * 2 + 2 * nt) * 3);
    let p = 0;
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < nt; j++) {
        const a = i * nt + j;
        const b = (i + 1) * nt + j;
        const c = (i + 1) * nt + ((j + 1) % nt);
        const d = i * nt + ((j + 1) % nt);
        idx[p++] = a; idx[p++] = b; idx[p++] = c;
        idx[p++] = a; idx[p++] = c; idx[p++] = d;
      }
    }
    const last = (nx - 1) * nt;
    for (let j = 0; j < nt; j++) {
      idx[p++] = S0; idx[p++] = j; idx[p++] = (j + 1) % nt;
      idx[p++] = E0; idx[p++] = last + ((j + 1) % nt); idx[p++] = last + j;
    }
    return idx;
  }

  // ---------- 발 ----------
  // 발가락 끝선(toe line) 정의: 바깥(새끼)→안쪽(엄지) 순서
  const TOE_LEN = {
    egyptian: [0.868, 0.912, 0.948, 0.978, 1.0],
    greek: [0.874, 0.92, 0.962, 1.0, 0.986],
    square: [0.892, 0.94, 0.98, 0.994, 1.0],
  };
  const TOE_S = [0.09, 0.27, 0.45, 0.62, 0.85];
  const TOE_W = [0.09, 0.09, 0.09, 0.09, 0.15];

  // 발가락 끝선 포락선 e(z): 각 z 위치에서 발이 x 방향으로 어디까지 뻗는지
  function makeToeEnvelope(z0, z1, L, lens) {
    const N = 161;
    const span = z1 - z0;
    const raw = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const z = z0 + (span * k) / (N - 1);
      let best = -1e9;
      for (let i = 0; i < 5; i++) {
        const zc = z0 + span * TOE_S[i];
        const w = span * TOE_W[i];
        const r = Math.min(w * 1.15, 14);
        const q = (z - zc) / w;
        // Adjacent toe ellipses meet at their endpoints. Round-off at |q|=1
        // must not leave the -1e9 sentinel in the sampled silhouette.
        if (Math.abs(q) <= 1 + 1e-9) {
          const v = lens[i] * L - r + r * Math.sqrt(Math.max(0, 1 - q * q));
          if (v > best) best = v;
        }
      }
      raw[k] = best;
    }
    // 단봉(unimodal) 상한 포락선: 발가락 사이 골을 메워 양말 신은 발 윤곽으로
    let peak = 0;
    for (let k = 1; k < N; k++) if (raw[k] > raw[peak]) peak = k;
    const e = new Float64Array(N);
    let run = -1e9;
    for (let k = 0; k <= peak; k++) { run = Math.max(run, raw[k]); e[k] = run; }
    run = -1e9;
    for (let k = N - 1; k >= peak; k--) { run = Math.max(run, raw[k]); e[k] = run; }
    // 가벼운 평활화
    const sm = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      let s = 0, c = 0;
      for (let q = -3; q <= 3; q++) {
        const kk = k + q;
        if (kk >= 0 && kk < N) { s += e[kk]; c++; }
      }
      sm[k] = s / c;
    }
    sm[peak] = Math.max(sm[peak], e[peak] - 0.2);
    let min = Infinity;
    for (let k = 0; k < N; k++) min = Math.min(min, sm[k]);
    const dz = span / (N - 1);
    return {
      min,
      max: sm[peak],
      at(z) {
        const f = clamp((z - z0) / dz, 0, N - 1);
        const k = Math.min(N - 2, Math.floor(f));
        const u = f - k;
        return sm[k] * (1 - u) + sm[k + 1] * u;
      },
      // x 위치에서 발이 존재하는 z 구간
      interval(x) {
        if (x <= min) return [z0, z1];
        let a = -1, b = -1;
        for (let k = 0; k < N; k++) if (sm[k] >= x) { a = k; break; }
        for (let k = N - 1; k >= 0; k--) if (sm[k] >= x) { b = k; break; }
        if (a < 0) { const zp = z0 + peak * dz; return [zp, zp]; }
        let za = z0 + a * dz;
        let zb = z0 + b * dz;
        if (a > 0) za -= dz * clamp((sm[a] - x) / (sm[a] - sm[a - 1] || 1), 0, 1);
        if (b < N - 1) zb += dz * clamp((sm[b] - x) / (sm[b] - sm[b + 1] || 1), 0, 1);
        return [za, zb];
      },
    };
  }

  // 평면 윤곽(발과 라스트 공통 비율). 축 = 뒤꿈치 중심 → 둘째 발가락.
  // 그래서 앞발은 바깥쪽(새끼 쪽)이 더 넓다: 볼 라인에서 안쪽 0.42W, 바깥쪽 0.58W.
  function planCurves(W, Hw) {
    const med = pchip([[0, 0], [0.025, 0.33 * Hw], [0.07, 0.46 * Hw], [0.15, 0.5 * Hw], [0.26, 0.5 * Hw],
      [0.42, 0.34 * W], [0.58, 0.385 * W], [0.7, 0.42 * W], [0.79, 0.41 * W], [0.89, 0.39 * W], [1, 0.37 * W]]);
    const lat = pchip([[0, 0], [0.025, 0.33 * Hw], [0.07, 0.46 * Hw], [0.15, 0.5 * Hw], [0.26, 0.54 * Hw],
      [0.42, 0.46 * W], [0.55, 0.53 * W], [0.645, 0.58 * W], [0.72, 0.565 * W], [0.8, 0.52 * W], [0.88, 0.45 * W], [1, 0.38 * W]]);
    return { med, lat };
  }

  // 1장짜리 평면 사진에서는 좌우 발·높이를 판별하지 않는다. 추출 폭을 길이 방향으로
  // 로프트하고, 안쪽/바깥쪽 비율과 높이는 사용자가 수정 가능한 데모 가정을 유지한다.
  function profileCurves(profile, W, Hw) {
    if (!profile || !Array.isArray(profile.points)) return null;
    const points = profile.points
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.width) && p.t >= 0 && p.t <= 1)
      .sort((a, b) => a.t - b.t)
      .filter((p, i, all) => i === 0 || p.t > all[i - 1].t);
    if (points.length < 6) return null;
    const pts = points.map((p) => [p.t, clamp(p.width, 0, 1.6)]);
    if (pts[0][0] !== 0) pts.unshift([0, 0]); else pts[0][1] = 0;
    if (pts[pts.length - 1][0] !== 1) pts.push([1, 0]); else pts[pts.length - 1][1] = 0;
    const width = pchip(pts);
    let heelRatio = 0;
    for (let i = 0; i <= 40; i++) heelRatio = Math.max(heelRatio, width(0.06 + 0.24 * i / 40));
    if (heelRatio < 0.05) return null;
    const heelScale = clamp(Hw / (W * heelRatio), 0.4, 2.5);
    const fullWidth = (t) => W * width(clamp(t, 0, 1)) * (1 + (heelScale - 1) * (1 - smoothstep(0.28, 0.55, t)));
    // Registered 3D sections carry their centreline. Keep medial/lateral asymmetry instead of
    // imposing the generic 42:58 foot ratio on the measured product.
    if (points.every((p) => Number.isFinite(p.med) && Number.isFinite(p.lat))) {
      const center = pchip(points.map((p) => [p.t, 0.5 * (p.med - p.lat)]));
      return { med: (t) => W * center(t) + 0.5 * fullWidth(t), lat: (t) => 0.5 * fullWidth(t) - W * center(t), fullWidth };
    }
    return { med: (t) => 0.42 * fullWidth(t), lat: (t) => 0.58 * fullWidth(t), fullWidth };
  }

  function heightProfileCurve(profile, instepHeight, toeHeight) {
    if (!profile || !Array.isArray(profile.points)) return null;
    const points = profile.points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.height) && p.t >= 0 && p.t <= 1)
      .sort((a, b) => a.t - b.t).filter((p, i, all) => i === 0 || p.t > all[i - 1].t);
    if (points.length < 6) return null;
    const curve = pchip(points.map((p) => [p.t, Math.max(0.5, p.height)]));
    const baseHeight = profile.referenceHeight || instepHeight;
    const baseToe = profile.referenceToeHeight || toeHeight;
    return (t) => {
      const u = clamp(t, 0, 1), f = smoothstep(0.72, 0.84, u);
      const scale = (instepHeight / baseHeight) * (1 - f) + (toeHeight / baseToe) * f;
      return curve(u) * scale;
    };
  }

  function profileEnvelope(curves, L) {
    const rows = [];
    let z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i <= 400; i++) {
      const t = i / 400, lo = -curves.lat(t), hi = curves.med(t);
      rows.push({ t, lo, hi });
      z0 = Math.min(z0, lo); z1 = Math.max(z1, hi);
    }
    const values = new Float64Array(161);
    for (let i = 0; i < values.length; i++) {
      const z = z0 + (z1 - z0) * i / (values.length - 1);
      let end = 0;
      for (const row of rows) if (row.lo <= z && z <= row.hi) end = row.t * L;
      values[i] = end;
    }
    return {
      min: 0, max: L,
      at(z) {
        const f = clamp((z - z0) / (z1 - z0) * (values.length - 1), 0, values.length - 1);
        const i = Math.min(values.length - 2, Math.floor(f));
        return values[i] * (1 - (f - i)) + values[i + 1] * (f - i);
      },
      interval(x) { const t = clamp(x / L, 0, 1); return [-curves.lat(t), curves.med(t)]; },
    };
  }

  // 발 형상 파라미터 → 단면 함수들
  function footShape(F, st) {
    const L = F.length * st.len;
    const W = F.ballWidth * st.wid;
    const Hw = F.heelWidth * (1 + (st.wid - 1) * 0.5);
    const Ih = F.instepHeight * st.girth;
    const tH = F.toeHeight * st.girth;
    const outline = profileCurves(F.silhouetteProfile || F.profile, W, Hw);
    const { med, lat } = outline || planCurves(W, Hw);
    const top = pchip([[0, 1.3 * Ih], [0.2, 1.3 * Ih], [0.35, 1.17 * Ih], [0.5, Ih], [0.62, 0.83 * Ih], [0.72, 0.63 * Ih],
      [0.8, 1.3 * tH], [0.88, 1.08 * tH], [0.95, tH], [1, 0.95 * tH]]);
    const env = outline ? profileEnvelope(outline, L) : makeToeEnvelope(-lat(0.8), med(0.8), L, TOE_LEN[F.toeShape] || TOE_LEN.egyptian);
    return {
      L, W, Hw, Ih, tH, med, lat, top, env,
      fromSilhouette: Boolean(outline),
      archA: (3 + 16 * F.archHeight) * st.arch,
      bunion: F.bunion * 6,
      yc: 0.42 * tH,
    };
  }

  function footSection(S, x) {
    const t = x / S.L;
    let zMed = S.med(t);
    let zLat = -S.lat(t);
    if (x > S.env.min) {
      const iv = S.env.interval(x);
      zLat = Math.max(zLat, iv[0]);
      zMed = Math.min(zMed, iv[1]);
      if (zMed < zLat) { const m = (zMed + zLat) / 2; zMed = zLat = m; }
    }
    const top = S.top(t);
    const ytC = 30 + (top - 30) * cap(x / 18);
    const ybC = 28 * (1 - cap(x / 26));
    // The metatarsal width lies nearer the plantar surface than the instep
    // crown. Keep measured width/height, but avoid a bulky rounded-box volume.
    const widthPlane = 0.32 - 0.14 * smoothstep(0.35, 0.6, t);
    const ys = ybC + widthPlane * (ytC - ybC);
    return { t, x, zLat, zMed, c: (zMed + zLat) / 2, a: (zMed - zLat) / 2, ytC, ybC, ys };
  }

  const FOOT_RING = { nTop: 2.3, nBot: 4 };

  function buildFoot(F, st, nx, nt) {
    const S = footShape(F, st);
    const G = newGrid(nx, nt);
    const ring = superRing(nt, FOOT_RING.nTop, FOOT_RING.nBot);
    const { pos } = G;
    G.L = S.L;
    G.tv = new Float32Array(G.n); // 정점별 길이 비율 t
    G.zn = new Float32Array(G.n); // 정점별 안쪽(+1)/바깥쪽(-1) 위치
    G.vv = new Float32Array(G.n); // 정점별 위(+1)/아래(-1) 위치
    for (let i = 0; i < nx; i++) {
      const x = rowT(i, nx) * S.L;
      G.rowX[i] = x;
      const sec = footSection(S, x);
      const upperRing = superRing(nt, FOOT_RING.nTop - .7 * smoothstep(.32,.6,sec.t), FOOT_RING.nBot);
      const skew = 0.04 + 0.1 * smoothstep(0.55, 0.8, sec.t);
      const arch = S.archA * gauss(sec.t, 0.43, 0.09);
      const bun = S.bunion * gauss(sec.t, 0.7, 0.035);
      for (let j = 0; j < nt; j++) {
        const u = upperRing.U[j];
        const v = upperRing.V[j];
        const z0 = sec.c + sec.a * u;
        let y;
        if (v >= 0) {
          const yT = sec.ytC * (1 + skew * u);
          y = sec.ys + (yT - sec.ys) * v;
        } else {
          const yB = Math.min(sec.ybC + arch * smoothstep(-0.3, 0.95, u), sec.ys - 2);
          y = sec.ys + (sec.ys - yB) * v;
        }
        // 발가락 끝 둥글림: 각 z에서 발가락 끝선까지 남은 거리에 따라 높이를 모은다
        const f = S.fromSilhouette && sec.t < 0.78 ? 1 : cap((S.env.at(z0) - x) / 10);
        if (f < 1) y = S.yc + (y - S.yc) * f;
        // 무지외반: 엄지 관절 안쪽 돌출
        const z = z0 + bun * smoothstep(0.2, 0.9, u) * (1 - 0.6 * Math.abs(v));
        const k = i * nt + j;
        pos[3 * k] = x; pos[3 * k + 1] = y; pos[3 * k + 2] = z;
        G.tv[k] = sec.t; G.zn[k] = u; G.vv[k] = v;
      }
    }
    const s0 = footSection(S, 0.0001);
    pos[3 * G.S0] = 0; pos[3 * G.S0 + 1] = (s0.ytC + s0.ybC) / 2; pos[3 * G.S0 + 2] = s0.c;
    const zPeak = S.env.interval(S.env.max - 0.05);
    pos[3 * G.E0] = S.env.max; pos[3 * G.E0 + 1] = S.yc; pos[3 * G.E0 + 2] = (zPeak[0] + zPeak[1]) / 2;
    G.tv[G.S0] = 0; G.tv[G.E0] = 1;
    computeNormals(G);
    classifyFoot(G);
    G.shape = S;
    G.leg = { x: 0.2 * S.L, z: footSection(S, 0.2 * S.L).c, rx: 0.56 * S.Hw, rz: 0.52 * S.Hw, y0: 40, y1: 165 };
    return G;
  }

  // 발 정점 → 평가 구역, 연조직 강성(kPa/mm)
  function classifyFoot(G) {
    const { n, nrm, tv, zn } = G;
    G.zone = new Uint8Array(n);
    G.kf = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const t = tv[k];
      const nxv = nrm[3 * k];
      const ny = nrm[3 * k + 1];
      const u = zn[k];
      let z;
      let kf = 22;
      if (ny < -0.55) {
        z = t > 0.27 && t < 0.62 && u > -0.35 ? Z.ARCH : Z.SOLE;
        kf = 15;
      } else if (t > 0.82 && nxv > 0.45) { z = Z.TOE_FRONT; kf = 24; }
      else if (t > 0.78) { z = Z.TOE_BOX; kf = 24; }
      else if (t > 0.57) { z = Z.BALL; if (Math.abs(u) > 0.6) kf = 34; }
      else if (t > 0.3) { z = Z.INSTEP; if (ny > 0.6) kf = 30; }
      else { z = Z.HEEL; if (nxv < -0.5) kf = 32; }
      G.zone[k] = z;
      G.kf[k] = kf;
    }
  }

  // ---------- 신발 내부(디지털 라스트) ----------
  function lastShape(Mdl, size, wIdx, lacing) {
    const S = size;
    const d = LF.product.dimensions(Mdl, size, wIdx, lacing);
    const Wb = d.width, Hs = d.heelWidth, Is = d.instepHeight, Tb = d.toeHeight, Ls = d.length;
    const profile = profileCurves(Mdl.silhouetteProfile, Wb, Hs);
    const heightProfile = heightProfileCurve(Mdl.heightProfile, Is, Tb);
    const x0 = Mdl.toe.start * S;
    const { med, lat } = planCurves(Wb, Hs);
    const m0 = med(x0 / S);
    const l0 = lat(x0 / S);
    const zc = -l0 + Mdl.toe.tipS * (m0 + l0);
    const topBody = pchip([[0, 1.3 * Is], [0.2, 1.3 * Is], [0.35, 1.16 * Is], [0.5, Is], [0.62, 0.85 * Is], [0.72, 0.67 * Is]]);
    const xb = 0.72 * S;
    // 토박스 천장: 발가락 뿌리(0.8S)에서 Tb보다 높고, 앞코로 갈수록 낮아진다
    const topToe = pchip([[xb, 0.67 * Is], [0.8 * S, 1.18 * Tb], [0.88 * S, 1.03 * Tb], [Ls, Tb * 0.92]]);
    const c = Mdl.collar;
    const collar = pchip([[0, c.back], [0.12, c.back - 4], [0.24, c.low], [c.throat - 0.02, c.low + 10], [c.throat + 0.05, 400]]);
    return { S, Ls, Wb, Hs, Is, Tb, x0, med, lat, m0, l0, zc: profile ? 0 : zc, profile,
      heightProfile, radialProfile: Mdl.radialProfile || null, glbCalibration: Mdl.glbCalibration || null,
      supportBedProfile: Mdl.supportBedProfile || null, fromGlb: Boolean(Mdl.glbCalibration),
      topBody, topToe, xb, collar, openingEnd:c.throat+.05, toe: Mdl.toe, arch: Mdl.arch, cup: Mdl.cup };
  }

  function sampleRadialProfile(T,x,angle=0) {
    const profile=T.radialProfile;
    if(!profile || !profile.points || profile.points.length<2)return null;
    const f=clamp(x/T.Ls,0,1)*(profile.points.length-1),a=Math.floor(f),b=Math.min(a+1,profile.points.length-1),u=f-a;
    const row0=profile.points[a],row1=profile.points[b],nt=profile.nt;
    const theta=(angle%(2*Math.PI)+2*Math.PI)%(2*Math.PI),jf=theta/(2*Math.PI)*nt,j0=Math.floor(jf)%nt,j1=(j0+1)%nt,v=jf-Math.floor(jf);
    const rowAt=(row,k)=>row.ring[j0][k]*(1-v)+row.ring[j1][k]*v;
    // A missing upward ray at a known collar is an opening, not an elliptical
    // roof. Keep missing forefoot data separate: it cannot become a free hole.
    const openAt=(row,j)=>row.t<T.openingEnd&&Math.sin(2*Math.PI*j/nt)>0.0001&&
      row.boundary&&row.boundary[j]==='fallback-open-or-missing'?1:0;
    const openness=(openAt(row0,j0)*(1-v)+openAt(row0,j1)*v)*(1-u)+(openAt(row1,j0)*(1-v)+openAt(row1,j1)*v)*u;
    return {y:rowAt(row0,0)*(1-u)+rowAt(row1,0)*u,z:rowAt(row0,1)*(1-u)+rowAt(row1,1)*u,
      centerY:row0.centerY*(1-u)+row1.centerY*u,centerZ:row0.centerZ*(1-u)+row1.centerZ*u,open:openness>.5};
  }

  function lastSection(T, x) {
    const tn = x / (T.fromGlb ? T.Ls : T.S);
    let zMed, zLat;
    if (T.profile) {
      zMed = T.profile.med(x / T.Ls);
      zLat = -T.profile.lat(x / T.Ls);
    } else if (x <= T.x0) {
      zMed = T.med(tn);
      zLat = -T.lat(tn);
    } else {
      const u = Math.min(1, (x - T.x0) / (T.Ls - T.x0));
      const tm = Math.pow(Math.max(0, 1 - Math.pow(u, T.toe.pm)), 1 / T.toe.pm);
      const tl = Math.pow(Math.max(0, 1 - Math.pow(u, T.toe.pl)), 1 / T.toe.pl);
      zMed = T.zc + (T.m0 - T.zc) * tm;
      zLat = T.zc - (T.zc + T.l0) * tl;
    }
    const top = T.heightProfile ? T.heightProfile(x / T.Ls) : x <= T.xb ? T.topBody(tn) : T.topToe(x);
    const inferredBed = T.supportBedProfile && LF.supportBed ? LF.supportBed.heightAt(T.supportBedProfile,x) : null;
    const ybC = inferredBed == null ? T.heightProfile ? 0 : 24 * (1 - cap(x / 20)) : inferredBed;
    let ytC = T.heightProfile ? top : 30 + (top - 30) * cap(x / 16);
    ytC = Math.max(ybC + .5,ytC);
    if (!T.heightProfile) ytC = ybC + (ytC - ybC) * cap((T.Ls - x) / T.toe.front);
    const ys = ybC + 0.3 * (ytC - ybC);
    const radial=sampleRadialProfile(T,x);
    return { tn, x, zLat, zMed, c: radial?radial.centerZ:(zMed + zLat) / 2, a: (zMed - zLat) / 2, ytC, ybC, ys:radial?radial.centerY:ys };
  }

  const LAST_RING = { nTop: 2.8, nBot: 6 };

  function openingHeight(T,x) {
    const t=x/T.Ls,height=T.collar(t);
    // A rear GLB cross-section's tallest point can be an open collar rim,
    // rather than an enclosed roof. Never seal a virtual roof above that rim.
    return T.fromGlb && t<T.openingEnd ? Math.min(height,lastSection(T,x).ytC-.25) : height;
  }

  // 점 (x,y,z)가 신발 내부 공간 안에 있는가 — buildLast와 같은 단면식을 해석적으로 평가
  function insideLast(T, x, y, z) {
    if (x <= 0 || x >= T.Ls) return false;
    const sec = lastSection(T, x);
    if (sec.a <= 1e-6) return false;
    const u = (z - sec.c) / sec.a;
    const au = Math.abs(u);
    if (au >= 1) return false;
    if (y >= sec.ys) {
      const skew = T.fromGlb ? 0 : 0.03 + 0.07 * smoothstep(0.55, 0.8, sec.tn);
      const v = Math.pow(1 - Math.pow(au, LAST_RING.nTop), 1 / LAST_RING.nTop);
      return y <= sec.ys + (sec.ytC * (1 + skew * u) - sec.ys) * v;
    }
    const cupW = T.cup * (1 - smoothstep(0.2, 0.34, sec.tn));
    const yB = Math.min(sec.ybC + T.arch * gauss(sec.tn, 0.43, 0.085) * smoothstep(-0.3, 0.95, u) + cupW * Math.pow(au, 4), sec.ys - 1.5);
    const v = Math.pow(1 - Math.pow(au, LAST_RING.nBot), 1 / LAST_RING.nBot);
    return y >= sec.ys - (sec.ys - yB) * v;
  }

  // 발끝 점에서 길이 방향(+x)으로 앞코 안쪽 벽까지 거리. 음수 = 이미 벽을 넘어섬
  function lengthGap(T, x, y, z) {
    let lo, hi;
    if (insideLast(T, x, y, z)) { lo = x; hi = T.Ls; }
    else {
      lo = x - 20; hi = x;
      if (!insideLast(T, lo, y, z)) return NaN; // 이 높이·폭에서는 단면 자체가 맞지 않음(토박스 문제)
    }
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      if (insideLast(T, mid, y, z)) lo = mid; else hi = mid;
    }
    return lo - x;
  }

  function buildLast(Mdl, size, wIdx, lacing, nx, nt) {
    const T = lastShape(Mdl, size, wIdx, lacing);
    const G = newGrid(nx, nt);
    const ring = superRing(nt, LAST_RING.nTop, LAST_RING.nBot);
    const { pos } = G;
    G.Ls = T.Ls;
    G.S = T.S;
    G.openVal = new Float32Array(G.n);
    G.tn = new Float32Array(G.n);
    G.rowZL = new Float64Array(nx);
    G.rowZM = new Float64Array(nx);
    for (let i = 0; i < nx; i++) {
      const x = rowT(i, nx) * T.Ls;
      G.rowX[i] = x;
      const sec = lastSection(T, x);
      G.rowZL[i] = sec.zLat;
      G.rowZM[i] = sec.zMed;
      const skew = T.fromGlb ? 0 : 0.03 + 0.07 * smoothstep(0.55, 0.8, sec.tn);
      const arch = Mdl.arch * gauss(sec.tn, 0.43, 0.085);
      const cupW = Mdl.cup * (1 - smoothstep(0.2, 0.34, sec.tn));
      const collarY = openingHeight(T,x);
      for (let j = 0; j < nt; j++) {
        const u = ring.U[j];
        const v = ring.V[j];
        let z = sec.c + sec.a * u;
        let y;
        if (v >= 0) {
          const yT = sec.ytC * (1 + skew * u);
          y = sec.ys + (yT - sec.ys) * v;
        } else {
          const yB = Math.min(sec.ybC + arch * smoothstep(-0.3, 0.95, u) + cupW * Math.pow(Math.abs(u), 4), sec.ys - 1.5);
          y = sec.ys + (sec.ys - yB) * v;
        }
        const radial=sampleRadialProfile(T,x,2*Math.PI*j/nt);
        if(radial){y=radial.y;z=radial.z;}
        const k = i * nt + j;
        pos[3 * k] = x; pos[3 * k + 1] = y; pos[3 * k + 2] = z;
        G.openVal[k] = radial&&radial.open ? Math.max(1,y-collarY) : y-collarY;
        G.tn[k] = sec.tn;
      }
    }
    const s0 = lastSection(T, 0.0001);
    pos[3 * G.S0] = 0; pos[3 * G.S0 + 1] = (s0.ytC + s0.ybC) / 2; pos[3 * G.S0 + 2] = s0.c;
    G.openVal[G.S0] = -1;
    const end = lastSection(T, T.Ls);
    pos[3 * G.E0] = T.Ls; pos[3 * G.E0 + 1] = T.heightProfile ? (end.ytC + end.ybC) / 2 : 0.5; pos[3 * G.E0 + 2] = T.profile ? end.c : T.zc;
    G.openVal[G.E0] = -100;
    G.tn[G.E0] = T.fromGlb ? 1 : T.Ls / T.S;
    computeNormals(G);
    G.open = new Uint8Array(G.n);
    for (let k = 0; k < G.n; k++) G.open[k] = G.openVal[k] > 0 ? 1 : 0;
    classifyLast(G, Mdl);
    G.shape = T;
    return G;
  }

  function classifyLast(G, Mdl) {
    const { n, nrm, pos, tn } = G;
    G.mat = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const ny = nrm[3 * k + 1];
      const x = pos[3 * k];
      let m = M.UPPER;
      if (ny < -0.5) m = M.INSOLE;
      else if (Mdl.toecap && x > G.Ls - Mdl.toecapLen) m = M.TOECAP;
      else if (tn[k] < 0.3) m = M.COUNTER;
      else if (Mdl.lacing && tn[k] > 0.3 && tn[k] < 0.64 && ny > 0.45) m = M.TONGUE;
      G.mat[k] = m;
    }
  }

  // 아웃솔: 신발 내부 바닥 윤곽을 바깥으로 키워 두께를 준 로프트
  function buildSole(shoe, Mdl, nt) {
    const nx = shoe.nx;
    const G = newGrid(nx, nt);
    const ring = superRing(nt, 6, 6);
    const { pos } = G;
    const Ls = shoe.Ls;
    G.vv = new Float32Array(G.n);
    for (let i = 0; i < nx; i++) {
      const x0 = shoe.rowX[i];
      const x = -5 + (x0 * (Ls + 10)) / Ls;
      const tt = x0 / Ls;
      const thick = Mdl.sole.heel + (Mdl.sole.fore - Mdl.sole.heel) * smoothstep(0.25, 0.75, tt);
      const spring = 14 * Math.pow(smoothstep(0.72, 1, tt), 2);
      const zl = shoe.rowZL[i] - 5;
      const zm = shoe.rowZM[i] + 5;
      const c = (zl + zm) / 2;
      const a = (zm - zl) / 2;
      const yTop = -0.3;
      const yBot = Math.min(-thick + spring, yTop - 6);
      const ym = (yTop + yBot) / 2;
      const h = (yTop - yBot) / 2;
      for (let j = 0; j < nt; j++) {
        const k = i * nt + j;
        pos[3 * k] = x;
        pos[3 * k + 1] = ym + h * ring.V[j];
        pos[3 * k + 2] = c + a * ring.U[j];
        G.vv[k] = ring.V[j];
      }
    }
    const a0 = 0;
    pos[3 * G.S0] = -5; pos[3 * G.S0 + 1] = -0.3 - Mdl.sole.heel / 2; pos[3 * G.S0 + 2] = a0;
    pos[3 * G.E0] = Ls + 5; pos[3 * G.E0 + 1] = -3.3; pos[3 * G.E0 + 2] = shoe.shape.zc;
    G.vv[G.S0] = 0; G.vv[G.E0] = 0;
    computeNormals(G);
    return G;
  }

  // 단면(x 위치) 윤곽 보간: 행(row)이 x 고정이므로 인접 두 행을 선형 보간
  function sectionRows(G, x) {
    const { rowX, nx } = G;
    if (x <= rowX[0]) return { i0: 0, i1: 0, f: 0 };
    if (x >= rowX[nx - 1]) return { i0: nx - 1, i1: nx - 1, f: 0 };
    let lo = 0, hi = nx - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (rowX[mid] > x) hi = mid; else lo = mid;
    }
    return { i0: lo, i1: hi, f: (x - rowX[lo]) / (rowX[hi] - rowX[lo]) };
  }

  // A worn last no longer follows the analytic rest-shape functions. Use its actual,
  // index-compatible section polygon so toe clearance and the pressure surface agree.
  function insideGrid(G, x, y, z) {
    if (x <= 0 || x >= G.Ls) return false;
    const p = G.pos;
    // The fan caps taper all the way to S0/E0. Repeating the first/last ring
    // near a pole invents internal space that the actual triangle mesh lacks.
    if (x < G.rowX[0] || x > G.rowX[G.nx - 1]) {
      const heel = x < G.rowX[0], row = heel ? 0 : G.nx - 1, pole = heel ? G.S0 : G.E0;
      const px = p[pole * 3], py = p[pole * 3 + 1], pz = p[pole * 3 + 2];
      const f = (x - px) / (G.rowX[row] - px), inverse = 1 - f, base = row * G.nt * 3;
      let y0 = py * inverse + p[base + (G.nt - 1) * 3 + 1] * f;
      let z0 = pz * inverse + p[base + (G.nt - 1) * 3 + 2] * f, inside = false;
      for (let j = 0; j < G.nt; j++) {
        const y1 = py * inverse + p[base + j * 3 + 1] * f, z1 = pz * inverse + p[base + j * 3 + 2] * f;
        if ((y0 > y) !== (y1 > y) && z < (z1 - z0) * (y - y0) / (y1 - y0) + z0) inside = !inside;
        y0 = y1; z0 = z1;
      }
      return inside;
    }
    const rows = sectionRows(G, x), b0 = rows.i0 * G.nt * 3, b1 = rows.i1 * G.nt * 3, f = rows.f, inverse = 1 - f;
    let inside = false;
    const last = (G.nt - 1) * 3;
    let y0 = p[b0 + last + 1] * inverse + p[b1 + 1] * f;
    let z0 = p[b0 + last + 2] * inverse + p[b1 + 2] * f;
    for (let j = 0; j < G.nt; j++) {
      const offset = j * 3, y1 = p[b0 + offset + 1] * inverse + p[b1 + offset + 1] * f, z1 = p[b0 + offset + 2] * inverse + p[b1 + offset + 2] * f;
      if ((y0 > y) !== (y1 > y) && z < (z1 - z0) * (y - y0) / (y1 - y0) + z0) inside = !inside;
      // Each quad consists of (a,b,c) and (a,c,d). Its diagonal a->c
      // also crosses this plane; retain that vertex rather than replacing
      // the two triangle segments by one smoother, different surface.
      const next = ((j + 1) % G.nt) * 3;
      const yd = p[b0 + offset + 1] * inverse + p[b1 + next + 1] * f;
      const zd = p[b0 + offset + 2] * inverse + p[b1 + next + 2] * f;
      if ((y1 > y) !== (yd > y) && z < (zd - z1) * (y - y1) / (yd - y1) + z1) inside = !inside;
      y0 = yd; z0 = zd;
    }
    return inside;
  }

  function lengthGapGrid(G, x, y, z) {
    let lo, hi;
    if (insideGrid(G, x, y, z)) { lo = x; hi = G.Ls; }
    else {
      lo = x - 20; hi = x;
      if (!insideGrid(G, lo, y, z)) return NaN;
    }
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      if (insideGrid(G, mid, y, z)) lo = mid; else hi = mid;
    }
    return lo - x;
  }

  LF.geom = { Z, ZONE_KEYS, M, buildFoot, buildLast, buildSole, gridIndex, sectionRows, footShape, footSection, lastShape, lastSection, openingHeight, insideLast, lengthGap, computeNormals, insideGrid, lengthGapGrid };
})((window.LF = window.LF || {}));
