// Fixed product-specific demo lasts, independent of the visitor's measurements.
// The source asset is an exterior display model, not an interior scan. This
// factory-last assumption is calibrated to the agreed 270 / 262mm demo fit.
// It changes only the inferred cavity; source vertices and the support stay put.
(function (LF) {
  'use strict';
  const PROFILE='dior-reference-last-v1', TAU=Math.PI*2;
  const referenceSurfaces=new WeakMap();
  const REFERENCE=Object.freeze({length:262,ballWidth:94,heelWidth:62,instepHeight:54,
    archHeight:.5,toeHeight:18,toeShape:'egyptian',bunion:0});
  const HIGH_PROFILE='jordan-high-reference-last-v1';
  // Both reference feet use the same nominal anchor, not the visitor's foot.
  // Clearances and bounded exterior-shape blending are explicit demo priors,
  // not manufacturer interior dimensions or claims about all AJ1 High SKUs.
  const DEFINITIONS={
    [PROFILE]:{clearance:{medial:1,lateral:1,dorsal:2,heel:.8},sourceShapeWeight:0},
    [HIGH_PROFILE]:{clearance:{medial:.7,lateral:.9,dorsal:1.6,heel:.6},sourceShapeWeight:.2,maxSourceDeviationMm:2},
  };
  const PREF=Object.freeze({usage:'daily',style:0,sock:'regular',lacing:.85,days:0,snugWear:true,
    swell:false,sens:Object.freeze({bunion:false,tailor:false,instep:false,heel:false})});
  const copy=v=>JSON.parse(JSON.stringify(v));
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};

  // Construct directly instead of registering a catalog product or incrementing
  // a product revision. No current user's foot, preferences or model is read.
  function sourceModel(registration) {
    const p=registration.productInput,base=LF.data.SHOES[0];
    return {...base,id:'fixed-dior-reference-last',referenceSize:p.referenceSize,
      allow:p.length-p.referenceSize,ball:p.width,heel:p.heelWidth,instep:p.instepHeight,toeBoxH:p.toeHeight,
      toeShape:p.toeShape||'round',toe:{start:.74,pm:5,pl:2.3,tipS:.62,front:22},
      collar:{...base.collar,...p.collar},upper:'leather',counter:'counter_medium',insole:'insole_eva',
      toecap:null,toecapLen:0,arch:0,cup:0,widths:[0],lacing:true,
      silhouetteProfile:p.silhouetteProfile,heightProfile:p.heightProfile,radialProfile:p.radialProfile,
      supportBedProfile:p.supportBedProfile,glbCalibration:p.glbCalibration};
  }
  function sliceWidth(positions,indices,x) {
    let min=Infinity,max=-Infinity;
    for(let i=0;i<indices.length;i+=3)for(let e=0;e<3;e++) {
      const a=indices[i+e]*3,b=indices[i+(e+1)%3]*3,dx=positions[b]-positions[a];
      if(Math.abs(dx)<1e-8 || x<Math.min(positions[a],positions[b]) || x>Math.max(positions[a],positions[b]))continue;
      const f=(x-positions[a])/dx,z=positions[a+2]+(positions[b+2]-positions[a+2])*f;
      min=Math.min(min,z);max=Math.max(max,z);
    }
    return Number.isFinite(min)&&max>min?{min,max}:null;
  }
  function apply(registration,catalog) {
    const cal=registration&&registration.calibration;
    const selected=cal&&cal.options&&cal.options.cavityProfile || catalog&&catalog.calibration&&catalog.calibration.cavityProfile;
    const definition=DEFINITIONS[selected];
    if(!definition || !registration.radialProfile || !LF.sim || !LF.contactDrape || !LF.product)return null;
    const source=registration.radialProfile;
    if(source.referenceLast&&source.referenceLast.profile===selected)return {profile:source,metadata:source.referenceLast};
    const scale=Number(cal.usableGeometry&&cal.usableGeometry.targetLengthMm||274)/274;
    if(!(scale>.65&&scale<1.4))throw new RangeError('Dior reference-last grading is outside its estimated range.');
    const measurements={...REFERENCE};
    for(const key of ['length','ballWidth','heelWidth','instepHeight','toeHeight'])measurements[key]*=scale;
    const model=sourceModel(registration),foot=LF.geom.buildFoot(measurements,LF.data.STATES.stand,104,60);
    const shoe=LF.geom.buildLast(model,model.referenceSize,0,PREF.lacing,116,60),ctx=LF.sim.context(model,'stand',PREF);
    shoe.model=model;shoe.mats=LF.sim.materialTable(model,PREF.lacing);
    const worn=LF.sim.prepareWorn(foot,shoe,ctx),lastPositions=worn.fpos.slice();
    referenceSurfaces.set(registration,LF.contactDrape.createCollider(worn.fpos.slice(),LF.geom.gridIndex(foot)));
    let referenceFront=-Infinity;
    for(let i=0;i<foot.n;i++)referenceFront=Math.max(referenceFront,lastPositions[i*3]);
    const usableFront=Number(cal.usableGeometry&&cal.usableGeometry.frontXmm);
    const toeAllowance=Number.isFinite(usableFront)?Math.max(0,usableFront-referenceFront):11*scale;
    // A factory last has toe allowance beyond the reference foot. Extend its
    // forefoot longitudinally, retaining the fixed toe silhouette and the source
    // product's front station rather than inflating the visitor's toes.
    for(let i=0;i<foot.n;i++)lastPositions[i*3]+=toeAllowance*smooth(.72,.97,foot.tv[i]);
    const referenceIndices=LF.geom.gridIndex(foot),collider=LF.contactDrape.createCollider(lastPositions,referenceIndices);
    const profile=copy(source),length=registration.productInput.length;
    let adjusted=0,maxOutward=0,maxInward=0,retainedFloor=0,retainedOpening=0;
    for(let r=0;r<profile.points.length;r++) {
      const row=profile.points[r],original=source.points[r],x=row.t*length,footWidth=sliceWidth(lastPositions,referenceIndices,x);
      const floorPoints=original.ring.filter((p,j)=>original.boundary&&original.boundary[j]==='support-floor');
      const floorMin=floorPoints.length?Math.min(...floorPoints.map(p=>p[1])):row.centerZ;
      const floorMax=floorPoints.length?Math.max(...floorPoints.map(p=>p[1])):row.centerZ;
      // Keep the actual toe cap and manufacturer-reference length. The last's
      // short reference toes cannot replace the product's useful toe allowance.
      const toeBlend=1-smooth(.95,.985,row.t),heelBlend=smooth(.015,.065,row.t),blend=toeBlend*heelBlend;
      if(blend<.00001)continue;
      for(let j=0;j<profile.nt;j++) {
        const theta=TAU*j/profile.nt,dy=Math.sin(theta),dz=Math.cos(theta),sourcePoint=original.ring[j];
        const isFloor=original.boundary&&original.boundary[j]==='support-floor';
        const boundary=original.boundary&&original.boundary[j];
        const isOpen=original.open&&original.open[j] || boundary==='rear-open-collar' ||
          boundary==='fallback-open-or-missing' && dy>0 && row.t<(model.collar.throat+.05);
        if(isFloor){
          // The support plane's height is immutable. Its radial sampling can
          // nevertheless create a narrow artificial corner above a broad sole.
          // Join that flat computational plane to the fixed last's footprint;
          // no source sole or insole vertex is moved and arch space stays open.
          if(footWidth) {
            const side=sourcePoint[1]>=row.centerZ,oldEdge=side?floorMax:floorMin;
            const referenceEdge=side?footWidth.max+scale:footWidth.min-scale;
            const targetEdge=side?Math.max(oldEdge,referenceEdge):Math.min(oldEdge,referenceEdge);
            const ratio=Math.abs(oldEdge-row.centerZ)>1e-5?(sourcePoint[1]-row.centerZ)/(oldEdge-row.centerZ):0;
            row.ring[j]=[sourcePoint[0],sourcePoint[1]+(targetEdge-oldEdge)*ratio*blend];
          }
          retainedFloor++;continue;
        }
        // Missing-ray collar vertices remain open. Their coordinates still
        // follow the reference last so an adjacent closed rim cannot inherit
        // the old fallback ellipse's artificial inward bridge.
        if(isOpen)retainedOpening++;
        const hits=[];collider.raycast(x,row.centerY,row.centerZ,0,dy,dz,Infinity,null,hits);
        if(!hits.length)continue;
        const refRadius=Math.max(...hits);
        if(!(refRadius>.05))continue;
        const y=row.centerY+dy*refRadius,z=row.centerZ+dz*refRadius;
        // Retain the anatomical arch gap, not every downward-facing sidewall.
        // Treating the lower ball as an arch left an inward notch between its
        // corrected upper side and the fixed floor, creating false collisions.
        const hit=collider.query(x,y,z);
        const archWeight=hit&&hit.triangle.reduce((sum,k,i)=>sum+(foot.zone[k]===LF.geom.Z.ARCH?hit.barycentric[i]:0),0);
        // The High's inset medial decorative wall crosses the anatomical arch.
        // Only its measured support-floor is an immutable boundary; reconstruct
        // the sidewall around the fixed last rather than preserving that notch.
        if(selected===PROFILE && dy<-.02 && hit&&hit.normal.y<-.5&&archWeight>.5){retainedFloor++;continue;}
        const heel=1-smooth(.22,.34,row.t),dorsal=smooth(.1,.85,Math.max(0,dy));
        const allowances=definition.clearance,sideAllowance=dz>=0?allowances.medial:allowances.lateral;
        const clearance=((1-dorsal)*sideAllowance+dorsal*allowances.dorsal)*(1-heel)+allowances.heel*heel;
        const oldRadius=Math.hypot(sourcePoint[0]-row.centerY,sourcePoint[1]-row.centerZ);
        // Clearance is a normal distance. A 1mm radial offset next to an
        // oblique heel/ball face can leave only a fraction of that clearance.
        const incidence=hit?Math.abs(hit.normal.y*dy+hit.normal.z*dz):1;
        const samplingMargin=.1*scale;
        let target=refRadius+(clearance*scale+samplingMargin)/Math.max(.3,incidence);
        // Keep a bounded amount of the High's own forefoot taper/asymmetry.
        // Its tall tongue must not become dorsal free space or an ankle roof.
        if(definition.sourceShapeWeight && row.t>.6) {
          const residual=clamp(oldRadius-target,-definition.maxSourceDeviationMm*scale,definition.maxSourceDeviationMm*scale);
          target+=residual*definition.sourceShapeWeight*smooth(.6,.73,row.t);
        }
        if(dy<-.000001)target=Math.min(target,Math.max(0,(row.floorY-row.centerY)/dy));
        const radius=oldRadius+(target-oldRadius)*blend;
        row.ring[j]=[Math.max(row.floorY,row.centerY+dy*radius),row.centerZ+dz*radius];
        if(!isOpen)row.boundary[j]='estimated-fixed-reference-last';
        // Confidence is explicit: a reference fit is not an observed interior.
        if(row.valid)row.valid[j]=0;
        adjusted++;maxOutward=Math.max(maxOutward,radius-oldRadius);maxInward=Math.max(maxInward,oldRadius-radius);
      }
    }
    const metadata={profile:selected,source:'fixed-factory-last-demo-assumption',isMeasured:false,
      referenceNominalSizeMm:270,referenceFootMm:{...REFERENCE},gradeScale:scale,
      referencePose:{...ctx.seat},clearanceMm:selected===PROFILE?{side:1,dorsal:2,heel:.8}:{...definition.clearance},
      sourceShapeWeight:definition.sourceShapeWeight,maxSourceDeviationMm:definition.maxSourceDeviationMm||0,
      samplingMarginMm:.1*scale,referenceToeAllowanceMm:toeAllowance,
      sourceExteriorUnchanged:true,supportUnchanged:true,independentOfUserInput:true,
      toeAllowanceSource:'source-GLB-and-Nike-chart-estimate',adjustedSamples:adjusted,
      maximumOutwardCorrectionMm:maxOutward,maximumInwardCorrectionMm:maxInward,
      retainedSupportSamples:retainedFloor,retainedOpeningSamples:retainedOpening};
    profile.source=selected;profile.internalSource='fixed-reference-last-not-an-interior-measurement';
    profile.referenceLast=metadata;
    registration.radialProfile=profile;registration.productInput.radialProfile=profile;
    cal.cavityCorrection=metadata;cal.cavityReferenceLast=metadata;cal.internalSource=profile.internalSource;
    registration.productInput.glbCalibration=cal;
    return {profile,metadata};
  }
  LF.diorCavity={PROFILE,HIGH_PROFILE,REFERENCE,apply,referenceSurface:registration=>referenceSurfaces.get(registration)||null};
})((window.LF=window.LF||{}));
