// LastFit — 발 입력, GLB 선택과 3D 표시 상태 연결
(function (LF) {
  'use strict';
  const D = LF.data;
  const { fmt } = LF.util;
  const $ = (id) => document.getElementById(id);

  function h(tag, attrs, ...kids) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') element.className = value;
      else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else element.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false) element.append(kid.nodeType ? kid : String(kid));
    }
    return element;
  }

  const engine = new LF.Engine();
  const library = new LF.GLBLibrary();
  let viewer = null;
  let loading = true;

  const state = {
    phase: 1, footSide: 'right',
    preset: 'std', footSource: 'sample', footUnmeasured: [],
    foot: { ...D.FOOT_PRESETS[0].foot },
    pref: {
      usage: 'daily', style: 0, toeRoom: null, sock: 'regular',
      sens: { bunion: false, tailor: false, instep: false, heel: false },
      swell: false, lacing: 0.85, days: 0, refMetrics: null, snugWear: true,
    },
    modelId: null, size: 270, w: 0,
    view: {
      state: 'stand', mode: 'fit', shoe: true, section: false,
      secT: 0.7, cam: 'persp', rotate: false, dimensions: false, deformation: true,
    },
    productAsset: null, libraryId: null, result: null, deform: null,
  };
  const selectedGLB = () => state.libraryId ? library.get(state.libraryId) : null;
  const recommendationCache = new Map();
  let recommendationEpoch = 0, recommendationTimer = null, recommendationKey = null, recommendationResult = null;
  let autoSizePending = false;

  function recommendationInputKey(entry) {
    return JSON.stringify([entry.id, state.footSide, state.foot, state.pref]);
  }

  function registrationFor(entry, size, side = state.footSide) {
    const cache = entry.sizeRegistrations || (entry.sizeRegistrations = new Map());
    const key = `${side}:${size}`;
    let registration = cache.get(key);
    if (!registration) registration = LF.productSizing.calibrate(entry.templateScene, entry.catalog, size, side);
    cache.delete(key); cache.set(key, registration);
    if (cache.size > 4) cache.delete(cache.keys().next().value);
    return registration;
  }

  function fitInput(entry, registration) {
    const fit = entry.catalog.fit || {};
    return { ...registration.productInput, name: entry.name, upper: fit.upper || 'mesh',
      toecap: null, toecapLen: 0, counter: fit.counter || 'counter_soft', insole: 'insole_eva' };
  }

  // Isolated evaluation never selects a product or edits the source GLB/foot.
  function recommendationModel(entry, registration) {
    const model = LF.product.create(fitInput(entry, registration), D.SHOES[0]);
    model.source = 'glb'; model.fitPhysicsProfile = (entry.catalog.fit || {}).physicsProfile || null;
    return model;
  }

  function paintRecommendation(result) {
    recommendationResult = result;
    const reference = result && result.status === 'reference';
    const ready = result && (result.status === 'ready' || reference) && Number.isFinite(result.size);
    $('recommendationLabel').textContent = reference ? '참고 사이즈' : '추천 사이즈';
    $('sizeRecommendation').setAttribute('title',reference?'제품 실측 부족 · 착화 적합 미확인 · 제조사·관련 모델 기반 참고값':'계산용 내부 형상 기반 추정이며 실물 적합 보증이 아닙니다.');
    $('recommendedSize').textContent = ready ? `${result.size} mm` : result && result.status === 'none' ? '추천 없음'
      : result && result.status === 'unknown' ? '추천 보류' : '계산 중…';
    $('recommendationReason').textContent = result && result.status !== 'none' && result.reason || '';
    $('sizeRecommendation').setAttribute('aria-busy', String(!result || result.status === 'pending'));
    const applied = ready && state.size === result.size;
    $('applyRecommendedSize').disabled = !ready || applied;
    $('applyRecommendedSize').setAttribute('aria-label',reference?'참고 사이즈로 신어보기':'추천 사이즈 적용');
    $('applyRecommendedSize').textContent = applied ? '적용됨' : reference ? '신어보기' : '적용';
  }

  function applyRecommendation(entry, result) {
    if (!entry || selectedGLB() !== entry || state.phase !== 2 || !result ||
        !['ready','reference'].includes(result.status) || !Number.isFinite(result.size) ||
        result.requiresVerification !== false || recommendationKey !== recommendationInputKey(entry)) return;
    if (state.size === result.size && entry.nominalSizeMm === result.size) return;
    registerGLBFit(entry, result.size); state.size = result.size;
    recompute({ model: true });
  }

  function finishRecommendation(entry, result) {
    paintRecommendation(result);
    if (!autoSizePending || state.phase !== 2 || selectedGLB() !== entry ||
        recommendationKey !== recommendationInputKey(entry) || !result || result.status === 'pending') return;
    // Consume the intent before recomputing so cached renders cannot undo manual selection.
    autoSizePending = false;
    applyRecommendation(entry, result);
  }

  function requestRecommendation(entry) {
    if (state.phase !== 2 || !entry || !entry.registration || !LF.sizeRecommendation) return;
    const key = recommendationInputKey(entry);
    if (recommendationKey === key) { finishRecommendation(entry, recommendationResult); return; }
    recommendationKey = key;
    const epoch = ++recommendationEpoch;
    clearTimeout(recommendationTimer);
    if (recommendationCache.has(key)) { finishRecommendation(entry, recommendationCache.get(key)); return; }
    paintRecommendation({ status: 'pending', reason: '230–300 mm에서 길이·볼·발등 확인 중…' });
    const foot = JSON.parse(JSON.stringify(state.foot)), pref = JSON.parse(JSON.stringify(state.pref)), side = state.footSide;
    const current = () => recommendationEpoch === epoch && state.phase === 2 && selectedGLB() === entry && recommendationInputKey(entry) === key;
    recommendationTimer = setTimeout(async () => {
      try {
        if (!current()) return;
        const bases = entry.recommendationBases || (entry.recommendationBases = new Map());
        let basis = bases.get(side);
        if (!basis) {
          const registration = registrationFor(entry, LF.productSizing.DEFAULT_SIZE, side);
          basis = { registration, model: recommendationModel(entry, registration) }; bases.set(side, basis);
        }
        const result = await LF.sizeRecommendation.recommend({ catalog: entry.catalog, ...basis, foot, pref, footSide: side,
          isCurrent: current, onProgress: (progress) => {
            if (current()) paintRecommendation({ status: 'pending', reason: typeof progress === 'string' ? progress
              : progress.stage === 'scan' ? `230–300 mm 비교 중 · ${progress.completed + 1}/${progress.total}` : '후보 치수의 착화 상태를 확인하고 있습니다…' });
          } });
        if (!current() || result.status === 'cancelled') return;
        if (result.status === 'ready') {
          const fitting = result.candidates.filter(candidate => candidate.acceptable && candidate.chartEligible !== false)
            .sort((a, b) => a.metrics.rankingCost - b.metrics.rankingCost || a.size - b.size);
          const verified = [];
          result.actualChecks = [];
          for (const candidate of fitting) {
            paintRecommendation({ status: 'pending', reason: `${candidate.size} mm의 내부 형상 확인 중…` });
            await new Promise(resolve => setTimeout(resolve, 0));
            if (!current()) return;
            const registration = registrationFor(entry, candidate.size, side);
            const checked = LF.sizeRecommendation.inspect({ model: recommendationModel(entry, registration), foot, pref, size: candidate.size, quality: 'full' });
            result.actualChecks.push(checked);
            if (checked.acceptable) verified.push({ checked, registration });
          }
          verified.sort((a, b) => a.checked.metrics.rankingCost - b.checked.metrics.rankingCost || a.checked.size - b.checked.size);
          if (!verified.length) {
            result.status = 'unknown'; result.size = null;
            result.geometryFitVerified = false;
            result.reason = '내부 형상을 다시 확인한 결과 맞는 치수가 없어 추천을 보류합니다.';
            if(LF.fitEvidence){
              const reference=LF.fitEvidence.reference({catalog:entry.catalog,foot,pref,simulationResult:result});
              if(reference&&reference.status==='reference')Object.assign(result,reference,{requiresVerification:false});
            }
          } else {
            const best = verified[0], cacheKey = `${side}:${best.checked.size}`;
            entry.sizeRegistrations.delete(cacheKey); entry.sizeRegistrations.set(cacheKey, best.registration);
            if (entry.sizeRegistrations.size > 4) entry.sizeRegistrations.delete(entry.sizeRegistrations.keys().next().value);
            result.size = best.checked.size; result.verification = best.checked; result.requiresVerification = false;
            result.geometryFitVerified = true;
            result.reason = '길이·볼·발등을 함께 맞춘 형상 기반 추정';
          }
        }
        if (!current()) return;
        recommendationCache.set(key, result);
        if (recommendationCache.size > 24) recommendationCache.delete(recommendationCache.keys().next().value);
        finishRecommendation(entry, result);
      } catch (error) {
        if (current()) finishRecommendation(entry, { status: 'unknown', reason: '내부 형상을 확인하지 못해 추천을 보류합니다.' });
      }
    }, 280);
  }

  function segmented(container, items, get, set) {
    container.replaceChildren(...items.map(([value, label, hint]) => {
      const button = h('button', {
        type: 'button', 'aria-pressed': String(get() === value),
        onclick: () => { set(value); sync(); },
      }, label, hint ? h('small', null, hint) : null);
      button.dataset.v = value;
      return button;
    }));
    const sync = () => container.querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(String(get()) === button.dataset.v));
    });
    return sync;
  }

  function setupFootInputs() {
    state.syncSide = segmented($('footSideSeg'), [['left','왼발'],['right','오른발']],
      () => state.footSide, value => {
        state.footSide=value;viewer.setFootSide(value);
        const entry=selectedGLB();
        if(entry)registerGLBFit(entry,entry.nominalSizeMm);
        recompute({foot:true,model:true});
      });
    for (const [key, inputId, outputId, digits] of [
      ['length', 'footLength', 'footLengthOut', 0],
      ['ballWidth', 'footBall', 'footBallOut', 1],
      ['instepHeight', 'footInstep', 'footInstepOut', 1],
    ]) {
      const input = $(inputId);
      input.value = state.foot[key];
      const show = () => { $(outputId).textContent = `${fmt(state.foot[key], digits)} mm`; };
      show();
      input.addEventListener('input', () => {
        state.foot[key] = Number(input.value);
        show();
        footChanged();
      });
    }
    segmented($('footShapeSeg'), Object.entries(D.TOE_SHAPES).map(([key, value]) => [key, value.label, value.hint]),
      () => state.foot.toeShape, (value) => { state.foot.toeShape = value; footChanged(); });
  }

  function footChanged() {
    state.preset = 'custom';
    state.footSource = 'manual';
    delete state.foot.silhouetteProfile;
    if (state.phase === 2) autoSizePending = true;
    if (state.phase === 2 && state.view.mode !== 'fit') selectViewMode('fit');
    if (state.phase === 2) requestRecommendation(selectedGLB());
    changed({ foot: true });
  }

  // A nominal product label is separate from measured outer length. Size changes
  // always recalibrate the immutable GLB using the same independent size rule.
  function registerGLBFit(entry, nominalSizeMm = LF.productSizing.DEFAULT_SIZE) {
    const registration = registrationFor(entry, nominalSizeMm);
    const fit = entry.catalog.fit || {};
    const model = LF.product.registerModel(entry.id, fitInput(entry, registration), D.SHOES[0]);
    model.source = 'glb';
    model.fitPhysicsProfile = fit.physicsProfile || null;
    model.widths = [0];
    library.update(entry.id, { modelId: model.id, registration, calibration: registration.calibration.options, dimensions: registration.dimensions });
    entry.nominalSizeMm = nominalSizeMm;
    if (nominalSizeMm === LF.productSizing.DEFAULT_SIZE) {
      const bases = entry.recommendationBases || (entry.recommendationBases = new Map());
      if (!bases.has(state.footSide)) bases.set(state.footSide, { registration, model });
    }
    return model;
  }

  function selectGLB(id) {
    const entry = library.get(id);
    if (!entry || !entry.registration || !entry.modelId) return;
    if(entry.registration.calibration.footSide!==state.footSide)registerGLBFit(entry,entry.nominalSizeMm);
    library.select(id);
    state.libraryId = entry.id;
    state.modelId = entry.modelId;
    state.size = entry.nominalSizeMm;
    state.w = 0;
    state.productAsset = { modelId: entry.modelId, libraryId: entry.id, label: entry.name, demo: entry.demo };
    state.view.shoe = true;
    if (state.phase === 2) autoSizePending = true;
    recompute({ model: true });
    if(state.phase===2)selectViewMode(state.view.mode);
  }

  function setupProductSize() {
    const select=$('productSize');
    select.replaceChildren(...LF.productSizing.sizes.map(size=>h('option',{value:size},`${size} mm`)));
    select.value=state.size;
    select.addEventListener('change',()=>{
      const entry=selectedGLB();if(!entry)return;
      autoSizePending = false;
      try {
        const size=LF.productSizing.label(select.value);
        registerGLBFit(entry,size);state.size=size;
        recompute({model:true});
      } catch(error) {
        select.value=entry.nominalSizeMm;
        $('assetStatus').textContent=error.message;
        $('assetStatus').classList.add('error');
      }
    });
    $('applyRecommendedSize').addEventListener('click', () => {
      autoSizePending = false;
      applyRecommendation(selectedGLB(), recommendationResult);
    });
  }

  function renderProductSize() {
    const entry=selectedGLB(), select=$('productSize');
    select.disabled=!entry||!entry.registration;
    if(!entry||!entry.registration){paintRecommendation({status:'unknown',reason:'하단 목록에서 제품을 선택하세요.'});return;}
    select.value=entry.nominalSizeMm;
    requestRecommendation(entry);
  }

  async function loadCatalog() {
    const errors = [];
    const status = $('assetStatus');
    const catalogs = LF.assetCatalog || [];
    const defaultProduct = catalogs.find(catalog => catalog.key === 'air-jordan-1-dior.glb');
    for (const catalog of catalogs) {
      status.textContent = `${catalog.fileName} 불러오는 중…`;
      try {
        const loaded = await LF.assets.loadCatalog(catalog);
        const entry = library.add(loaded, { fileName: catalog.fileName, name: catalog.name, demo: catalog.demo });
        entry.catalog=catalog;
        try { registerGLBFit(entry, LF.productSizing.DEFAULT_SIZE); }
        catch (error) { errors.push(`${entry.fileName}: ${error.message}`); }
        if (!state.libraryId && entry.registration && (!defaultProduct || catalog === defaultProduct)) selectGLB(entry.id);
        renderRack();
      } catch (error) {
        errors.push(`${catalog.fileName}: ${error.message || 'GLB를 읽지 못했습니다.'}`);
      }
    }
    if (!state.libraryId) {
      const fallback = library.list().find(entry => entry.registration);
      if (fallback) selectGLB(fallback.id);
    }
    loading = false;
    status.classList.toggle('error', errors.length > 0);
    status.textContent = errors.length ? errors.join(' ') : '';
    renderRack();
    renderViewCaption();
  }

  function renderRack() {
    const entries = library.list();
    $('rack').replaceChildren(...entries.map((entry) => h('div', { role: 'listitem' }, h('button', {
      class: 'shoe-card glb-card', type: 'button', title: entry.fileName,
      disabled: !entry.registration, 'aria-pressed': String(entry.id === state.libraryId), 'data-library-id': entry.id,
      onclick: () => { if (state.libraryId !== entry.id) selectGLB(entry.id); },
    }, h('span', { class: 'glb-file-icon' }, 'GLB'), h('span', { class: 'nm' }, entry.name),
    h('span', { class: 'ct' }, entry.fileName), h('div', { class: 'res' }, entry.registration ? `표기 ${entry.nominalSizeMm} mm` : '형상 계산 실패')))));
    if (!entries.length) $('rack').append(h('p', { class: 'rack-empty' }, loading ? '신발을 불러오는 중…' : '등록된 신발이 없습니다.'));
  }

  function renderViewCaption() {
    const box = $('viewCaption');
    box.hidden = state.phase !== 1;
    if(state.phase===1){
      box.replaceChildren(h('b',null,'내 발 모양 설정'),
        h('span',null,`${state.footSide==='left'?'왼발':'오른발'} · ${state.foot.length} mm`));
      return;
    }
    box.replaceChildren();
    renderProductSize();
  }

  function selectViewMode(mode) {
    const view = state.view;
    view.mode = mode === 'product' ? 'product' : 'fit';
    if (view.mode === 'product' && view.section) {
      view.section = false;
      $('secTog').setAttribute('aria-pressed', 'false');
      $('sectionCard').hidden = true;
      viewer.setSection(null);
      view.cam = 'persp';
      viewer.setView(view.cam);
      if (state.syncCam) state.syncCam();
    }
    viewer.setMode(view.mode);
    view.shoe = viewer.showShoe;
    if (state.syncMode) state.syncMode();
    $('shoeTog').setAttribute('aria-pressed', String(view.shoe));
    $('shoeTog').disabled = $('secTog').disabled = !state.productAsset;
    renderViewCaption();
  }

  function setupStage() {
    const view = state.view;
    state.syncCam = segmented($('camSeg'), [['persp', '3/4'], ['side', '측면'], ['top', '위'], ['front', '앞']],
      () => view.cam, (value) => { view.cam = value; viewer.setView(value); });
    state.syncMode = segmented($('modeSeg'), [['product', '제품 보기'], ['fit', '착화 보기']], () => view.mode, selectViewMode);
    $('rotateTog').addEventListener('click', (event) => {
      view.rotate = !view.rotate;
      viewer.setAutoRotate(view.rotate);
      event.currentTarget.setAttribute('aria-pressed', String(view.rotate));
    });
    $('viewReset').addEventListener('click', () => { viewer.resetView(); view.cam = 'persp'; state.syncCam(); });
    $('shoeTog').addEventListener('click', (event) => {
      view.shoe = !viewer.showShoe;
      viewer.setShowShoe(view.shoe);
      event.currentTarget.setAttribute('aria-pressed', String(view.shoe));
    });
    $('secTog').addEventListener('click', (event) => {
      if (view.mode === 'product') selectViewMode('fit');
      view.section = !view.section;
      event.currentTarget.setAttribute('aria-pressed', String(view.section));
      $('sectionCard').hidden = !view.section;
      view.cam = view.section ? 'cut' : 'persp';
      viewer.setView(view.cam);
      state.syncCam();
      updateSection();
    });
    $('secClose').addEventListener('click', () => { if (view.section) $('secTog').click(); });
    $('secRange').value = view.secT;
    $('secRange').addEventListener('input', () => { view.secT = Number($('secRange').value); updateSection(); });
    // 숨긴 기존 조절값도 기본 착화 조건과 일치시킨다.
    $('daysRange').value = state.pref.days;
    $('daysOut').textContent = '새 신발';
    $('laceRange').value = state.pref.lacing;
    $('laceOut').textContent = '단단히';
    $('aboutBtn').addEventListener('click', () => { $('about').hidden = false; $('aboutClose').focus(); });
    $('aboutClose').addEventListener('click', () => { $('about').hidden = true; $('aboutBtn').focus(); });
    $('about').addEventListener('click', (event) => { if (event.target.id === 'about') $('about').hidden = true; });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('about').hidden = true; });
  }

  function renderPhase() {
    const setup=state.phase===1;
    document.querySelector('.app').dataset.phase=state.phase;
    for(const [id,number] of [['phaseOne',1],['phaseTwo',2]]){
      $(id).setAttribute('aria-pressed',String(state.phase===number));
      if(state.phase===number)$(id).setAttribute('aria-current','step');else $(id).removeAttribute('aria-current');
    }
    $('phaseAction').textContent=setup?'착화감 확인하기 →':'← 발 설정으로 돌아가기';
    $('phaseHint').textContent=setup?'발 방향과 치수를 내 발에 맞게 조절하세요.':'입력한 발에 맞춰 사이즈를 자동 선택합니다. 치수는 계속 조정할 수 있습니다.';
    for(const id of ['modeSeg','shoeTog','secTog','productControls','rack','assetStatus'])$(id).hidden=setup;
    $('footPanelNote').textContent=`${state.footSide==='left'?'왼발':'오른발'} · ${setup?'발 모양 설정':'착화 기준'}`;
  }

  function setPhase(phase) {
    if (phase === 2 && state.phase !== 2) autoSizePending = true;
    state.phase=phase===2?2:1;
    if(state.phase===1){
      autoSizePending = false;
      recommendationEpoch++; clearTimeout(recommendationTimer); recommendationKey=null;
      state.view.section=false;$('sectionCard').hidden=true;viewer.setSection(null);
      $('secTog').setAttribute('aria-pressed','false');
      if(state.view.cam==='cut'){state.view.cam='persp';viewer.setView('persp');state.syncCam();}
    }else state.view.mode='fit';
    renderPhase();recompute({foot:true});
    if(state.phase===2 && state.result)selectViewMode('fit');
  }

  function setupPhases() {
    $('phaseOne').addEventListener('click',()=>setPhase(1));
    $('phaseTwo').addEventListener('click',()=>setPhase(2));
    $('phaseAction').addEventListener('click',()=>setPhase(state.phase===1?2:1));
    renderPhase();
  }

  // 연속 슬라이더 입력은 한 프레임으로 모은다. 숨긴 탭에서는 타이머가 처리한다.
  let pending = null;
  function changed(what) {
    const scheduled = pending !== null;
    pending = Object.assign(pending || {}, what || {});
    if (scheduled) return;
    const run = () => {
      if (!pending) return;
      const update = pending;
      pending = null;
      recompute(update);
    };
    requestAnimationFrame(run);
    setTimeout(run, 60);
  }

  function recompute(update) {
    if (update.foot) engine.setFoot(state.foot);
    viewer.setFootSide(state.footSide);
    renderPhase();
    if(state.phase===1){
      viewer.showFootPreview(engine.foot('stand',false));
      renderViewCaption();
      if(update.model)renderRack();return;
    }
    const entry = selectedGLB();
    if (!entry || !entry.modelId || !entry.registration) return;
    const model = D.shoeById(entry.modelId);
    if(viewer.assetRegistration!==entry.registration)
      viewer.setCalibratedAsset(entry.templateScene,entry.registration,{name:entry.name,deferDeformation:true});
    viewer.setShowShoe(state.view.shoe);
    state.result = engine.evaluate(model.id, state.size, 0, state.pref, 'stand', { displayOnly: true });
    state.deform = engine.shoeDeflection(state.result.display);
    // 압력 계산, 압축 발 표시와 단면 모두 이 결과의 같은 좌표계를 사용한다.
    viewer.update(state.result.display, state.deform, model);
    renderViewCaption();
    updateSection();
    if (update.model) renderRack();
  }

  function updateSection() {
    const view = state.view;
    if (state.phase===1 || !view.section || !state.result) { viewer.setSection(null); return; }
    const display = state.result.display;
    const xShoe = LF.sim.poseFootPoint(display.ctx,view.secT*display.foot.L,0,0).x;
    viewer.setSection(xShoe);
    const shell = viewer.assetField;
    const sectionDeform = LF.diorFit && LF.diorFit.enabled(display.shoe.model) && shell && shell.shellStats
      ? { ...state.deform, defl: shell.stretch } : state.deform;
    const info = LF.drawSection($('secCanvas'), { ...display, sim: viewer.fitSimulation(display) }, sectionDeform, xShoe);
    if (!info) return;
    $('secTitle').textContent = `단면 · ${info.region}`;
    $('secSub').textContent = `발길이 ${fmt(info.t * 100, 0)}% 위치`;
  }

  function watchTheme() {
    const refresh = () => { viewer.applyTheme(); viewer.paintFoot(); viewer.paintShell(); updateSection(); };
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
    new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function init() {
    if (!window.THREE) {
      $('viewport').append(h('p', { style: 'padding:24px' }, '3D 라이브러리를 불러오지 못했습니다. 새로고침하세요.'));
      return;
    }
    viewer = new LF.Viewer($('viewport'));
    viewer.setExaggerate(1);
    setupFootInputs();
    setupProductSize();
    setupStage();
    setupPhases();
    viewer.setDeformationEnabled(true);
    selectViewMode(state.view.mode);
    watchTheme();
    window.addEventListener('resize', updateSection);
    recompute({ foot: true });
    renderRack();
    LF.app = { state, engine, viewer, library, selectGLB, changed, registerGLBFit, setPhase };
    loadCatalog();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})((window.LF = window.LF || {}));
