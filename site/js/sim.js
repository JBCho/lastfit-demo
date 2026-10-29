// LastFit — 착화 시뮬레이션
// 1) 발 표면(양말 포함)과 신발 내부 표면 사이 부호 거리 d (+ 간섭 / - 여유)
// 2) 간섭 δ를 장력 막과 유한 연조직의 동일 압력 평형으로 풀고, 한계 초과 간섭은 별도 표시
// 3) 구역별 지표 → 개인 취향 기준 점수 → 사용 패턴(하중 상태) 가중 종합
(function (LF) {
  'use strict';
  const { clamp, gauss, smoothstep, topMean, lowMean, median } = LF.util;
  const { Z, ZONE_KEYS, M } = LF.geom;
  const D = LF.data;

  // ---------- 공간 해시: 최근접 정점 탐색 ----------
  function SpatialHash(pos, n, cell, margin) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    minX -= margin; minY -= margin; minZ -= margin;
    maxX += margin; maxY += margin; maxZ += margin;
    const gx = Math.ceil((maxX - minX) / cell) + 1;
    const gy = Math.ceil((maxY - minY) / cell) + 1;
    const gz = Math.ceil((maxZ - minZ) / cell) + 1;
    const nc = gx * gy * gz;
    const start = new Int32Array(nc + 1);
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const cx = Math.floor((pos[3 * i] - minX) / cell);
      const cy = Math.floor((pos[3 * i + 1] - minY) / cell);
      const cz = Math.floor((pos[3 * i + 2] - minZ) / cell);
      const c = cx + gx * (cy + gy * cz);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < nc; c++) start[c + 1] += start[c];
    const fill = start.slice(0, nc);
    const items = new Int32Array(n);
    for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i;
    Object.assign(this, { pos, cell, minX, minY, minZ, gx, gy, gz, start, items });
  }

  SpatialHash.prototype.nearest = function (x, y, z, maxR) {
    const { pos, cell, minX, minY, minZ, gx, gy, gz, start, items } = this;
    const cx = clamp(Math.floor((x - minX) / cell), 0, gx - 1);
    const cy = clamp(Math.floor((y - minY) / cell), 0, gy - 1);
    const cz = clamp(Math.floor((z - minZ) / cell), 0, gz - 1);
    let best = -1;
    let bestD2 = Infinity;
    for (let r = 0; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        const iz = cz + dz;
        if (iz < 0 || iz >= gz) continue;
        const az = Math.abs(dz);
        for (let dy = -r; dy <= r; dy++) {
          const iy = cy + dy;
          if (iy < 0 || iy >= gy) continue;
          const ay = Math.abs(dy);
          for (let dx = -r; dx <= r; dx++) {
            if (az !== r && ay !== r && Math.abs(dx) !== r) continue; // 껍질만 탐색
            const ix = cx + dx;
            if (ix < 0 || ix >= gx) continue;
            const c = ix + gx * (iy + gy * iz);
            for (let k = start[c], e = start[c + 1]; k < e; k++) {
              const i = items[k];
              const ddx = pos[3 * i] - x, ddy = pos[3 * i + 1] - y, ddz = pos[3 * i + 2] - z;
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 < bestD2) { bestD2 = d2; best = i; }
            }
          }
        }
      }
      if (best >= 0 && bestD2 <= r * cell * r * cell) break;
    }
    this.lastD2 = bestD2;
    return best;
  };

  // ---------- 신발 소재 파라미터 (정점 소재 구역 → 물성) ----------
  function materialTable(Mdl, lacing) {
    const up = D.MATERIALS[Mdl.upper];
    const t = [];
    t[M.UPPER] = up;
    t[M.TOECAP] = Mdl.toecap ? D.MATERIALS[Mdl.toecap] : up;
    t[M.COUNTER] = D.MATERIALS[Mdl.counter];
    // 설포(혀)·끈 영역: 끈 조임에 따라 강성이 달라진다
    // Laces/foam make the tongue softer to press, but do not give a leather
    // tongue a knitted upper's tensile allowance. Inward draw is handled apart.
    t[M.TONGUE] = { name: '설포·신발끈', k1: 3 + 9 * lacing, lim: up.lim, k2: up.k2, mold: 0, relax: up.relax, soften: up.soften, crease: up.crease, membrane: { ...up.membrane, youngMPa: up.membrane.youngMPa * (0.25 + 0.5 * lacing) } };
    t[M.INSOLE] = D.MATERIALS[Mdl.insole];
    return t;
  }

  const COUNTER_HOLD = { counter_soft: 1.1, counter_medium: 1.0, counter_firm: 0.9 };

  // One shared frame for pressure queries, the visible foot and cross-sections.
  // A support-bed pose is a rigid transform, never a scale of measurements.
  function transformFootPoint(ctx, x, y, z) {
    const seat=ctx.seat||{x:0,y:0,z:0},pitch=seat.pitchRadians||0,c=Math.cos(pitch),s=Math.sin(pitch);
    const px=x+ctx.sock+.5+ctx.slide+seat.x,py=y+ctx.sock;
    const xp=c*px-s*py,yaw=seat.yawRadians||0,cy=Math.cos(yaw),sy=Math.sin(yaw);
    // Heel-origin XY pitch, then world-Y yaw. A negative yaw places the
    // forefoot farther medial (+z); rotations never rescale foot measurements.
    return {x:cy*xp+sy*z,y:s*px+c*py+seat.y,z:-sy*xp+cy*z+seat.z};
  }
  function inverseFootPoint(ctx, x, y, z) {
    const seat=ctx.seat||{x:0,y:0,z:0},pitch=seat.pitchRadians||0,yaw=seat.yawRadians||0;
    const cy=Math.cos(yaw),sy=Math.sin(yaw),c=Math.cos(pitch),s=Math.sin(pitch),dy=y-seat.y,dz=z-seat.z;
    const xp=cy*x-sy*dz;
    return {x:c*xp+s*dy-(ctx.sock+.5+ctx.slide+seat.x),y:-s*xp+c*dy-ctx.sock,z:sy*x+cy*dz};
  }
  function poseFootPoint(ctx,x,y,z) {
    const local=LF.plantarContact?LF.plantarContact.posePoint(ctx,x,y,z):{x,y,z};
    return transformFootPoint(ctx,local.x,local.y,local.z);
  }
  // Match section centrelines using a rigid pose, rather than shrinking a
  // measured foot to the bounding-box axis of a photographed/display GLB.
  function centrelineYaw(foot, shoe, ctx, seat, referencePitch) {
    const F=foot.shape,T=shoe.shape,xOff=ctx.sock+.5+ctx.slide+seat.x;
    const cp=Math.cos(referencePitch),sp=Math.sin(referencePitch),points=[];
    for(const [t,w]of [[.12,3],[.2,3],[.42,1],[.6,2],[.7,2]]) {
      const f=LF.geom.footSection(F,F.L*t),x=cp*(F.L*t+xOff)-sp*(f.ys+ctx.sock);
      const target=LF.geom.lastSection(T,clamp(x,.01,T.Ls-.01)).c;
      points.push({x,z:f.c,target,w});
    }
    const weight=points.reduce((sum,p)=>sum+p.w,0);
    const mx=points.reduce((sum,p)=>sum+p.w*p.x,0)/weight,md=points.reduce((sum,p)=>sum+p.w*(p.target-p.z),0)/weight;
    let numerator=0,denominator=0;
    for(const p of points){numerator+=p.w*(p.x-mx)*(p.target-p.z-md);denominator+=p.w*(p.x-mx)**2;}
    let yaw=clamp(-Math.atan(denominator>1e-9?numerator/denominator:0),-Math.PI/36,Math.PI/36);
    const shiftAt=angle=>{
      const cy=Math.cos(angle),sy=Math.sin(angle);let max=0;
      for(let i=0;i<foot.n;i++) {
        const x=cp*(foot.pos[i*3]+foot.nrm[i*3]*ctx.sock+xOff)-sp*(foot.pos[i*3+1]+foot.nrm[i*3+1]*ctx.sock+ctx.sock);
        const z=foot.pos[i*3+2]+foot.nrm[i*3+2]*ctx.sock;
        max=Math.max(max,Math.abs((cy-1)*x+sy*z));
      }
      return max;
    };
    // Heel x translation remains zero. An orientation estimate cannot move a
    // corner of the measured foot longitudinally by more than 3mm.
    if(shiftAt(yaw)>3) {
      let lo=0,hi=1;
      for(let j=0;j<16;j++){const mid=(lo+hi)/2;if(shiftAt(yaw*mid)>3)hi=mid;else lo=mid;}
      yaw*=lo;
    }
    const evaluate=angle=>{
      const cy=Math.cos(angle),sy=Math.sin(angle);
      const rows=points.map(p=>({w:p.w,z:-sy*p.x+cy*p.z,target:LF.geom.lastSection(T,clamp(cy*p.x+sy*p.z,.01,T.Ls-.01)).c}));
      const z=clamp(rows.reduce((sum,p)=>sum+p.w*(p.target-p.z),0)/weight,-8,8);
      const rms=Math.sqrt(rows.reduce((sum,p)=>sum+p.w*(p.z+z-p.target)**2,0)/weight);
      return {yaw,z,rms};
    };
    const baseline=evaluate(0),candidate=evaluate(yaw);
    const useYaw=baseline.rms-candidate.rms>.15&&candidate.rms<baseline.rms*.92;
    seat.yawRadians=useYaw?candidate.yaw:0;seat.z=useYaw?candidate.z:baseline.z;
    seat.centrelineTranslationRmsMm=baseline.rms;seat.centrelineRmsMm=useYaw?candidate.rms:baseline.rms;
    seat.maxYawLongitudinalShiftMm=useYaw?shiftAt(candidate.yaw):0;
    seat.yawSource=useYaw?'bounded-heel-forefoot-centreline-fit':'translation-sufficient';
  }
  function footPositions(foot, ctx) {
    const out = new Float32Array(foot.n * 3), seat = ctx.seat || { x: 0, y: 0, z: 0 };
    for (let i = 0; i < foot.n; i++) {
      const plantar = foot.zone[i] === Z.SOLE || foot.zone[i] === Z.ARCH;
      let p=poseFootPoint(ctx,foot.pos[3*i]+foot.nrm[3*i]*ctx.sock,foot.pos[3*i+1]+foot.nrm[3*i+1]*ctx.sock-(plantar?0:ctx.packout),foot.pos[3*i+2]+foot.nrm[3*i+2]*ctx.sock);
      if(LF.plantarContact && ctx.plantarPose) p=LF.plantarContact.constrainPoint(ctx,p);
      out[3*i]=p.x;out[3*i+1]=p.y;out[3*i+2]=p.z;
    }
    return out;
  }

  // Dorsal layer depths are inferred regional assumptions, not MRI measurements.
  const TISSUE_THICKNESS_MM = [5, 5, 7, 5, 7, 10, 5];
  function tissueLimits(foot, i) {
    let thickness = TISSUE_THICKNESS_MM[foot.zone[i]] || 5;
    if (foot.shape) {
      const sec = LF.geom.footSection(foot.shape, foot.pos[i * 3]);
      const radius = Math.max(0.1, Math.min(sec.a, 0.5 * (sec.ytC - sec.ybC)));
      thickness = Math.min(thickness, radius);
    }
    return { thickness, shearKPa: 50, soft: thickness * 0.3, hard: thickness * 0.45 };
  }
  function contactMembrane(material, b, geometry, vertices, bary, offset, panel) {
    const m = material.membrane;
    const out = { ...m, youngMPa: m.youngMPa * (1 - (material.soften || 0) * b), kappa1: 0, kappa2: 0, span1Mm: 0, span2Mm: 0 };
    if (panel) {
      // Panel annotations change the membrane constitutive law. They do not alter the measured cavity,
      // tissue shear modulus or the allowable outward-displacement budget.
      const stiffnessScale = Number.isFinite(panel.stiffnessScale) && panel.stiffnessScale > 0 ? panel.stiffnessScale : 1;
      out.youngMPa *= stiffnessScale;
      out.panelKind = panel.kind;
      out.panelStiffnessScale = stiffnessScale;
    }
    for (let j = 0; j < 3; j++) {
      const q = vertices[offset + j], w = bary[offset + j];
      if (q < 0 || !w) continue;
      for (const key of ['kappa1', 'kappa2', 'span1Mm', 'span2Mm']) out[key] += geometry[key][q] * w;
    }
    return out;
  }
  // Compatibility entry point. Pressure no longer uses the old foot kPa/mm spring.
  function solveSeries(delta, kf, material, b, softLimit, hardLimit, result) {
    const membrane = { ...material.membrane, youngMPa: material.membrane.youngMPa * (1 - (material.soften || 0) * b), kappa1: 0.025, kappa2: 0.04, span1Mm: 35, span2Mm: 25 };
    const tissue = { shearKPa: 50, thicknessMm: Math.max(0.1, hardLimit / 0.45) };
    const cap = LF.contactDrape.materialStretchLimit(material, b);
    return LF.pressureModel.solve(delta, membrane, tissue, cap, hardLimit, result);
  }

  // The common-pressure solver splits interference into shoe stretch and soft-tissue
  // compression. Only the render surface receives that already-solved compression.
  // Queries, measured foot geometry and fit scores continue to use the original fpos.
  function compressedFootPositions(foot, shoe, sim, ctx) {
    const source = sim.fpos || footPositions(foot, ctx), out = source.slice();
    if (!ctx.snugWear) return out;
    for (let i = 0; i < foot.n; i++) {
      const q = sim.near[i];
      if (sim.ex[i] || q < 0 || shoe.open[q] || sim.P[i] <= 0 || foot.zone[i] === Z.SOLE || foot.zone[i] === Z.ARCH) continue;
      const kf = foot.kf[i];
      if (!(kf > 0)) continue;
      const amount = sim.tissueCompression ? sim.tissueCompression[i] : sim.P[i] / kf;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      for (let a = 0; a < 3; a++) out[i * 3 + a] -= (sim.contactNormal ? sim.contactNormal[i * 3 + a] : shoe.nrm[q * 3 + a]) * amount;
    }
    return out;
  }

  // Anchor the heel longitudinally and seat the sole on the insole. A small sideways
  // translation balances the heel/forefoot centreline; it cannot evade a narrow shoe.
  function seatFoot(foot, shoe, ctx) {
    const T = shoe.shape, F = foot.shape, xOff = ctx.sock + 0.5;
    let zSum = 0, zWeight = 0;
    for (const [t, weight] of [[0.12, 3], [0.2, 3], [0.42, 1], [0.6, 1], [0.7, 1]]) {
      const f = LF.geom.footSection(F, F.L * t), s = LF.geom.lastSection(T, clamp(F.L * t + xOff, 0.01, T.Ls - 0.01));
      zSum += (s.c - f.c) * weight; zWeight += weight;
    }
    const seat = { x: 0, y: 0, z: clamp(zSum / zWeight, -8, 8) };
    const usable=T.glbCalibration && T.glbCalibration.usableGeometry;
    if(usable && Number.isFinite(usable.heelXmm)) {
      seat.x=Math.max(0,usable.heelXmm-.5);
      seat.heelSource=usable.source;
    }
    const profile=T.supportBedProfile;
    if(T.fromGlb&&T.profile)centrelineYaw(foot,shoe,ctx,seat,profile&&profile.seatingPlane?profile.seatingPlane.pitchRadians:0);
    if(LF.plantarContact && LF.plantarContact.solve(foot,shoe,ctx,seat)) return seat;
    if(profile && profile.seatingPlane && LF.supportBed) {
      seat.source=profile.source || profile.seatingPlane.source || 'file-geometry-inferred';
      const plantar=[];
      for(let i=0;i<foot.n;i++) {
        if(![Z.SOLE,Z.ARCH].includes(foot.zone[i]) || foot.nrm[i*3+1]>-.55 || foot.tv[i]<.025 || foot.tv[i]>.985) continue;
        const px=foot.pos[i*3]+foot.nrm[i*3]*ctx.sock+xOff+ctx.slide+seat.x;
        const py=foot.pos[i*3+1]+foot.nrm[i*3+1]*ctx.sock+ctx.sock;
        plantar.push({px,py,z:foot.pos[i*3+2]+foot.nrm[i*3+2]*ctx.sock});
      }
      // Find the rigid pose with the least average sole gap while remaining above
      // all verified support samples. A curved toe bed must influence placement;
      // extending the heel/ball plane below it makes a fixed sole cut the toes.
      let best=null;
      const reference=profile.seatingPlane.pitchRadians;
      const cy=Math.cos(seat.yawRadians||0),sy=Math.sin(seat.yawRadians||0);
      for(let pitch=Math.max(-.12,reference-.08);pitch<=Math.min(.12,reference+.08)+.00001;pitch+=.002) {
        const c=Math.cos(pitch),s=Math.sin(pitch),gaps=[];
        for(const {px,py,z} of plantar) {
          const xp=c*px-s*py,x=cy*xp+sy*z,zWorld=-sy*xp+cy*z+seat.z;
          const h=LF.supportBed.heightAt(profile,x,true,zWorld);
          if(h!=null) gaps.push(h-(s*px+c*py));
        }
        if(!gaps.length) continue;
        const y=Math.max(...gaps)+.8;
        const cost=y-gaps.reduce((sum,gap)=>sum+gap,0)/gaps.length;
        if(!best || cost<best.cost) best={pitch,y,cost};
      }
      seat.pitchRadians=best?best.pitch:reference;
      seat.y=best?best.y:profile.seatingPlane.offsetMm;
      seat.supportSurface=profile.surfaceType || 'longitudinal-profile';
      seat.plantarSampleCount=plantar.length;
      ctx.seat=seat;
      return seat;
    }
    const supported = [];
    // The rigid seating estimate uses sparse heel and metatarsal sole contacts.
    // Arch cavities are intentionally excluded; a high arch is not lowered to fill them.
    for (let i = 0; i < foot.n; i += 11) {
      if (foot.zone[i] !== Z.SOLE || foot.nrm[3 * i + 1] > -0.8 || Math.abs(foot.zn[i]) > 0.6 || foot.tv[i] < 0.07 || foot.tv[i] > 0.79) continue;
      const x = foot.pos[3 * i] + foot.nrm[3 * i] * ctx.sock + xOff;
      if (x <= 0 || x >= T.Ls) continue;
      const sec = LF.geom.lastSection(T, x), z = foot.pos[3 * i + 2] + foot.nrm[3 * i + 2] * ctx.sock + seat.z;
      const u = (z - sec.c) / Math.max(0.5, sec.a);
      if (Math.abs(u) >= 0.95) continue;
      const cup = T.cup * (1 - smoothstep(0.2, 0.34, sec.tn));
      const yb = Math.min(sec.ybC + T.arch * gauss(sec.tn, 0.43, 0.085) * smoothstep(-0.3, 0.95, u) + cup * Math.pow(Math.abs(u), 4), sec.ys - 1.5);
      const floor = sec.ys - (sec.ys - yb) * Math.pow(1 - Math.pow(Math.abs(u), 6), 1 / 6);
      const py = foot.pos[3 * i + 1] + foot.nrm[3 * i + 1] * ctx.sock + ctx.sock;
      supported.push(floor - py);
    }
    if (supported.length) {
      supported.sort((a, b) => a - b);
      seat.y = clamp(supported[Math.floor((supported.length - 1) * 0.9)], -2, 4);
    }
    ctx.seat = seat;
    return seat;
  }

  // Wearing preserves the original cavity. Lacing changes panel stiffness, but
  // must not pull a roomy shoe inward to erase real clearance around the foot.
  function closureCapacity(material, mp, ctx, model) {
    return 0;
  }

  function prepareWorn(foot, shoe, ctx) {
    seatFoot(foot, shoe, ctx);
    const fpos = footPositions(foot, ctx);
    const worn = { ...shoe, pos: shoe.pos.slice(), nrm: shoe.nrm.slice(), contactCollider: null, restShape: shoe.shape, snugWear: true };
    worn.hash = new SpatialHash(worn.pos, worn.n, 5, 32);
    // Retain zero closure arrays for callers that consume the old display contract.
    return { shoe: worn, fpos, contactClosure: { vectors: new Float32Array(shoe.n * 3), closeMm: new Float32Array(shoe.n), maxMm: 0, source: 'original-cavity-expansion-only' } };
  }

  // ---------- 단일 상태 시뮬레이션 ----------
  // ctx: { sock, slide, packout, crease, b(길들이기 0..1), sens: Float32Array(구역별 민감도 배율) }
  function simulate(foot, shoe, mats, ctx) {
    const n = foot.n;
    const d = new Float32Array(n); // 원시 부호 거리(+간섭)
    const eff = new Float32Array(n); // 길들이기·이완 반영 후 간섭
    const P = new Float32Array(n); // 접촉 압력 kPa
    const pressureValid = new Uint8Array(n).fill(1), pressureStatus = new Uint8Array(n);
    const tissueThickness = new Float32Array(n), areaMm2 = LF.pressureModel.vertexAreas(foot);
    const contactGeometry = LF.pressureModel.surfaceGeometry(shoe), membranes = new Array(n);
    const model = ctx.model || shoe.model, dior = LF.diorFit;
    const hasDiorPhysics = Boolean(dior && typeof dior.enabled === 'function' && dior.enabled(model) && typeof dior.panelAt === 'function');
    const contactPanels = hasDiorPhysics ? new Array(n) : null;
    const outwardLimits = hasDiorPhysics ? new Float32Array(n) : null;
    const Pr = new Float32Array(n); // 신발이 전혀 늘어나지 않는다고 가정한 압력
    const defl = new Float32Array(n); // 신발 소재 변형량 mm
    const tissueCompression = new Float32Array(n), tissueSoftLimit = new Float32Array(n), tissueHardLimit = new Float32Array(n), unresolvedInterference = new Float32Array(n), stretchDemand = new Float32Array(n);
    const ex = new Uint8Array(n); // 1 = 신발 밖(평가 제외)
    const near = new Int32Array(n);
    const contactNormal = new Float32Array(n * 3), contactPoint = new Float32Array(n * 3);
    const contactVertices = new Int32Array(n * 3).fill(-1), contactBary = new Float32Array(n * 3);
    const contactStats = { interferenceCount: 0, maxInterferenceMm: 0, maxPressureKPa: 0, maxShoeStretchMm: 0,
      maxTissueCompressionMm: 0, beyondElasticLimitCount: 0, maxBeyondElasticLimitMm: 0, rigidUnfeasibleCount: 0,
      validContactAreaMm2: 0, unresolvedAreaMm2: 0, evaluatedAreaMm2: 0, validNormalForceN: 0, meanPressureKPa: 0, invalidPressureCount: 0,
      topologyLimitedCount: 0, compressionTopologyResidualCount: 0, materialLimitedCount:0, maxUnresolvedInterferenceMm:0, maxStretchDemandMm:0 };
    const lgap = new Float32Array(n).fill(NaN); // 앞코 길이 여유(발끝 정점만)
    const fpos = footPositions(foot, ctx), sp = shoe.pos, sn = shoe.nrm, fn = foot.nrm;
    const { crease, b } = ctx;
    const hash = shoe.hash;
    let collider = shoe.contactCollider;
    if (!collider && shoe.nx && shoe.nt && LF.contactDrape && LF.contactDrape.createCollider) {
      collider = shoe.contactCollider = LF.contactDrape.createCollider(shoe.pos, LF.geom.gridIndex(shoe), shoe.nrm);
    }
    const contact = {};
    const solved = {};
    const resolve = (i) => {
      const mp = mats[shoe.mat[near[i]]];
      let panel = null;
      if (hasDiorPhysics) {
        panel = contactPanels[i];
        if (!panel) panel = contactPanels[i] = dior.panelAt(shoe, contactPoint[i * 3], contactPoint[i * 3 + 1], contactPoint[i * 3 + 2]);
      }
      if (!membranes[i]) {
        membranes[i] = contactMembrane(mp, b, contactGeometry, contactVertices, contactBary, i * 3, panel);
      }
      const tissue = { shearKPa: 50, thicknessMm: tissueThickness[i] };
      const cap = panel && Number.isFinite(panel.maxOutwardMm) && panel.maxOutwardMm >= 0 ? panel.maxOutwardMm : LF.contactDrape.materialStretchLimit(mp, b);
      if (outwardLimits) outwardLimits[i] = cap;
      LF.pressureModel.solve(eff[i], membranes[i], tissue, cap, tissueHardLimit[i], solved);
      // P holds bounded capacity traction internally; only pressureValid points
      // are a solved equilibrium and may be shown as estimated contact pressure.
      P[i] = solved.pressure; pressureValid[i] = +solved.valid; pressureStatus[i] = solved.valid ? 0 : 1;
      defl[i] = solved.shoe; tissueCompression[i] = solved.tissue;
      unresolvedInterference[i]=solved.unresolved;stretchDemand[i]=solved.shoeDemand;
      Pr[i] = d[i] <= tissueHardLimit[i] ? LF.pressureModel.tissuePressure(Math.max(0,d[i]), tissue) : Infinity;
    };
    for (let i = 0; i < n; i++) {
      const zone = foot.zone[i];
      const px = fpos[3 * i], py = fpos[3 * i + 1], pz = fpos[3 * i + 2];
      // Above the collar the foot/ankle exits through an opening. A closest
      // closed side-wall triangle is not a roof and must not squeeze this skin.
      const opening=shoe.shape && shoe.shape.collar;
      if(opening && px>0 && px<shoe.Ls && py>(LF.geom.openingHeight ? LF.geom.openingHeight(shoe.shape,px) : opening(px/shoe.Ls))) {
        near[i]=-1;ex[i]=1;pressureValid[i]=0;pressureStatus[i]=2;d[i]=-99;eff[i]=-99;continue;
      }
      let q, dd;
      if (collider) {
        const hit = collider.query(px, py, pz, contact);
        const vertices = hit && hit.triangle, bary = hit && hit.barycentric;
        if (!hit || !vertices || !bary) { near[i] = -1; ex[i] = 1; pressureValid[i]=0;pressureStatus[i]=2;d[i] = -99; eff[i] = -99; continue; }
        let dominant = 0;
        for (let a = 1; a < 3; a++) if (bary[a] > bary[dominant]) dominant = a;
        q = vertices[dominant];
        const point = hit.point, dx = px - point.x, dy = py - point.y, dz = pz - point.z;
        const distance = Math.hypot(dx, dy, dz), inside = LF.geom.insideGrid(shoe, px, py, pz);
        dd = inside ? -distance : distance;
        // Closest-point separation is the actual contact normal, including
        // heel/toe edges where averaged sampled-vertex normals are misleading.
        const sign = inside ? -1 : 1, inverse = distance > 1e-7 ? sign / distance : 0;
        contactPoint[i * 3] = point.x; contactPoint[i * 3 + 1] = point.y; contactPoint[i * 3 + 2] = point.z;
        contactNormal[i * 3] = inverse ? dx * inverse : hit.normal.x;
        contactNormal[i * 3 + 1] = inverse ? dy * inverse : hit.normal.y;
        contactNormal[i * 3 + 2] = inverse ? dz * inverse : hit.normal.z;
        for (let a = 0; a < 3; a++) {
          contactVertices[i * 3 + a] = vertices[a]; contactBary[i * 3 + a] = bary[a];
        }
      } else {
        q = hash.nearest(px, py, pz, 6);
        if (q >= 0) {
          dd = (px - sp[3 * q]) * sn[3 * q] + (py - sp[3 * q + 1]) * sn[3 * q + 1] + (pz - sp[3 * q + 2]) * sn[3 * q + 2];
          contactVertices[i * 3] = q; contactBary[i * 3] = 1;
          for (let a = 0; a < 3; a++) { contactPoint[i * 3 + a] = sp[q * 3 + a]; contactNormal[i * 3 + a] = sn[q * 3 + a]; }
        }
      }
      near[i] = q;
      if (q < 0 || shoe.open[q]) { ex[i] = 1; pressureValid[i]=0;pressureStatus[i]=2;d[i] = -99; eff[i] = -99; continue; }
      // 앞을 향한 발끝 중간 높이 정점에서만 길이 방향 여유를 잰다(옆면 접촉은 토박스 압력으로 평가)
      if (zone === Z.TOE_FRONT && Math.abs(foot.vv[i]) < 0.4 && fn[3 * i] > 0.75) lgap[i] = shoe.snugWear ? LF.geom.lengthGapGrid(shoe, px, py, pz) : LF.geom.lengthGap(shoe.shape, px, py, pz);
      const mp = mats[shoe.mat[q]];
      // 앞꿈치를 굽힐 때 갑피가 발등 쪽으로 접혀 들어오는 효과
      if (crease > 0 && mp.crease) {
        dd += crease * mp.crease * gauss(foot.tv[i], 0.745, 0.035) * smoothstep(0.3, 0.8, fn[3 * i + 1]);
      }
      d[i] = dd;
      let del = dd;
      if (mp.relax) del -= mp.relax * b;
      if (del > 0 && mp.mold) del -= Math.min(del, mp.mold * b);
      eff[i] = del;
      // External load is absent; plantar contact is outside this upper model.
      if (zone === Z.SOLE || zone === Z.ARCH) { pressureValid[i]=0;pressureStatus[i]=3;continue; }
      if (del > 0) {
        const limits = tissueLimits(foot, i); tissueThickness[i]=limits.thickness; tissueSoftLimit[i] = limits.soft; tissueHardLimit[i] = limits.hard;
        resolve(i);
      }
    }
    // A sampled contact direction can vary quickly near a sharp shoe boundary.
    // Enforce an orientation barrier on the tissue's *physical compliance*, then
    // re-solve force balance with that smaller layer. No render-only clipping occurs.
    if (ctx.snugWear && foot.nx && foot.nt) {
      const indices = LF.geom.gridIndex(foot), limited = new Uint8Array(n);
      const r = { fpos, P, tissueCompression, near, ex, contactNormal };
      for (let pass = 0; pass < 33; pass++) {
        const rendered = compressedFootPositions(foot, shoe, r, ctx), marked = new Uint8Array(n);
        let invalid = 0;
        for (let t = 0; t < indices.length; t += 3) {
          const a = indices[t] * 3, c = indices[t + 1] * 3, e = indices[t + 2] * 3;
          const bx = fpos[c]-fpos[a], by = fpos[c+1]-fpos[a+1], bz = fpos[c+2]-fpos[a+2];
          const dx = fpos[e]-fpos[a], dy = fpos[e+1]-fpos[a+1], dz = fpos[e+2]-fpos[a+2];
          const nx = by*dz-bz*dy, ny = bz*dx-bx*dz, nz = bx*dy-by*dx, area2 = nx*nx+ny*ny+nz*nz;
          if (area2 < 1e-10) continue;
          const rb = [rendered[c]-rendered[a],rendered[c+1]-rendered[a+1],rendered[c+2]-rendered[a+2]];
          const rd = [rendered[e]-rendered[a],rendered[e+1]-rendered[a+1],rendered[e+2]-rendered[a+2]];
          const alignment = nx*(rb[1]*rd[2]-rb[2]*rd[1]) + ny*(rb[2]*rd[0]-rb[0]*rd[2]) + nz*(rb[0]*rd[1]-rb[1]*rd[0]);
          if (alignment >= area2 * 0.05) continue;
          invalid++;
          for (let j = 0; j < 3; j++) { const vertex = indices[t+j]; if (tissueCompression[vertex] > 0 && foot.zone[vertex] !== Z.SOLE && foot.zone[vertex] !== Z.ARCH) marked[vertex] = 1; }
        }
        contactStats.compressionTopologyResidualCount = invalid;
        if (!invalid || pass === 32) break;
        for (let i = 0; i < n; i++) if (marked[i]) {
          limited[i] = 1; tissueHardLimit[i] *= 0.5; tissueSoftLimit[i] = Math.min(tissueSoftLimit[i], tissueHardLimit[i]); resolve(i);
        }
      }
      for (let i = 0; i < n; i++) contactStats.topologyLimitedCount += limited[i];
    }
    for (let i = 0; i < n; i++) if (!ex[i] && pressureStatus[i] !== 3) {
      contactStats.evaluatedAreaMm2 += areaMm2[i];
      if (!pressureValid[i]) { contactStats.invalidPressureCount++; contactStats.unresolvedAreaMm2 += areaMm2[i]; }
      if (!(eff[i] > 0)) continue;
      if (pressureValid[i]) { contactStats.validContactAreaMm2 += areaMm2[i]; contactStats.validNormalForceN += P[i] * areaMm2[i] * 0.001; }
      const mp = mats[shoe.mat[near[i]]], lim = mp.lim * (1 + 1.5 * mp.soften * b);
      contactStats.interferenceCount++; contactStats.maxInterferenceMm = Math.max(contactStats.maxInterferenceMm, d[i]);
      if (pressureValid[i]) contactStats.maxPressureKPa = Math.max(contactStats.maxPressureKPa, P[i]); contactStats.maxShoeStretchMm = Math.max(contactStats.maxShoeStretchMm, defl[i]);
      contactStats.maxTissueCompressionMm = Math.max(contactStats.maxTissueCompressionMm, tissueCompression[i]);
      contactStats.maxUnresolvedInterferenceMm=Math.max(contactStats.maxUnresolvedInterferenceMm,unresolvedInterference[i]);
      contactStats.maxStretchDemandMm=Math.max(contactStats.maxStretchDemandMm,stretchDemand[i]);
      if(unresolvedInterference[i]>.001)contactStats.materialLimitedCount++;
      if (!Number.isFinite(Pr[i])) contactStats.rigidUnfeasibleCount++;
      if (defl[i] > lim) { contactStats.beyondElasticLimitCount++; contactStats.maxBeyondElasticLimitMm = Math.max(contactStats.maxBeyondElasticLimitMm, defl[i]-lim); }
    }
    contactStats.meanPressureKPa = contactStats.validContactAreaMm2 > 0 ? contactStats.validNormalForceN * 1000 / contactStats.validContactAreaMm2 : 0;
    contactStats.unresolvedAreaFraction = contactStats.evaluatedAreaMm2 > 0 ? contactStats.unresolvedAreaMm2 / contactStats.evaluatedAreaMm2 : 0;
    const fitPhysics = hasDiorPhysics ? { profile: model.fitPhysicsProfile, source: 'annotated-panel-membrane-static',
      pressureEquilibrium: 'membrane-and-neo-hookean-tissue-recomputed' } : null;
    return { d, eff, P, pressureValid, pressureStatus, areaMm2, membranes, tissueThickness, pressureModel: LF.pressureModel.name, Pr, defl, tissueCompression, tissueSoftLimit, tissueHardLimit, unresolvedInterference, stretchDemand, ex, near, lgap, fpos, contactNormal, contactPoint, contactVertices, contactBary, contactStats,
      contactPanels, outwardLimits, fitPhysics,
      contactMethod: collider ? 'actual-triangle-distance-and-section-parity' : 'vertex-normal-fallback',
      metrics: zoneMetrics(foot, shoe, mats, { eff, P, pressureValid, areaMm2, Pr, defl, ex, near, lgap }, ctx.sens) };
  }

  // 구역별 지표
  function zoneMetrics(foot, shoe, mats, r, sens) {
    const acc = ZONE_KEYS.map(() => ({ pp: [], ph: [], pr: [], gap: [], sd: [], alt: [], df: [], idx: [], area: 0, invalidArea: 0, contactArea: 0 }));
    for (let i = 0; i < foot.n; i++) {
      if (r.ex[i]) continue;
      const z = foot.zone[i];
      if (z === Z.SOLE || z === Z.ARCH || z === Z.NONE) continue;
      const a = acc[z];
      let s = sens.zone[z];
      if (z === Z.BALL) {
        const u = foot.zn[i];
        if (u > 0.3) s *= sens.ballMed;
        else if (u < -0.3) s *= sens.ballLat;
      }
      const area = r.areaMm2 ? r.areaMm2[i] : 1, valid = !r.pressureValid || !!r.pressureValid[i];
      a.area += area; if (!valid) a.invalidArea += area;
      if (r.eff[i] > 0) a.contactArea += area;
      a.pp.push(valid ? r.P[i] * s : 0);
      a.ph.push(valid ? r.P[i] : 0);
      a.pr.push(valid ? r.Pr[i] : 0);
      a.gap.push(Math.max(0, -r.eff[i]));
      if (z !== Z.TOE_FRONT) a.sd.push(-r.eff[i]);
      else {
        a.alt.push(-r.eff[i]);
        if (!Number.isNaN(r.lgap[i])) a.sd.push(r.lgap[i]);
      }
      a.df.push(r.defl[i]);
      a.idx.push(i);
    }
    const out = {};
    ZONE_KEYS.forEach((key, z) => {
      const a = acc[z];
      if (!a.pp.length) { out[key] = null; return; }
      // 최대 압력 지점과 그곳의 소재
      let im = 0;
      for (let k = 1; k < a.pp.length; k++) if (a.pp[k] > a.pp[im]) im = k;
      const vi = a.idx[im];
      const sq = r.near[vi];
      out[key] = {
        n: a.pp.length,
        peakP: topMean(a.pp, 0.025, 4),
        peakPhys: topMean(a.ph, 0.025, 4),
        peakRigid: topMean(a.pr, 0.025, 4),
        peakDefl: topMean(a.df, 0.025, 4),
        medGap: median(a.gap),
        minGap: a.sd.length ? lowMean(a.sd, 4) : lowMean(a.alt, 4),
        contact: a.area > 0 ? a.contactArea / a.area : 0,
        pressureComplete: a.invalidArea === 0,
        unresolvedAreaFraction: a.area > 0 ? a.invalidArea / a.area : 0,
        worst: vi,
        worstU: foot.zn[vi],
        worstMat: sq >= 0 ? mats[shoe.mat[sq]].name : '',
        worstMatId: sq >= 0 ? shoe.mat[sq] : -1,
      };
    });
    return out;
  }

  // ---------- 개인 취향 → 평가 기준 ----------
  // style: -1(딱 맞게) … +1(여유 있게)
  function tolerances(pref) {
    const s = pref.style;
    const usage = D.USAGE[pref.usage];
    const toeMid = pref.toeRoom != null ? pref.toeRoom : (usage.toe[0] + usage.toe[1]) / 2 + 1.5 * s;
    const tol = {
      Pok: 15 - 5 * s,
      Ppain: 38 - 6 * s,
      toe: [toeMid - 2, toeMid + 2.5],
      loose: { toeBox: 9 + 3 * s, ball: 3 + 2 * s, instep: 3.5 + 2 * s, arch: 9, heel: 1.6 + 1 * s },
      Pzone: {},
    };
    if (pref.sens.heel) tol.loose.heel -= 0.6;
    ZONE_KEYS.forEach((k) => { tol.Pzone[k] = k === 'arch' ? tol.Pok + 3 : tol.Pok; });
    // 레퍼런스 신발(잘 맞았던 신발)로 개인 허용치 보정
    if (pref.refMetrics) {
      const rm = pref.refMetrics;
      ZONE_KEYS.forEach((k) => {
        const m = rm[k];
        if (!m) return;
        if (k === 'toeFront') {
          const g = m.minGap;
          tol.toe = [g - 2.5, g + 3];
          return;
        }
        tol.Pzone[k] = clamp(Math.max(tol.Pzone[k], m.peakP * 1.08), tol.Pzone[k], tol.Ppain - 6);
        tol.loose[k] = Math.max(tol.loose[k], m.medGap + 0.8);
      });
    }
    return tol;
  }

  function sensitivity(pref) {
    const zone = new Float32Array(7).fill(1);
    if (pref.sens.instep) zone[Z.INSTEP] = 1.4;
    if (pref.sens.heel) zone[Z.HEEL] = 1.4;
    return { zone, ballMed: pref.sens.bunion ? 1.5 : 1, ballLat: pref.sens.tailor ? 1.5 : 1 };
  }

  const ZONE_W = { toeFront: 0.22, toeBox: 0.14, ball: 0.22, instep: 0.14, arch: 0.1, heel: 0.18 };
  const LOOSE_K = { toeBox: 2, ball: 7, instep: 4, arch: 2, heel: 16 };

  // 압력 → 점수: 허용치의 절반까지 만점, 허용치 92점, 통증 기준 25점, 그 이상 급감
  function pScore(P, ok, pain) {
    if (P <= 0.5 * ok) return 100;
    if (P <= ok) return 100 - (8 * (P - 0.5 * ok)) / (0.5 * ok);
    if (P <= pain) return 92 - (67 * (P - ok)) / (pain - ok);
    return Math.max(0, 25 - (25 * (P - pain)) / (0.4 * pain));
  }

  // 헐거움 → 점수: 허용 여유의 60%부터 서서히 감점
  function lScore(g, lim, k) {
    if (g <= 0.6 * lim) return 100;
    if (g <= lim) return 100 - (6 * (g - 0.6 * lim)) / (0.4 * lim);
    return 94 - (g - lim) * k;
  }

  // slide: 그 상태에서 발이 앞으로 밀린 양(mm). 동작 중 뒤꿈치 뒤쪽 틈은 일부 자연스러운 것으로 본다
  function scoreZones(metrics, stateKey, tol, slide = 0) {
    const zs = {};
    for (const k of ZONE_KEYS) {
      const m = metrics[k];
      if (!m) { zs[k] = { score: 100, status: 'na' }; continue; }
      // Historical scores are hidden in the demo. A missing equilibrium must
      // still never be interpreted as comfortable by these downstream callers.
      if (m.pressureComplete === false) { zs[k] = { score: 0, status: 'unresolved' }; continue; }
      if (k === 'toeFront') {
        const g = m.minGap;
        let s, status;
        if (stateKey === 'stand') {
          const [lo, hi] = tol.toe;
          const mid = (lo + hi) / 2;
          if (g < lo) { s = 96 - (lo - g) * 14; status = g < lo - 2 ? 'short' : 'bitShort'; }
          else if (g > hi) { s = 96 - (g - hi) * 7; status = g > hi + 3 ? 'long' : 'bitLong'; }
          else { s = 100 - (4 * Math.abs(g - mid)) / ((hi - lo) / 2); status = 'ok'; }
        } else {
          // 동작 중에는 발가락이 앞벽에 닿지 않을 최소 여유만 본다
          const need = 2.5;
          if (g >= need) { s = 100; status = 'ok'; }
          else { s = 100 - (need - g) * 18; status = g < 0 ? 'short' : 'bitShort'; }
        }
        zs[k] = { score: clamp(s, 0, 100), status };
        continue;
      }
      const sP = pScore(m.peakP, tol.Pzone[k], tol.Ppain);
      const lim = tol.loose[k] + (k === 'heel' ? 0.3 * slide : 0);
      const sL = lScore(m.medGap, lim, LOOSE_K[k]);
      let status = 'ok';
      if (sP < sL) {
        if (m.peakP > tol.Ppain) status = 'pain';
        else if (m.peakP > (tol.Pzone[k] + tol.Ppain) / 2) status = 'tight';
        else if (m.peakP > tol.Pzone[k]) status = 'snug';
      } else if (m.medGap > lim) status = 'loose';
      zs[k] = { score: clamp(Math.min(sP, sL), 0, 100), status };
    }
    let wsum = 0, min = 100;
    for (const k of ZONE_KEYS) {
      wsum += ZONE_W[k] * zs[k].score;
      min = Math.min(min, zs[k].score);
    }
    return { zones: zs, score: 0.65 * wsum + 0.35 * min };
  }

  // 반품 위험 추정(데모 모델): 점수가 낮을수록 로지스틱하게 증가
  const returnRisk = (score) => 2 + 46 / (1 + Math.exp((score - 58) / 7.5));
  const verdict = (score) => (score >= 80 ? 'good' : score >= 65 ? 'warn' : 'bad');

  // 상태별 시뮬레이션 컨텍스트
  function context(Mdl, stateKey, pref) {
    const st = D.STATES[stateKey];
    const hold = (1.25 - 0.6 * pref.lacing) * (COUNTER_HOLD[Mdl.counter] || 1) * (Mdl.lacing ? 1 : 1.3);
    const ins = D.MATERIALS[Mdl.insole];
    const b = 1 - Math.exp(-pref.days / 7);
    return {
      sock: D.SOCKS[pref.sock].t,
      slide: st.slide * hold,
      packout: (ins.packout || 0) * b,
      crease: st.crease,
      b,
      snugWear: pref.snugWear === true,
      model: Mdl,
      fitPhysicsProfile: Mdl.fitPhysicsProfile || null,
      lacing: pref.lacing,
      seat: { x: 0, y: 0, z: 0 },
      sens: sensitivity(pref),
    };
  }

  LF.sim = { SpatialHash, materialTable, simulate, scoreZones, tolerances, returnRisk, verdict, context, footPositions, transformFootPoint, inverseFootPoint, poseFootPoint, compressedFootPositions, tissueLimits, solveSeries, seatFoot, closureCapacity, prepareWorn, ZONE_W };
})((window.LF = window.LF || {}));
