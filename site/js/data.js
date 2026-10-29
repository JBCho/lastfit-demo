// LastFit — 데모 데이터: 발 스캔 샘플, 신발(디지털 라스트) 카탈로그, 소재 물성, 하중 상태, 사용 패턴
// 치수·조직 물성은 데모 가정이며 일부 소재 영률은 문헌 대표값이다.
// 실제 서비스에서는 제품 내부 CAD·스캔·개인 및 제품의 물성 시험값으로 보정한다.
(function (LF) {
  'use strict';

  // 3D 발 스캔 샘플 (체중 부하 상태에서 측정했다고 가정, 단위 mm)
  const FOOT_PRESETS = [
    {
      id: 'std',
      label: '표준 발',
      code: 'A',
      foot: { length: 262, ballWidth: 94, heelWidth: 62, instepHeight: 54, archHeight: 0.5, toeHeight: 18, toeShape: 'egyptian', bunion: 0 },
    },
    {
      id: 'wide',
      label: '발볼 넓은 평발',
      code: 'B',
      foot: { length: 263, ballWidth: 109, heelWidth: 68, instepHeight: 69, archHeight: 0.15, toeHeight: 25, toeShape: 'square', bunion: 0.3 },
    },
    {
      id: 'narrow',
      label: '좁은 발 · 높은 아치',
      code: 'C',
      foot: { length: 243, ballWidth: 91, heelWidth: 60, instepHeight: 66, archHeight: 0.85, toeHeight: 22, toeShape: 'greek', bunion: 0 },
    },
    {
      id: 'bunion',
      label: '무지외반',
      code: 'D',
      foot: { length: 248, ballWidth: 99, heelWidth: 62, instepHeight: 61, archHeight: 0.4, toeHeight: 23, toeShape: 'egyptian', bunion: 0.9 },
    },
  ];

  const TOE_SHAPES = {
    egyptian: { label: '이집트형', hint: '엄지가 가장 김' },
    greek: { label: '그리스형', hint: '둘째 발가락이 가장 김' },
    square: { label: '스퀘어형', hint: '앞 3개 발가락 길이 비슷' },
  };

  // 소재 물성. k1: 초기 강성(kPa/mm), lim: 탄성 신장 한계(mm), k2: 한계 이후 강성,
  // mold: 길들이기 시 영구 성형량(mm), relax: 착화 후 전체 이완(mm), soften: 길들이기 강성 감소율,
  // crease: 앞꿈치 굴곡 시 발등 쪽으로 접혀 들어오는 깊이(mm)
  const MATERIALS = {
    knit: { name: '엔지니어드 니트', k1: 6, lim: 5, k2: 70, mold: 0, relax: 0.4, soften: 0, crease: 0.8 },
    mesh: { name: '더블 메시', k1: 11, lim: 3, k2: 90, mold: 0, relax: 0.3, soften: 0, crease: 1.2 },
    synthetic: { name: '합성 가죽', k1: 22, lim: 1.6, k2: 130, mold: 0.5, relax: 0, soften: 0.15, crease: 2.0 },
    leather: { name: '천연 소가죽', k1: 28, lim: 1.2, k2: 140, mold: 2.2, relax: 0, soften: 0.35, crease: 2.6 },
    toecap_soft: { name: '소프트 토퍼프', k1: 45, lim: 0.8, k2: 200, mold: 0.4, relax: 0, soften: 0.1, crease: 0 },
    toecap_rigid: { name: '러버 토캡', k1: 160, lim: 0.3, k2: 400, mold: 0, relax: 0, soften: 0, crease: 0 },
    counter_soft: { name: '소프트 힐카운터', k1: 25, lim: 2, k2: 120, mold: 0, relax: 0.2, soften: 0, crease: 0 },
    counter_medium: { name: '힐카운터', k1: 55, lim: 1, k2: 200, mold: 0.2, relax: 0, soften: 0, crease: 0 },
    counter_firm: { name: '단단한 힐카운터', k1: 110, lim: 0.5, k2: 300, mold: 0.3, relax: 0, soften: 0, crease: 0 },
    insole_eva: { name: 'EVA 인솔', k1: 14, lim: 3, k2: 90, mold: 0, relax: 0, soften: 0, crease: 0, packout: 0.6 },
    insole_memory: { name: '메모리폼 인솔', k1: 7, lim: 5, k2: 80, mold: 0, relax: 0, soften: 0, crease: 0, packout: 1.2 },
    insole_leather: { name: '가죽 인솔', k1: 30, lim: 1.2, k2: 150, mold: 1.0, relax: 0, soften: 0.2, crease: 0, packout: 0.3 },
  };

  // Membrane properties: E in MPa, thickness in mm. Leather E=11.2 is a
  // representative stitched assembly from Materials 15(15):5107, not Dior data.
  // Other fabric/reinforcement values are explicit engineering assumptions.
  // The old k1/k2 values remain only for closure and collision penalties.
  const MEMBRANE = {
    leather: [11.2, 2, 0.4], synthetic: [8, 1.6, 0.35],
    mesh: [1, 1.2, 0.3], knit: [0.16, 1.2, 0.3],
    toecap_soft: [20, 1.5, 0.35], toecap_rigid: [50, 2, 0.35],
    counter_soft: [8, 1.8, 0.35], counter_medium: [20, 2, 0.35], counter_firm: [40, 2, 0.35],
    insole_eva: [1, 3, 0.3], insole_memory: [0.5, 5, 0.3], insole_leather: [11.2, 2, 0.4],
  };
  Object.entries(MEMBRANE).forEach(([id, p]) => {
    MATERIALS[id].membrane = { youngMPa: p[0], thicknessMm: p[1], poisson: p[2],
      source: id === 'leather' ? 'generic-stitched-leather-reference' : 'engineering-assumption' };
  });

  // 신발 카탈로그 = 디지털 라스트(내부 형상) + 소재 구성. 치수는 260 사이즈 내부 기준(mm)
  // allow: 내부 길이 - 사이즈, ball/heel: 내부 볼·뒤꿈치 폭, instep: 발등 내부 높이, toeBoxH: 토박스 내부 높이
  // toe: start(테이퍼 시작, 발길이 비율), pm/pl(안쪽/바깥쪽 윤곽 지수: 클수록 뭉툭), tipS(앞코 꼭지 위치 0=바깥 1=안쪽), front(앞코 높이 곡률 mm)
  const SHOES = [
    {
      id: 'aero',
      name: 'Aero Knit Runner',
      cat: '러닝화',
      shape: '라운드 토',
      allow: 13, ball: 102, heel: 67.5, instep: 68, toeBoxH: 31,
      toe: { start: 0.74, pm: 5.0, pl: 2.3, tipS: 0.62, front: 22 },
      arch: 7, cup: 3,
      collar: { back: 62, low: 50, throat: 0.32 },
      upper: 'knit', toecap: null, counter: 'counter_soft', insole: 'insole_eva', lacing: true,
      toecapLen: 0, widths: [0, 1],
      sole: { heel: 34, fore: 24, color: '#d8dcd6', bottom: '#6d7470' },
    },
    {
      id: 'derby',
      name: 'Linden Derby',
      cat: '정장 구두',
      shape: '아몬드 토',
      allow: 18, ball: 100, heel: 66, instep: 64, toeBoxH: 27,
      toe: { start: 0.74, pm: 3.0, pl: 2.0, tipS: 0.6, front: 24 },
      arch: 5, cup: 2,
      collar: { back: 58, low: 46, throat: 0.4 },
      upper: 'leather', toecap: 'toecap_soft', counter: 'counter_firm', insole: 'insole_leather', lacing: true,
      toecapLen: 22, widths: [0, 1],
      sole: { heel: 28, fore: 12, color: '#5a3b2a', bottom: '#2e1f17' },
    },
    {
      id: 'trail',
      name: 'Ridge Trail Mid',
      cat: '하이킹화',
      shape: '블런트 라운드',
      allow: 15, ball: 105, heel: 68.5, instep: 72, toeBoxH: 34,
      toe: { start: 0.74, pm: 5.5, pl: 2.6, tipS: 0.64, front: 20 },
      arch: 8, cup: 4,
      collar: { back: 96, low: 88, throat: 0.3 },
      upper: 'synthetic', toecap: 'toecap_rigid', counter: 'counter_firm', insole: 'insole_eva', lacing: true,
      toecapLen: 45, widths: [0, 1, 2],
      sole: { heel: 36, fore: 26, color: '#3c4240', bottom: '#1d2120' },
    },
    {
      id: 'flow',
      name: 'Flow Wide Daily',
      cat: '데일리',
      shape: '해부학적 와이드 토',
      allow: 13, ball: 107, heel: 66.5, instep: 67, toeBoxH: 32,
      toe: { start: 0.76, pm: 7.0, pl: 3.0, tipS: 0.86, front: 18 },
      arch: 3, cup: 2,
      collar: { back: 60, low: 49, throat: 0.33 },
      upper: 'mesh', toecap: null, counter: 'counter_soft', insole: 'insole_memory', lacing: true,
      toecapLen: 0, widths: [0, 1],
      sole: { heel: 26, fore: 26, color: '#ece6da', bottom: '#8a8377' },
    },
    {
      id: 'court',
      name: 'Court Classic 76',
      cat: '스니커즈',
      shape: '라운드 토',
      allow: 12, ball: 101, heel: 67.5, instep: 66, toeBoxH: 29,
      toe: { start: 0.74, pm: 4.5, pl: 2.3, tipS: 0.62, front: 22 },
      arch: 4, cup: 3,
      collar: { back: 64, low: 52, throat: 0.33 },
      upper: 'synthetic', toecap: 'toecap_soft', counter: 'counter_medium', insole: 'insole_eva', lacing: true,
      toecapLen: 35, widths: [0, 1],
      sole: { heel: 30, fore: 26, color: '#f4f4f1', bottom: '#b9bcb6' },
    },
  ];

  const WIDTHS = ['D', '2E', '4E'];
  const WIDTH_LABEL = ['표준(D)', '와이드(2E)', '엑스트라(4E)'];

  // 직접 입력하는 값은 표기 사이즈의 '내부 치수'다. 이미지의 외곽 치수와 구분한다.
  const PRODUCT_TOES = {
    round: { label: '라운드 토', start: 0.74, pm: 5, pl: 2.3, tipS: 0.62, front: 22 },
    almond: { label: '아몬드 토', start: 0.74, pm: 3, pl: 2, tipS: 0.6, front: 24 },
    square: { label: '스퀘어 토', start: 0.77, pm: 8, pl: 6, tipS: 0.52, front: 16 },
    anatomical: { label: '해부학적 토', start: 0.76, pm: 7, pl: 3, tipS: 0.86, front: 18 },
  };
  const MATERIAL_OPTIONS = {
    upper: ['knit', 'mesh', 'synthetic', 'leather'],
    toecap: [null, 'toecap_soft', 'toecap_rigid'],
    counter: ['counter_soft', 'counter_medium', 'counter_firm'],
    insole: ['insole_eva', 'insole_memory', 'insole_leather'],
  };
  let productRevision = 0;

  function toeType(model) {
    if (model.toeShape && PRODUCT_TOES[model.toeShape]) return model.toeShape;
    if (model.shape.includes('아몬드')) return 'almond';
    if (model.shape.includes('해부학')) return 'anatomical';
    if (model.shape.includes('스퀘어')) return 'square';
    return 'round';
  }

  function productDimensions(model, size = model.referenceSize || 260, w = 0, lacing = 0.5) {
    const referenceSize = model.referenceSize || 260;
    // A GLB represents one physical product. A size label cannot create a measured second size.
    const fixed = Boolean(model.glbCalibration);
    const grade = fixed ? 0 : size - referenceSize;
    if (fixed) w = 0;
    return {
      referenceSize, size,
      length: (fixed ? referenceSize : size) + model.allow,
      width: model.ball + 0.38 * grade + 4.5 * w,
      heelWidth: model.heel + 0.2 * grade + 1.6 * w,
      instepHeight: model.instep + 0.18 * grade + 1.6 * w + (!fixed && model.lacing ? (0.5 - lacing) * 8 : 0),
      toeHeight: model.toeBoxH + 0.06 * grade + 0.8 * w,
      toeShape: toeType(model),
    };
  }

  function productInput(model) {
    const d = productDimensions(model);
    return {
      name: model.name, ...d,
      upper: model.upper, toecap: model.toecap, counter: model.counter,
      insole: model.insole, lacing: model.lacing,
      silhouetteProfile: model.silhouetteProfile || null,
      heightProfile: model.heightProfile || null,
      radialProfile: model.radialProfile || null,
      supportBedProfile: model.supportBedProfile || null,
      glbCalibration: model.glbCalibration || null,
      dimensionSource: model.dimensionSource || 'manual',
    };
  }

  function dimension(input, key, fallback, min, max, label) {
    if (input[key] == null || input[key] === '') return fallback;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new RangeError(`${label}은 ${min}~${max}mm 범위로 입력해 주세요.`);
    }
    return value;
  }

  function createProduct(input, baseModel = SHOES[0]) {
    input = input || {};
    const referenceSize = dimension(input, 'referenceSize', baseModel.referenceSize || 260, 180, 340, '표기 사이즈');
    const d = productDimensions(baseModel, referenceSize);
    const length = dimension(input, 'length', d.length, 180, 390, '내부 길이');
    if (length < referenceSize - 10 || length > referenceSize + 55) throw new RangeError('내부 길이는 표기 사이즈보다 최대 10mm 작거나 55mm 큰 범위로 입력해 주세요.');
    const type = input.toeShape || toeType(baseModel);
    if (!PRODUCT_TOES[type]) throw new RangeError('앞코 모양을 선택해 주세요.');
    const toe = PRODUCT_TOES[type];
    const materials = {};
    for (const [key, options] of Object.entries(MATERIAL_OPTIONS)) {
      const value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : baseModel[key];
      if (!options.includes(value)) throw new RangeError('지원하는 신발 소재를 선택해 주세요.');
      materials[key] = value;
    }
    const profile = Object.prototype.hasOwnProperty.call(input, 'silhouetteProfile')
      ? input.silhouetteProfile : Object.prototype.hasOwnProperty.call(input, 'profile')
        ? input.profile : baseModel.silhouetteProfile || null;
    const heightProfile = Object.prototype.hasOwnProperty.call(input, 'heightProfile') ? input.heightProfile : baseModel.heightProfile || null;
    const glbCalibration = Object.prototype.hasOwnProperty.call(input, 'glbCalibration') ? input.glbCalibration : baseModel.glbCalibration || null;
    return {
      ...baseModel, ...materials,
      id: 'custom', name: String(input.name || '내가 입력한 신발').slice(0, 70), cat: '직접 입력',
      revision: ++productRevision, referenceSize, allow: length - referenceSize,
      ball: dimension(input, 'width', d.width, 60, 160, '내부 볼 너비'),
      heel: dimension(input, 'heelWidth', d.heelWidth, 40, glbCalibration ? 160 : 105, '내부 뒤꿈치 너비'),
      instep: dimension(input, 'instepHeight', d.instepHeight, 30, glbCalibration ? 240 : 110, '내부 발등 높이'),
      toeBoxH: dimension(input, 'toeHeight', d.toeHeight, 15, glbCalibration ? 240 : 55, '내부 토박스 높이'),
      toeShape: type, shape: toe.label,
      toe: { start: toe.start, pm: toe.pm, pl: toe.pl, tipS: toe.tipS, front: toe.front },
      arch: dimension(input, 'arch', baseModel.arch, 0, 25, '인솔 아치 높이'),
      cup: dimension(input, 'cup', baseModel.cup, 0, 15, '힐컵 높이'),
      collar: { ...baseModel.collar, ...(input.collar || {}) }, sole: { ...baseModel.sole }, widths: glbCalibration ? [0] : [0, 1, 2],
      lacing: input.lacing == null ? baseModel.lacing : Boolean(input.lacing),
      toecapLen: materials.toecap ? Math.max(22, baseModel.toecapLen || 30) : 0,
      silhouetteProfile: profile ? JSON.parse(JSON.stringify(profile)) : null,
      heightProfile: heightProfile ? JSON.parse(JSON.stringify(heightProfile)) : null,
      radialProfile: input.radialProfile ? JSON.parse(JSON.stringify(input.radialProfile)) : baseModel.radialProfile || null,
      supportBedProfile: input.supportBedProfile ? JSON.parse(JSON.stringify(input.supportBedProfile)) : baseModel.supportBedProfile || null,
      glbCalibration: glbCalibration ? JSON.parse(JSON.stringify(glbCalibration)) : null,
      dimensionSource: input.dimensionSource || 'manual',
    };
  }

  function upsertProduct(input, baseModel) {
    const model = createProduct(input, baseModel);
    model.id = input.id || (baseModel && baseModel.glbCalibration ? baseModel.id : 'custom');
    const index = SHOES.findIndex((shoe) => shoe.id === model.id);
    if (index >= 0) SHOES[index] = model; else SHOES.push(model);
    return model;
  }

  function registerModel(id, input, baseModel) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new RangeError('GLB 모델 식별자가 올바르지 않습니다.');
    const base = baseModel || SHOES.find((shoe) => shoe.id === id) || SHOES.find((shoe) => shoe.id === 'court') || SHOES[0];
    const model = upsertProduct({ ...input, id }, base);
    model.cat = 'GLB 모델';
    model.widths = [0];
    return model;
  }

  // 하중·동작 상태. 스캔은 '서기(체중 부하)' 기준.
  // len/wid/girth: 발 길이·폭·둘레 배율, arch: 아치 높이 배율, slide: 발이 앞으로 밀리는 양(mm), crease: 앞꿈치 굴곡 계수
  const STATES = {
    stand: { label: '서기', sub: '체중 부하', len: 1, wid: 1, girth: 1, arch: 1, slide: 0, crease: 0 },
    walk: { label: '걷기', sub: '앞꿈치 밀기', len: 1.006, wid: 1.02, girth: 1, arch: 0.9, slide: 3, crease: 1 },
    run: { label: '러닝', sub: '착지 충격', len: 1.012, wid: 1.035, girth: 1.01, arch: 0.75, slide: 5, crease: 0.6 },
    down: { label: '내리막', sub: '발 앞쏠림', len: 1.008, wid: 1.02, girth: 1, arch: 0.85, slide: 8, crease: 0.3 },
  };
  const STATE_ORDER = ['stand', 'walk', 'run', 'down'];

  // 사용 패턴: 상태별 가중치와 기본 앞코 여유 선호(mm)
  const USAGE = {
    daily: { label: '데일리', w: { stand: 0.4, walk: 0.6 }, toe: [8, 12] },
    run: { label: '러닝', w: { stand: 0.15, walk: 0.25, run: 0.6 }, toe: [9, 13] },
    hike: { label: '하이킹', w: { stand: 0.15, walk: 0.4, down: 0.45 }, toe: [10, 14] },
    work: { label: '출근', w: { stand: 0.5, walk: 0.5 }, toe: [6, 10] },
  };

  const SOCKS = {
    thin: { label: '얇은 양말', t: 0.6 },
    regular: { label: '보통', t: 1.2 },
    thick: { label: '두꺼운 양말', t: 2.4 },
  };

  const SENSITIVITIES = {
    bunion: { label: '엄지 관절', hint: '무지외반·엄지 쪽 통증' },
    tailor: { label: '새끼 관절', hint: '소건막류·새끼발가락 쪽' },
    instep: { label: '발등', hint: '발등 눌림에 민감' },
    heel: { label: '뒤꿈치 물집', hint: '뒤꿈치 마찰·들뜸에 민감' },
  };

  LF.data = {
    FOOT_PRESETS, TOE_SHAPES, MATERIALS, SHOES, WIDTHS, WIDTH_LABEL,
    STATES, STATE_ORDER, USAGE, SOCKS, SENSITIVITIES,
    shoeById: (id) => SHOES.find((s) => s.id === id),
  };
  LF.product = {
    create: createProduct, upsert: upsertProduct, dimensions: productDimensions,
    registerModel,
    fromModel: productInput, TOE_OPTIONS: PRODUCT_TOES, MATERIAL_OPTIONS,
  };
})((window.LF = window.LF || {}));
