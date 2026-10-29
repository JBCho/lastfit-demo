// Nominal-size recommendation over the selected product's estimated cavity.
// The source GLB, registered model and measured foot are never resized in place.
// These screening limits are demo fit assumptions, not medical pressure limits.
(function (LF) {
  'use strict';
  const SIZES=Object.freeze(Array.from({length:15},(_,i)=>230+i*5));
  const REGIONS=['toeFront','toeBox','ball','instep','heel'];
  const LABELS={toeFront:'발끝',toeBox:'발가락',ball:'볼',instep:'발등',heel:'뒤꿈치'};
  const RES={coarse:{footNx:30,footNt:36,shoeNx:52,shoeNt:40},full:{footNx:104,footNt:60,shoeNx:116,shoeNt:60}};
  const LIMITS=Object.freeze({minToeGapMm:5,maxToeGapMm:18,idealToeGapMm:10,maximumGapSpreadMm:14,
    maximumUnresolvedMm:.001,maximumMissingForefootFraction:.12});
  const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const mean=(xs)=>xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:NaN;
  const smallestMean=(xs,n=4)=>mean(xs.slice().sort((a,b)=>a-b).slice(0,n));
  const tick=()=>new Promise(resolve=>{
    if(typeof setTimeout==='function')setTimeout(resolve,0);
    else if(typeof MessageChannel==='function') {
      const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(0);
    } else resolve();
  });
  function safePref(pref) {
    return {...pref,usage:pref.usage||'daily',style:Number(pref.style)||0,sock:pref.sock||'regular',
      sens:{bunion:false,tailor:false,instep:false,heel:false,...pref.sens},lacing:finite(pref.lacing)?pref.lacing:.85,
      days:finite(pref.days)?pref.days:0,snugWear:true};
  }
  function footprintKey(options) {
    const payload=JSON.stringify({product:options.catalog&&options.catalog.key,side:options.footSide||'right',
      foot:options.foot,pref:options.pref,model:options.model});
    let hash=2166136261;for(let i=0;i<payload.length;i++)hash=Math.imul(hash^payload.charCodeAt(i),16777619);
    return 'size-v1-'+(hash>>>0).toString(16);
  }
  function resizeSupport(profile,s) {
    if(!profile)return null;
    const out=clone(profile);out.length*=s;
    if(out.seatingPlane)for(const key of ['offsetMm','residualMm'])if(finite(out.seatingPlane[key]))out.seatingPlane[key]*=s;
    for(const row of out.points||[]) {
      for(const key of ['x','height','centerZ'])if(finite(row[key]))row[key]*=s;
      for(const sample of row.samples||[])for(const key of ['z','height','undersideHeight','thicknessMm'])if(finite(sample[key]))sample[key]*=s;
    }
    return out;
  }
  // Candidate profiles are uniformly graded from one immutable reference.
  // This is an estimate; the chosen label must subsequently be recalibrated
  // once against the original GLB before the UI calls it a recommendation.
  function candidateModel(registration,model,catalog,size) {
    const described=LF.productSizing.describe(catalog,size);
    const baseLength=registration.sizing&&registration.sizing.innerLengthMm;
    if(!(baseLength>0))throw new Error('제품 내부 길이 기준이 없습니다.');
    // Grade from the same nominal target as the source calibration. Its
    // measured usable length can differ by a fraction of a mm; using that as
    // the denominator would even resize the unchanged reference-size model.
    const targetLength=registration.calibration&&registration.calibration.usableGeometry&&registration.calibration.usableGeometry.targetLengthMm;
    const scale=described.innerLengthMm/(targetLength>0?targetLength:baseLength),out=clone(model);
    if(!(scale>.6&&scale<1.5))throw new Error('제품 비례 치수 범위를 벗어났습니다.');
    const frameLength=LF.product.dimensions(model,model.referenceSize,0,.85).length;
    out.referenceSize=size;out.allow=frameLength*scale-size;
    for(const key of ['ball','heel','instep','toeBoxH','arch','cup','toecapLen'])if(finite(out[key]))out[key]*=scale;
    if(out.toe&&finite(out.toe.front))out.toe.front*=scale;
    if(out.collar)for(const key of ['back','low'])if(finite(out.collar[key]))out.collar[key]*=scale;
    if(out.sole)for(const key of ['heel','fore'])if(finite(out.sole[key]))out.sole[key]*=scale;
    // Outline rows are ratios to referenceWidth; changing both would double-scale.
    if(out.silhouetteProfile&&finite(out.silhouetteProfile.referenceWidth))out.silhouetteProfile.referenceWidth*=scale;
    if(out.heightProfile) {
      for(const key of ['referenceHeight','referenceToeHeight'])if(finite(out.heightProfile[key]))out.heightProfile[key]*=scale;
      for(const row of out.heightProfile.points||[])if(finite(row.height))row.height*=scale;
    }
    if(out.radialProfile) {
      // The measured lining allowance is held at its input value. The entire
      // cavity is only a screening grade, never a measured second SKU.
      for(const row of out.radialProfile.points||[]) {
        for(const key of ['centerY','centerZ','floorY'])if(finite(row[key]))row[key]*=scale;
        row.ring=row.ring.map(p=>p.map(v=>v*scale));
        if(row.outerRadius)row.outerRadius=row.outerRadius.map(v=>finite(v)?v*scale:v);
      }
    }
    out.supportBedProfile=resizeSupport(out.supportBedProfile,scale);
    const cal=out.glbCalibration;
    if(cal) {
      cal.nominalSizeMm=size;
      if(cal.usableGeometry)for(const key of ['heelXmm','frontXmm','lengthMm','targetLengthMm','rearHeightMm','toeHeightMm'])if(finite(cal.usableGeometry[key]))cal.usableGeometry[key]*=scale;
      cal.sizing={...described};cal.recommendationSource='uniform-cavity-profile-screening';
    }
    out.id='recommendation-'+size;out.widths=[0];
    return {model:out,scale,sizing:described};
  }
  function failure(size,status,reason,metrics,quality) {
    return {size,acceptable:false,status,reason,metrics:metrics||{},quality:quality||'coarse'};
  }
  function inspect(options) {
    const {model,foot,size}=options,quality=options.quality==='coarse'?'coarse':'full',r=RES[quality];
    if(!model||!foot||!SIZES.includes(Number(size)))return failure(size,'unknown','발·제품 치수 정보를 확인해 주세요.',null,quality);
    if(!['length','ballWidth','instepHeight'].every(key=>finite(foot[key])&&foot[key]>0))
      return failure(size,'unknown','발 길이·볼·높이 정보를 확인해 주세요.',null,quality);
    if(!model.glbCalibration||!model.radialProfile||!model.supportBedProfile||!model.supportBedProfile.seatingPlane)
      return failure(size,'unknown','제품 내부 형상 정보가 부족합니다.',null,quality);
    const pref=safePref(options.pref||{}),tol=LF.sim.tolerances(pref),state={...LF.data.STATES.stand};
    if(pref.swell){state.len*=1.005;state.wid*=1.02;state.girth*=1.025;}
    const measured=LF.geom.buildFoot(foot,state,r.footNx,r.footNt);
    const shoe=LF.geom.buildLast(model,size,0,pref.lacing,r.shoeNx,r.shoeNt);
    shoe.hash=new LF.sim.SpatialHash(shoe.pos,shoe.n,5,32);shoe.model=model;shoe.mats=LF.sim.materialTable(model,pref.lacing);
    const ctx=LF.sim.context(model,'stand',pref),worn=LF.sim.prepareWorn(measured,shoe,ctx);
    const sim=LF.sim.simulate(measured,worn.shoe,shoe.mats,ctx);
    const usable=model.glbCalibration.usableGeometry,tipGaps=[];let front=-Infinity;
    const regionStats={};for(const key of REGIONS)regionStats[key]={evaluated:0,missing:0,maxPressureKPa:0,maxUnresolvedMm:0,invalid:0};
    for(let i=0;i<measured.n;i++) {
      if(measured.tv[i]>.85)front=Math.max(front,sim.fpos[i*3]);
      if(finite(sim.lgap[i]))tipGaps.push({gap:sim.lgap[i],x:sim.fpos[i*3]});
      const key=LF.geom.ZONE_KEYS[measured.zone[i]],a=regionStats[key];if(!a)continue;
      // Above an open collar is not an unknown roof. Missing forefoot/instep
      // coverage is tracked separately so an untested volume cannot pass.
      if(sim.ex[i]) {
        const x=sim.fpos[i*3],y=sim.fpos[i*3+1];
        const open=shoe.shape.collar&&x>0&&x<shoe.Ls&&(y>LF.geom.openingHeight(shoe.shape,x)||
          x<shoe.Ls*shoe.shape.openingEnd&&sim.near[i]>=0&&shoe.open[sim.near[i]]);
        if(!open)a.missing++;
        continue;
      }
      a.evaluated++;a.maxPressureKPa=Math.max(a.maxPressureKPa,sim.P[i]);
      if(!sim.pressureValid[i])a.invalid++;
      a.maxUnresolvedMm=Math.max(a.maxUnresolvedMm,sim.unresolvedInterference[i]);
    }
    const usableGapMm=usable&&finite(usable.frontXmm)&&finite(front)?usable.frontXmm-front:NaN;
    // Toe-room convention refers to the longest toe. Requiring 5mm along
    // every oblique little-toe ray incorrectly turns a narrow toe-box into
    // a length deficit; those other toe surfaces retain the local pressure gate.
    // E0 represents the longest anatomical toe tip. Its side edges are checked
    // by local toe pressure; their oblique rays are not longitudinal toe room.
    const tip=sim.lgap[measured.E0];
    const leadingTipGaps=finite(tip)?[tip]:tipGaps.filter(p=>p.x>=front-.5).map(p=>p.gap);
    const tipGapMm=smallestMean(leadingTipGaps),length={tipGapMm,usableGapMm,minMm:LIMITS.minToeGapMm,maxMm:LIMITS.maxToeGapMm};
    const metrics={length,zones:{},coverage:{},rankingCost:Infinity};
    if(!finite(usableGapMm)||!finite(tipGapMm))return failure(size,'unknown','앞코 내부 여유를 확인하기 어렵습니다.',metrics,quality);
    if(usableGapMm<LIMITS.minToeGapMm||tipGapMm<LIMITS.minToeGapMm)
      return failure(size,'tight','발끝 길이 여유가 부족합니다.',metrics,quality);
    if(usableGapMm>LIMITS.maxToeGapMm||tipGapMm>LIMITS.maxToeGapMm+LIMITS.maximumGapSpreadMm)
      return failure(size,'loose','발 길이에 비해 앞코가 너무 깁니다.',metrics,quality);
    // Four regional gap terms should not outvote useful toe room and favor a
    // short, very snug label. Give longitudinal comfort comparable weight to
    // the combined width/height terms, only after all hard fit gates pass.
    const unknown=[],tight=[],loose=[];let rankingCost=3*((usableGapMm-LIMITS.idealToeGapMm)/4)**2;
    for(const key of REGIONS) {
      const m=sim.metrics[key],a=regionStats[key],total=a.evaluated+a.missing;
      const missing=total?a.missing/total:1;metrics.coverage[key]=1-missing;
      if(!m||!a.evaluated){unknown.push(LABELS[key]);continue;}
      const tightLimit=(tol.Pzone[key]+tol.Ppain)/2;
      metrics.zones[key]={peakKPa:m.peakP,medianGapMm:m.medGap,unresolvedAreaFraction:m.unresolvedAreaFraction,
        maxPressureKPa:a.maxPressureKPa,maxUnresolvedMm:a.maxUnresolvedMm,invalidCount:a.invalid,tightLimitKPa:tightLimit,looseLimitMm:finite(tol.loose[key])?tol.loose[key]:null};
      if((key==='toeFront'||key==='toeBox'||key==='ball'||key==='instep')&&missing>LIMITS.maximumMissingForefootFraction)unknown.push(LABELS[key]);
      if(!m.pressureComplete||a.invalid||a.maxUnresolvedMm>LIMITS.maximumUnresolvedMm||m.peakP>tightLimit||a.maxPressureKPa>tol.Ppain)
        tight.push(LABELS[key]);
      if(key!=='toeFront'&&m.medGap>tol.loose[key])loose.push(LABELS[key]);
      // No average score can compensate for a failed local fit condition.
      // Among passing candidates prefer useful toe room and close, mild contact.
      const gapCost=key==='toeFront'?0:(m.medGap/Math.max(.5,tol.loose[key]))**2;
      rankingCost+=(key==='ball'?1.5:key==='heel'?1.2:1)*(gapCost+.35*(m.peakP/Math.max(1,tightLimit))**2);
    }
    metrics.rankingCost=rankingCost;
    if(tight.length)return failure(size,'tight',tight.join('·')+' 부위가 꽉 낍니다.',metrics,quality);
    if(unknown.length)return failure(size,'unknown',unknown.join('·')+' 내부 형상 확인이 필요합니다.',metrics,quality);
    if(loose.length)return failure(size,'loose',loose.join('·')+' 부위가 헐겁습니다.',metrics,quality);
    // The Dior viewer applies shared-layer, seam and bending constraints after
    // the local equilibrium solve. A size may not pass here if those same
    // constraints would turn its fitted surface into unresolved grey regions.
    if(quality==='full'&&LF.diorFit&&LF.diorFit.enabled(model)) {
      if(!LF.glbFit||!LF.Engine)return failure(size,'unknown','갑피 변형을 확인하지 못했습니다.',metrics,quality);
      const display={foot:measured,shoe,wornLast:worn.shoe,ctx,sim};
      display.compressedFpos=LF.sim.compressedFootPositions(measured,worn.shoe,sim,ctx);
      const deform=LF.Engine.prototype.shoeDeflection(display);
      const field=LF.diorFit.enhanceField(LF.glbFit.createDeformationField(display,deform.defl),display);
      if(!field||!field.shellStats||!field.pressureUnknown)return failure(size,'unknown','갑피 변형을 확인하지 못했습니다.',metrics,quality);
      let affected=0;
      for(let i=0;i<measured.n;i++) {
        if(sim.ex[i]||!REGIONS.includes(LF.geom.ZONE_KEYS[measured.zone[i]]))continue;
        let unresolved=0;
        if(sim.contactVertices&&sim.contactBary)for(let j=0;j<3;j++){
          const q=sim.contactVertices[i*3+j];if(q>=0)unresolved+=(field.pressureUnknown[q]||0)*sim.contactBary[i*3+j];
        }else if(sim.near[i]>=0)unresolved=field.pressureUnknown[sim.near[i]]||0;
        if(unresolved>.05)affected++;
      }
      metrics.sharedShell={remainingFlexiblePenetrationMm:field.shellStats.remainingFlexiblePenetrationMm,affectedFootSamples:affected};
      if(affected||field.shellStats.remainingFlexiblePenetrationMm>.20)
        return failure(size,'tight','갑피·봉제 구속으로 남는 압박이 있습니다.',metrics,quality);
    }
    return {size,acceptable:true,status:'fit',reason:'길이·볼·발등이 맞는 치수입니다.',metrics,quality};
  }
  async function recommend(options) {
    const current=typeof options.isCurrent==='function'?options.isCurrent:()=>true,
      progress=typeof options.onProgress==='function'?options.onProgress:()=>{},key=footprintKey(options),candidates=[];
    const finish=(status,size,reason)=>({status,size,reason,candidates,key,requiresVerification:status==='ready',
      source:'estimated-profile-screening-with-upper-contact-check',range:[230,300],step:5});
    if(!options.registration||!options.catalog||!options.model||!options.foot)
      return finish('unknown',null,'발과 제품 정보를 확인해 주세요.');
    const pref=safePref(options.pref||{}),sock=LF.data.SOCKS[pref.sock];
    if(!sock)return finish('unknown',null,'양말 정보를 확인해 주세요.');
    const candidateModels=new Map();
    for(let index=0;index<SIZES.length;index++) {
      if(!current())return finish('cancelled',null,'');
      const size=SIZES[index];progress({stage:'scan',completed:index,total:SIZES.length,size});await tick();
      if(!current())return finish('cancelled',null,'');
      try {
        const c=candidateModel(options.registration,options.model,options.catalog,size),st=LF.data.STATES.stand;
        const roughGap=c.sizing.innerLengthMm-Number(options.foot.length)*st.len*(pref.swell?1.005:1)-sock.t*2;
        let result;
        // The nominal toe allowance is only an early bound. A 2mm margin
        // keeps the geometric pass responsible for the final 5–18mm decision.
        if(roughGap<LIMITS.minToeGapMm-2)result=failure(size,'tight','발끝 길이 여유가 부족합니다.',{roughGapMm:roughGap});
        else if(roughGap>LIMITS.maxToeGapMm+2)result=failure(size,'loose','발 길이에 비해 앞코가 너무 깁니다.',{roughGapMm:roughGap});
        else {candidateModels.set(size,c.model);result=inspect({...options,model:c.model,size,pref,quality:'coarse'});}
        candidates.push(result);
      } catch(error) {candidates.push(failure(size,'unknown','해당 치수의 형상 기준이 부족합니다.'));}
    }
    // Check every length-plausible candidate at display resolution. A low
    // resolution hotspot must not hide a genuinely fitting label, or prove
    // that no size fits. Only obvious nominal-length bounds skip this pass.
    const shortlist=candidates.filter(c=>candidateModels.has(c.size))
      .sort((a,b)=>(a.metrics.rankingCost||Infinity)-(b.metrics.rankingCost||Infinity)||a.size-b.size);
    const verified=[];
    for(let index=0;index<shortlist.length;index++) {
      if(!current())return finish('cancelled',null,'');
      const candidate=shortlist[index];progress({stage:'verify',completed:index,total:shortlist.length,size:candidate.size});await tick();
      if(!current())return finish('cancelled',null,'');
      const full=inspect({...options,model:candidateModels.get(candidate.size),size:candidate.size,pref,quality:'full'});
      candidates[candidates.findIndex(c=>c.size===full.size)]=full;if(full.acceptable)verified.push(full);
    }
    if(!current())return finish('cancelled',null,'');
    verified.sort((a,b)=>a.metrics.rankingCost-b.metrics.rankingCost||a.size-b.size);
    if(verified.length)return finish('ready',verified[0].size,'길이·볼·발등을 함께 확인한 추정 치수입니다.');
    const plausible=candidates.filter(c=>c.metrics.length&&c.metrics.length.usableGapMm>=LIMITS.minToeGapMm&&c.metrics.length.usableGapMm<=LIMITS.maxToeGapMm),
      unknown=plausible.find(c=>c.status==='unknown')||candidates.find(c=>c.status==='unknown');
    if(unknown)return finish('unknown',null,unknown.reason);
    const result=finish('none',null,'');
    result.reasonDetails=[...new Set(plausible.map(c=>c.reason))];return result;
  }
  LF.sizeRecommendation={sizes:SIZES,limits:LIMITS,recommend,inspect,candidateModel,key:footprintKey};
})((window.LF=window.LF||{}));
