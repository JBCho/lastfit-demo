// LastFit — 공용 수치 유틸리티
(function (LF) {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const gauss = (x, mu, s) => {
    const q = (x - mu) / s;
    return Math.exp(-0.5 * q * q);
  };
  // 사분원 캡: u=0 → 0, u>=1 → 1. 뒤꿈치·발끝처럼 둥글게 닫히는 끝단에 사용
  const cap = (u) => (u >= 1 ? 1 : u <= 0 ? 0 : Math.sqrt(1 - (1 - u) * (1 - u)));

  // 단조 3차 보간(PCHIP). 제어점 사이에서 오버슈트 없이 매끄러운 윤곽 곡선을 만든다.
  function pchip(pts) {
    const n = pts.length;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const h = new Float64Array(n - 1);
    const d = new Float64Array(n - 1);
    const m = new Float64Array(n);
    for (let i = 0; i < n - 1; i++) {
      h[i] = xs[i + 1] - xs[i];
      d[i] = (ys[i + 1] - ys[i]) / h[i];
    }
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    return function (x) {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] > x) hi = mid;
        else lo = mid;
      }
      const t = (x - xs[lo]) / h[lo];
      const t2 = t * t;
      const t3 = t2 * t;
      return (
        (2 * t3 - 3 * t2 + 1) * ys[lo] +
        (t3 - 2 * t2 + t) * h[lo] * m[lo] +
        (-2 * t3 + 3 * t2) * ys[lo + 1] +
        (t3 - t2) * h[lo] * m[lo + 1]
      );
    };
  }

  // 상위 frac 비율 값의 평균(최소 minK개). 국소 압박점을 '최대값' 노이즈 없이 잡는다.
  function topMean(values, frac, minK) {
    if (!values.length) return 0;
    const s = Float32Array.from(values).sort();
    const k = Math.min(s.length, Math.max(minK, Math.round(s.length * frac)));
    let sum = 0;
    for (let i = s.length - k; i < s.length; i++) sum += s[i];
    return sum / k;
  }

  function lowMean(values, k) {
    if (!values.length) return 0;
    const s = Float32Array.from(values).sort();
    const kk = Math.min(s.length, k);
    let sum = 0;
    for (let i = 0; i < kk; i++) sum += s[i];
    return sum / kk;
  }

  function median(values) {
    if (!values.length) return 0;
    const s = Float32Array.from(values).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');

  LF.util = { clamp, lerp, smoothstep, gauss, cap, pchip, topMean, lowMean, median, fmt };
})((window.LF = window.LF || {}));
