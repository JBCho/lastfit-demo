// LastFit — 평가 엔진: 형상 캐시, 사용 패턴 가중 평가, 사이즈 매트릭스, 인사이트 문장 생성
(function (LF) {
  'use strict';
  const D = LF.data;
  const G = LF.geom;
  const S = LF.sim;
  const { fmt } = LF.util;

  const RES = { footNx: 104, footNt: 60, shoeNx: 116, shoeNt: 60 };

  function Engine() {
    this.footCache = new Map();
    this.shoeCache = new Map();
    this.F = null;
  }

  Engine.prototype.setFoot = function (F) {
    this.F = { ...F };
    this.footCache.clear();
  };

  Engine.prototype.foot = function (stateKey, swell) {
    const key = stateKey + (swell ? ':s' : '');
    let g = this.footCache.get(key);
    if (!g) {
      const st = { ...D.STATES[stateKey] };
      if (swell) { st.len *= 1.005; st.wid *= 1.02; st.girth *= 1.025; }
      g = G.buildFoot(this.F, st, RES.footNx, RES.footNt);
      this.footCache.set(key, g);
    }
    return g;
  };

  Engine.prototype.shoe = function (Mdl, size, w, lacing) {
    // 카탈로그의 소재도 수정 가능하다. 같은 id라도 치수·윤곽·소재가 바뀌면 재계산한다.
    const key = `${Mdl.id}|${JSON.stringify(Mdl)}|${size}|${w}|${lacing}`;
    let g = this.shoeCache.get(key);
    if (g) {
      this.shoeCache.delete(key);
      this.shoeCache.set(key, g);
      return g;
    }
    g = G.buildLast(Mdl, size, w, lacing, RES.shoeNx, RES.shoeNt);
    g.hash = new S.SpatialHash(g.pos, g.n, 5, 32);
    g.mats = S.materialTable(Mdl, lacing);
    g.model = Mdl;
    this.shoeCache.set(key, g);
    if (this.shoeCache.size > 80) this.shoeCache.delete(this.shoeCache.keys().next().value);
    return g;
  };

  // 한 신발·사이즈를 사용 패턴의 모든 하중 상태에서 평가
  Engine.prototype.evaluate = function (modelId, size, w, pref, displayState, options) {
    const Mdl = D.shoeById(modelId);
    const shoe = this.shoe(Mdl, size, w, pref.lacing);
    const tol = S.tolerances(pref);
    const usage = D.USAGE[pref.usage];
    // A fixed-state viewer can skip hidden walking/running evaluations. The
    // selected state's geometry and spring solve are identical to the full run.
    const displayOnly = Boolean(options && options.displayOnly === true);
    const targetState = displayOnly ? displayState || 'stand' : displayState;
    const weights = displayOnly ? { [targetState]: 1 } : usage.w;
    const states = {};
    let score = 0;
    let display = null;
    const run = (sk) => {
      const foot = this.foot(sk, pref.swell);
      const ctx = S.context(Mdl, sk, pref);
      const worn = ctx.snugWear ? S.prepareWorn(foot, shoe, ctx) : { shoe, contactClosure: null };
      const sim = S.simulate(foot, worn.shoe, shoe.mats, ctx);
      const sc = S.scoreZones(sim.metrics, sk, tol, ctx.slide);
      return { foot, ctx, sim, sc, worn };
    };
    for (const [sk, wt] of Object.entries(weights)) {
      const r = run(sk);
      states[sk] = { metrics: r.sim.metrics, zones: r.sc.zones, score: r.sc.score, slide: r.ctx.slide, seat: r.ctx.seat, closeMm: r.worn.contactClosure ? r.worn.contactClosure.maxMm : 0, w: wt };
      score += wt * r.sc.score;
      if (sk === targetState) display = { state: sk, foot: r.foot, shoe, wornLast: r.worn.shoe, contactClosure: r.worn.contactClosure, ctx: r.ctx, sim: r.sim, zones: r.sc.zones, score: r.sc.score };
    }
    if (targetState && !display) {
      const r = run(targetState);
      display = { state: targetState, foot: r.foot, shoe, wornLast: r.worn.shoe, contactClosure: r.worn.contactClosure, ctx: r.ctx, sim: r.sim, zones: r.sc.zones, score: r.sc.score, extra: true };
    }
    if (display && display.ctx.snugWear) display.compressedFpos = S.compressedFootPositions(display.foot, display.wornLast, display.sim, display.ctx);
    return { modelId, size, w, score, risk: S.returnRisk(score), verdict: S.verdict(score), states, display, tol, model: Mdl };
  };

  // 잘 맞았던 신발(레퍼런스)의 서기 상태 지표 → 개인 허용치 보정에 사용
  Engine.prototype.referenceMetrics = function (ref, pref) {
    const p = { ...pref, refMetrics: null, days: 30 };
    const r = this.evaluate(ref.modelId, ref.size, ref.w, p, 'stand');
    return r.display.sim.metrics;
  };

  // 표시용: 신발 정점별 변형량(가장 가까운 발 정점의 소재 변형량을 옮겨 담음)
  Engine.prototype.shoeDeflection = function (display) {
    const { foot, sim, ctx } = display;
    const shoe = display.wornLast || display.shoe;
    const pressureFpos = sim.fpos || S.footPositions(foot, ctx);
    const fpos = ctx.snugWear ? display.compressedFpos || S.compressedFootPositions(foot, shoe, sim, ctx) : pressureFpos;
    const h = new S.SpatialHash(pressureFpos, foot.n, 6, 10);
    const out = new Float32Array(shoe.n);
    for (let k = 0; k < shoe.n; k++) {
      if (shoe.open[k]) continue;
      const q = h.nearest(shoe.pos[3 * k], shoe.pos[3 * k + 1], shoe.pos[3 * k + 2], 1);
      if (q >= 0 && h.lastD2 < 64 && !sim.ex[q]) out[k] = sim.defl[q];
    }
    return { fpos, pressureFpos, defl: out };
  };

  Engine.prototype.glbDeformation = function (display) {
    if (!LF.glbFit) throw new Error('GLB 착화 모듈이 로드되지 않았습니다.');
    return LF.glbFit.createDeformationField(display, this.shoeDeflection(display).defl);
  };

  // 발 길이 기준 관행 사이즈(5mm 단위 올림)
  Engine.lengthSize = (L) => Math.ceil((L - 0.01) / 5) * 5;

  // ---------- 인사이트 문장 ----------
  const ZLABEL = { toeFront: '앞코 여유', toeBox: '토박스', ball: '볼 너비', instep: '발등', arch: '아치', heel: '뒤꿈치' };
  const kpa = (v) => (v > 80 ? '80+' : fmt(v, 0));
  const mm = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? fmt(v, 0) : fmt(v, 1));

  function where(zone, u) {
    if (zone === 'ball') return u > 0.3 ? '볼 안쪽(엄지 관절)' : u < -0.3 ? '볼 바깥쪽(새끼 관절)' : '볼 윗면';
    if (zone === 'toeBox') return u > 0.3 ? '엄지발가락 쪽 토박스' : u < -0.3 ? '새끼발가락 쪽 토박스' : '발가락 윗면';
    if (zone === 'heel') return '뒤꿈치';
    if (zone === 'instep') return '발등';
    if (zone === 'arch') return '아치(발 안쪽 오목한 곳)';
    return ZLABEL[zone];
  }

  // 실제 후기나 언어 모델의 답변이 아니라, 용도별 점수와 개인 선호로 만든 예상 문장.
  // 사용 빈도로 가중한 가장 취약한 구역을 먼저 말하며, 소재를 바꿔도 원인 설명이 바뀐다.
  Engine.prototype.oneLine = function (res, pref) {
    const states = Object.entries(res.states);
    const losses = G.ZONE_KEYS.map((zone) => {
      let loss = 0, strongest = null;
      for (const [key, state] of states) {
        const z = state.zones[zone], m = state.metrics[zone];
        if (!m || z.status === 'na') continue;
        const impact = (100 - z.score) * state.w;
        loss += impact;
        if (!strongest || impact > strongest.impact) strongest = { key, status: z.status, m, impact };
      }
      return { zone, loss, strongest };
    }).sort((a, b) => b.loss - a.loss);
    const worst = losses[0];
    const style = pref.style >= 0.4 ? '여유 있게 신는 제 취향에는' : pref.style <= -0.4 ? '발을 잡아주는 핏을 좋아하는 저에게는' : '제 발에는';
    const upper = D.MATERIALS[res.model.upper];
    const flexible = upper.k1 <= 11;
    const material = flexible ? `${upper.name} 소재가 유연하게 감싸고` : `${upper.name} 소재가 탄탄하게 잡아주고`;
    const basis = `${D.USAGE[pref.usage].label}의 동작 비중, 부위별 여유·압력, 소재 변형과 핏 선호를 반영한 데모 예상입니다.`;
    if (!worst || !worst.strongest || worst.loss < 8) {
      return { text: `${style} ${material}, ${D.USAGE[pref.usage].label}용으로 편하게 신을 수 있을 것 같아요.`, basis };
    }
    const { key, status, m } = worst.strongest;
    const state = { stand: '서 있을 때', walk: '걸을 때', run: '뛸 때', down: '내리막에서' }[key];
    const zone = worst.zone;
    let concern;
    if (zone === 'toeFront') {
      concern = status === 'long' || status === 'bitLong'
        ? '앞코가 길어 발이 안에서 움직일 것 같아요'
        : status === 'short' || m.minGap < 0
          ? '발끝 여유가 부족해 발가락이 닿을 것 같아요'
          : '앞코 여유가 조금 타이트하게 느껴질 것 같아요';
    } else if (status === 'loose') {
      concern = zone === 'heel' ? '뒤꿈치가 들뜰 것 같아요' : `${ZLABEL[zone]} 쪽이 헐렁하게 느껴질 것 같아요`;
    } else {
      const area = where(zone, m.worstU).replace('아치(발 안쪽 오목한 곳)', '발 안쪽 아치');
      concern = `${area} 부위가 ${status === 'pain' || status === 'tight' ? '강하게' : '살짝'} 눌릴 것 같아요`;
    }
    const matName = m.worstMatId === G.M.TONGUE ? upper.name : m.worstMat || upper.name;
    let texture;
    if (status === 'loose' || zone === 'toeFront') texture = `${upper.name}의 착화감과 별개로`;
    else if (m.peakDefl > 0.7 && m.peakRigid > m.peakPhys * 1.25) texture = `${matName} 소재가 늘어나 압박을 줄여도`;
    else texture = `${matName}의 지지감이 느껴지지만`;
    return { text: `${style} ${texture}, ${state} ${concern}.`, basis, zone, state: key, status };
  };

  Engine.prototype.insights = function (res, pref) {
    const out = [];
    const tol = res.tol;
    const st = res.states;
    const keys = Object.keys(st);
    const Mdl = res.model;

    // 1) 길이: 서기 기준 앞코 여유 + 동작 중 앞쏠림
    const stand = st.stand && st.stand.metrics.toeFront;
    if (stand) {
      const g = stand.minGap;
      let worstK = null, worstG = Infinity;
      keys.forEach((k) => {
        if (k === 'stand') return;
        const m = st[k].metrics.toeFront;
        if (m && m.minGap < worstG) { worstG = m.minGap; worstK = k; }
      });
      let level = 'ok';
      let text;
      if (g < 0) { level = 'bad'; text = `서 있기만 해도 발끝이 앞코 안쪽 벽에 닿습니다. 이 사이즈는 작습니다.`; }
      else if (g < tol.toe[0]) { level = g < 3 ? 'bad' : 'warn'; text = `앞코 여유 ${fmt(g)}mm, 선호(${mm(tol.toe[0])}–${mm(tol.toe[1])}mm)보다 짧습니다.`; }
      else if (g > tol.toe[1]) { level = 'warn'; text = `앞코 여유 ${fmt(g)}mm로 깁니다. 발이 앞으로 쏠리고 뒤꿈치가 들뜰 수 있어요.`; }
      else text = `앞코 여유 ${fmt(g)}mm, 선호 범위 안입니다.`;
      if (worstK && g >= 0) {
        const s = st[worstK];
        text += worstG >= 0
          ? ` ${D.STATES[worstK].label} 때 발이 ${fmt(s.slide)}mm 밀려 ${fmt(worstG)}mm까지 줄어듭니다.`
          : ` ${D.STATES[worstK].label} 때 발이 ${fmt(s.slide)}mm 밀려 발끝이 앞코 안쪽 벽에 닿습니다.`;
        if (worstG < 2.5) level = 'bad';
      }
      out.push({ level, sev: level === 'bad' ? 3 : level === 'warn' ? 2 : 0, text });
    }

    // 2) 가장 큰 압박 구역: 소재 변형이 압력을 얼마나 흡수하는지
    let top = null;
    keys.forEach((k) => {
      for (const z of ['toeBox', 'ball', 'instep', 'heel', 'arch']) {
        const m = st[k].metrics[z];
        if (m && (!top || m.peakP > top.m.peakP)) top = { k, z, m };
      }
    });
    if (top && top.m.peakPhys > 4) {
      const m = top.m;
      const lim = tol.Pzone[top.z];
      const level = m.peakP > tol.Ppain ? 'bad' : m.peakP > lim ? 'warn' : 'ok';
      const rigid = m.worstMatId === G.M.TOECAP && Mdl.toecap === 'toecap_rigid';
      const stiff = rigid || m.worstMatId === G.M.COUNTER;
      let text = `${where(top.z, m.worstU)} 최대 ${kpa(m.peakPhys)}kPa (${D.STATES[top.k].label}).`;
      if (m.peakRigid > m.peakPhys * 1.3 && m.peakRigid > 10 && m.peakPhys < 60 && !stiff) {
        text += ` ${m.worstMat} 소재가 ${fmt(m.peakDefl)}mm 늘어나, 늘어나지 않는 형상이었다면 ${kpa(m.peakRigid)}kPa였을 압력을 ${kpa(m.peakPhys)}kPa로 낮춥니다.`;
      } else if (stiff) {
        text += ` ${m.worstMat} 부위라 거의 늘어나지 않습니다(${fmt(m.peakDefl)}mm).`;
      } else if (m.peakPhys >= 60) {
        text += ` ${m.worstMat} 소재가 늘어날 수 있는 한계를 넘어 압력이 급격히 커졌습니다.`;
      }
      out.push({ level, sev: level === 'bad' ? 3 : level === 'warn' ? 2 : 0, text, zone: top.z, state: top.k });

      // 3) 길들이기 전망: 가죽·합성 갑피에 압박이 있을 때
      const upper = D.MATERIALS[Mdl.upper];
      if (level !== 'ok' && upper.mold > 0 && pref.days < 14 && !stiff) {
        const later = this.evaluate(res.modelId, res.size, res.w, { ...pref, days: 21 }, top.k);
        const lm = later.display.sim.metrics[top.z];
        if (lm && lm.peakPhys < m.peakPhys - 2 && lm.peakPhys <= 60) {
          out.push({
            level: 'info', sev: 1,
            text: `${upper.name} 소재는 길들여집니다. 3주 착화 후 ${ZLABEL[top.z]} 압력 ${kpa(m.peakPhys)}→${kpa(lm.peakPhys)}kPa, 종합 ${Math.round(res.score)}→${Math.round(later.score)}점 예상.` +
              (later.score >= 75 ? ' 초기 조임만으로 반품할 필요는 없을 수 있어요.' : ' 다만 길들여도 다른 문제(길이·폭)는 남습니다.'),
          });
        } else if (m.peakP > tol.Ppain) {
          out.push({ level: 'warn', sev: 1, text: `${upper.name}이 길들여져도(3주) 해결되기 어려운 압박입니다. 더 큰 사이즈나 넓은 폭을 고르세요.` });
        }
      }
    }

    // 4) 헐거움(뒤꿈치 들뜸, 볼 헐렁)
    keys.forEach((k) => {
      const zs = st[k].zones;
      ['heel', 'ball'].forEach((z) => {
        if (zs[z].status !== 'loose' || zs[z].score >= 85 || out.some((o) => o.loose === z)) return;
        const m = st[k].metrics[z];
        const text = z === 'heel'
          ? `뒤꿈치 간격 ${fmt(m.medGap)}mm (${D.STATES[k].label}). 걸을 때 뒤꿈치가 들뜰 수 있어요. 끈을 조이거나 한 치수 작게.`
          : `볼 쪽 여유 ${fmt(m.medGap)}mm로 헐렁합니다. 좁은 폭(D)이 더 안정적일 수 있어요.`;
        out.push({ level: 'warn', sev: 2, text, loose: z });
      });
    });

    // 5) 발등·아치 힌트
    const ins = st.stand && st.stand.metrics.instep;
    if (ins && ins.peakP > tol.Pzone.instep && Mdl.lacing && pref.lacing > 0.25) {
      out.push({ level: 'info', sev: 1, text: `발등 압력 ${kpa(ins.peakPhys)}kPa. 끈 조임을 낮추면 줄어듭니다(하단 '끈 조임').` });
    }
    const ar = st.stand && st.stand.metrics.arch;
    if (ar && ar.peakP > tol.Pzone.arch) {
      out.push({ level: 'warn', sev: 2, text: `인솔 아치 서포트가 아치보다 높아 ${kpa(ar.peakPhys)}kPa로 받칩니다. 아치가 낮은 발이라면 평평한 인솔을 권장해요.` });
    }

    return out.sort((a, b) => b.sev - a.sev).slice(0, 4);
  };

  // ---------- 백그라운드 작업 러너 ----------
  // 14ms씩 끊어 계산하고 MessageChannel로 양보한다(타이머와 달리 백그라운드 탭에서도 1초 단위로 묶이지 않음)
  function Jobs() {
    this.token = 0;
    this.queue = [];
    this.channel = new MessageChannel();
    this.channel.port1.onmessage = () => { const f = this.queue.shift(); if (f) f(); };
  }
  Jobs.prototype.yieldThen = function (f) {
    this.queue.push(f);
    this.channel.port2.postMessage(0);
  };
  Jobs.prototype.run = function (gen, onDone) {
    const my = ++this.token;
    const step = () => {
      if (my !== this.token) return;
      const t0 = performance.now();
      while (performance.now() - t0 < 14) {
        const r = gen.next();
        if (r.done) { if (onDone) onDone(); return; }
        if (my !== this.token) return;
      }
      this.yieldThen(step);
    };
    this.yieldThen(step);
  };
  Jobs.prototype.cancel = function () { this.token++; };

  LF.Engine = Engine;
  LF.Jobs = Jobs;
  LF.ZLABEL = ZLABEL;
  LF.engineRes = RES;
})((window.LF = window.LF || {}));
