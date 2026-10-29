// Nominal size labels, manufacturer foot-length charts and estimated GLB scale
// are distinct data. A chart never supplies a shoe's measured internal dimensions.
(function (LF) {
  'use strict';
  const MIN_SIZE = 230, MAX_SIZE = 310, STEP = 5, DEFAULT_SIZE = 270;
  const sizes = Array.from({length:(MAX_SIZE-MIN_SIZE)/STEP+1},(_,i)=>MIN_SIZE+i*STEP);
  function label(value) {
    const size=Number(value);
    if(!Number.isFinite(size)||size<MIN_SIZE||size>MAX_SIZE||(size-MIN_SIZE)%STEP!==0)
      throw new RangeError('제품 사이즈는 230~310mm에서 5mm 단위로 선택하세요.');
    return size;
  }
  function describe(catalog, value=DEFAULT_SIZE) {
    const nominalSizeMm=label(value), fit=catalog.fit||{}, chart=fit.sizeChart;
    const rows=chart&&Array.isArray(chart.rows)?chart.rows.filter(row=>row.labelMm===nominalSizeMm):[];
    if(chart&&!rows.length)throw new RangeError('이 사이즈의 제조사 기준을 찾을 수 없습니다.');
    // Some manufacturer labels have two US rows. Retain both; scale the demo
    // using the larger foot reference without claiming they are measured SKUs.
    const reference=rows.length?rows.reduce((best,row)=>row.footLengthMm>best.footLengthMm?row:best):null;
    const recommendedFootLengthMm=reference?Number(reference.footLengthMm):nominalSizeMm;
    const toeAllowanceMm=Number(fit.toeAllowanceMm==null?12:fit.toeAllowanceMm);
    const wallThicknessMm=Number(catalog.calibration&&catalog.calibration.wallThickness||3);
    if(!(recommendedFootLengthMm>0)||!(toeAllowanceMm>=0&&toeAllowanceMm<=25)||!(wallThicknessMm>0&&wallThicknessMm<=15))
      throw new RangeError('제품 사이즈의 치수 기준이 올바르지 않습니다.');
    const innerLengthMm=recommendedFootLengthMm+toeAllowanceMm;
    return {nominalSizeMm,recommendedFootLengthMm,innerLengthMm,outerLengthMm:innerLengthMm+wallThicknessMm*2,
      toeAllowanceMm,wallThicknessMm,isEstimated:true,source:reference?'size-chart-and-estimated-toe-allowance':'nominal-label-and-estimated-toe-allowance',
      sourceLabel:reference?'Nike 공식 사이즈표':'표기 사이즈 기준',
      footLengthSourceURL:chart&&chart.sourceUrl||null,
      footLengthRangeMm:rows.length?[Math.min(...rows.map(row=>row.footLengthMm)),Math.max(...rows.map(row=>row.footLengthMm))]:null,
      manufacturerReference:reference?{us:reference.us,eu:reference.eu,uk:reference.uk,jpCm:reference.jpCm}:null};
  }
  // A curved heel and an outsole overhang cannot be represented by subtracting
  // a flat 3mm wall from both ends. Measure usable reference stations in the GLB.
  // These reference heights and the toe allowance remain explicit estimates.
  function usableGeometry(registration, wallThickness) {
    const profile=registration.supportBedProfile,L=registration.productInput.length;
    if(!profile || !profile.seatingPlane || !LF.contactDrape)return null;
    const colliders=registration.meshes.map(item=>LF.contactDrape.createCollider(item.canonicalPositions,item.mesh.geometry.index));
    const floorAt=(t,z)=>LF.supportBed.heightAt(profile,L*t,false,z), rearHeightMm=29, toeHeightMm=10;
    const heels=[],toes=[];
    for(const z of [-5,0,5]) {
      const rearFloor=floorAt(.15,z),frontFloor=floorAt(.9,z);
      if(!Number.isFinite(rearFloor)||!Number.isFinite(frontFloor))continue;
      const rearHits=[],frontHits=[];
      for(const collider of colliders) {
        const distances=[];collider.raycast(-30,rearFloor+rearHeightMm,z,1,0,0,L+60,null,distances);
        for(const distance of distances){const x=distance-30;if(x<L*.18){const hit=collider.query(x,rearFloor+rearHeightMm,z);rearHits.push({x,nx:hit.normal.x});}}
        const front=[];collider.raycast(-30,frontFloor+toeHeightMm,z,1,0,0,L+60,null,front);
        frontHits.push(...front.map(d=>d-30));
      }
      rearHits.sort((a,b)=>a.x-b.x);
      const inner=rearHits.find(h=>h.nx>.45),outer=rearHits[0];
      if(!inner && !outer || !frontHits.length)continue;
      heels.push(inner?inner.x:outer.x+wallThickness);
      toes.push(Math.max(...frontHits)-wallThickness);
    }
    if(heels.length<2)return null;
    heels.sort((a,b)=>a-b);toes.sort((a,b)=>a-b);
    const heelXmm=heels[Math.floor(heels.length/2)],frontXmm=toes[Math.floor(toes.length/2)],lengthMm=frontXmm-heelXmm;
    if(!(lengthMm>L*.7 && lengthMm<L && heelXmm>=0 && heelXmm<L*.18))return null;
    return {heelXmm,frontXmm,lengthMm,rearHeightMm,toeHeightMm,
      supportPlaneSource:profile.source,
      source:profile.isEstimated ? 'glb-heel-toe-with-estimated-insole-plane' : 'glb-inner-heel-and-estimated-toe-wall',isEstimated:true};
  }
  function calibrate(scene,catalog,value=DEFAULT_SIZE,footSide='right') {
    if(!['left','right'].includes(footSide))throw new RangeError('왼발 또는 오른발을 선택하세요.');
    const sizing=describe(catalog,value);
    const target=(catalog.fitTargets||[]).find(item=>item.side===footSide);
    const options={axis:'auto',reverse:false,mirror:false,unit:'m',wallThickness:3,soleThickness:20,
      ...(catalog.calibration||{}),...(target&&target.calibration||{}),outerLength:sizing.outerLengthMm,referenceSize:sizing.nominalSizeMm,
      lengthSource:'nominal-size-estimate'};
    // Every selected size starts from the immutable source. There is no scaling
    // based on the user's foot and no accumulation from the previous size.
    delete options.outerWidth;delete options.outerHeight;
    const targetLengthMm=sizing.innerLengthMm;
    let registration,usable=null;
    for(let pass=0;pass<3;pass++) {
      registration=LF.glbFit.analyzeScene(scene,{...options,skipCavityProfile:true});
      usable=usableGeometry(registration,sizing.wallThicknessMm);
      if(!usable || Math.abs(usable.lengthMm-targetLengthMm)<.2)break;
      const next=options.outerLength*targetLengthMm/usable.lengthMm;
      if(next<180 || next>410)break;
      options.outerLength=next;
    }
    registration=LF.glbFit.analyzeScene(scene,options);
    usable=usableGeometry(registration,sizing.wallThicknessMm);
    const c=registration.calibration;
    if(usable){c.usableGeometry={...usable,targetLengthMm};c.internalSource=usable.source;}
    c.source='nominal-size-estimate';c.lengthSource='nominal-size-estimate';c.nominalSizeMm=sizing.nominalSizeMm;
    c.footSide=footSide;
    c.demoLengthMm=null;c.referenceSizeSource='selected-nominal-label';c.referenceSizeEstimated=false;
    const lengthReference=sizing.footLengthSourceURL?'size-chart':'nominal-label';
    c.dimensionSources={length:usable?lengthReference+'-and-glb-usable-length-estimate':lengthReference+'-and-estimated-allowance',width:'proportional-glb-estimate',height:'proportional-glb-estimate'};
    c.options={...options};c.sizing={...sizing};
    registration.sizing={...sizing,innerLengthMm:usable?usable.lengthMm:registration.productInput.length,cavityFrameLengthMm:registration.productInput.length,
      usableGeometry:usable?{...usable,targetLengthMm}:null,
      outerLengthMm:registration.dimensions.length,outerWidthMm:registration.dimensions.width,outerHeightMm:registration.dimensions.height};
    registration.productInput.dimensionSource='nominal-size-estimate';
    registration.productInput.glbCalibration=c;
    if(LF.diorCavity)LF.diorCavity.apply(registration,catalog);
    return registration;
  }
  LF.productSizing={sizes,MIN_SIZE,MAX_SIZE,STEP,DEFAULT_SIZE,label,describe,calibrate,usableGeometry};
})((window.LF=window.LF||{}));
