// Kinematic, unilateral insole contact. No body weight or plantar pressure is inferred.
(function (LF) {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, x) => { const t = clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
  // 0.08mm nominal contact plus 0.08mm discretization allowance. The tiny
  // allowance protects triangles between the sampled GLB support locations;
  // it is a numerical tolerance, not a foam layer or an upward-moving insole.
  const NOMINAL_CONTACT_MM=.08, SURFACE_MARGIN_MM=.08;
  const CLEARANCE = NOMINAL_CONTACT_MM+SURFACE_MARGIN_MM, MAX_SOFT_MM = 2, MAX_TOE_RADIANS = Math.PI / 15;
  const samplerCache=new WeakMap();

  function sourceOf(shoe) {
    const p=shoe.shape.supportBedProfile;
    return p && p.surfaceType==='nominated-support-top-envelope' ? 'geometry-derived-3d-support' :
      p && !p.isEstimated && p.verifiedCount ? 'longitudinal-geometry-with-estimated-width' : 'estimated-insole';
  }
  function bracket(values,x,key) {
    if(!values || !values.length || x<values[0][key] || x>values[values.length-1][key]) return null;
    let lo=0,hi=values.length-1;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(values[mid][key]<=x)lo=mid;else hi=mid;}
    if(values[lo][key]===x)return [values[lo],values[lo]];
    if(values[hi][key]===x)return [values[hi],values[hi]];
    return [values[lo],values[hi]];
  }
  function transverse(row,z) {
    if(!row.samples)return row.verified?row.height:null;
    const pair=bracket(row.samples,z,'z');if(!pair||!pair[0].verified||!pair[1].verified)return null;
    const [a,b]=pair,f=b.z===a.z?0:(z-a.z)/(b.z-a.z);return a.height*(1-f)+b.height*f;
  }
  function verifiedHeight(profile,x,z) {
    const pair=bracket(profile.points,x,'x');if(!pair)return null;
    const [a,b]=pair,ah=transverse(a,z),bh=transverse(b,z);
    if(ah==null||bh==null||b.x-a.x>profile.length*.1)return null;
    const f=b.x===a.x?0:(x-a.x)/(b.x-a.x);return ah*(1-f)+bh*f;
  }
  function sampler(shoe) {
    const T=shoe.shape;let cache=samplerCache.get(T);
    if(!cache){
      cache={sections:Array.from({length:193},(_,i)=>LF.geom.lastSection(T,clamp(i/192*T.Ls,.01,T.Ls-.01))),source:sourceOf(shoe)};
      samplerCache.set(T,cache);
    }
    return cache;
  }
  // A longitudinal floor trace does not measure its full transverse surface.
  // The unmeasured width and missing toe samples remain explicitly estimated.
  function sample(shoe, x, z) {
    const T=shoe.shape, profile=T.supportBedProfile;
    if(!profile || !profile.seatingPlane || !LF.supportBed || x<0 || x>T.Ls) return null;
    const cache=sampler(shoe),at=x/T.Ls*192,i=Math.min(191,Math.floor(at)),f=at-i;
    const a=cache.sections[i],b=cache.sections[i+1],center=a.c*(1-f)+b.c*f,radius=a.a*(1-f)+b.a*f,u=(z-center)/Math.max(.5,radius);
    if(Math.abs(u)>.985) return null;
    let h=verifiedHeight(profile,x,z),verified=h!=null;
    const fullSurface=profile.surfaceType==='nominated-support-top-envelope';
    if(!fullSurface && Math.abs(u)>.24) verified=false;
    if(h==null) h=profile.seatingPlane.offsetMm+profile.seatingPlane.slope*x;
    if(!Number.isFinite(h)) return null;
    return {height:h,verified,estimated:!verified,source:cache.source};
  }

  // Rotation at an approximate MTP joint, blended over a short transition.
  // The toe segment itself is rigid. The original measured mesh is never edited.
  function posePoint(ctx, x, y, z) {
    const p=ctx.plantarPose;
    if(!p || !p.toeAngleRadians || x<=p.blendStartX) return {x,y,z};
    const a=p.toeAngleRadians*smooth(p.blendStartX,p.blendEndX,x),c=Math.cos(a),s=Math.sin(a);
    return {x:p.pivotX+c*(x-p.pivotX)-s*(y-p.pivotY),y:p.pivotY+s*(x-p.pivotX)+c*(y-p.pivotY),z};
  }

  function solve(foot, shoe, ctx, seat) {
    const profile=shoe.shape.supportBedProfile;
    if(!profile || !profile.seatingPlane || !LF.supportBed) return false;
    const Z=LF.geom.Z,L=foot.L,pivotX=L*.72,pivotY=LF.geom.footSection(foot.shape,pivotX).ys;
    const points=[];
    for(let i=0;i<foot.n;i++) {
      if((foot.zone[i]!==Z.SOLE && foot.zone[i]!==Z.ARCH) || foot.nrm[i*3+1]>-.55 || foot.tv[i]<.025 || foot.tv[i]>.985) continue;
      const t=foot.tv[i];
      points.push({i,t,x:foot.pos[i*3]+foot.nrm[i*3]*ctx.sock,
        y:foot.pos[i*3+1]+foot.nrm[i*3+1]*ctx.sock,z:foot.pos[i*3+2]+foot.nrm[i*3+2]*ctx.sock,
        region:t>=.065&&t<=.28?'heel':t>=.62&&t<=.79?'ball':'other'});
    }
    const pose={pivotX,pivotY,blendStartX:pivotX,blendEndX:L*.8,toeAngleRadians:0,
      maxToeAngleRadians:MAX_TOE_RADIANS,maxSoftCompressionMm:MAX_SOFT_MM,clearanceMm:CLEARANCE,
      nominalContactMm:NOMINAL_CONTACT_MM,surfaceDiscretizationMarginMm:SURFACE_MARGIN_MM,
      model:'bounded-mtp-pose-and-unilateral-soft-contact',supportSource:sourceOf(shoe),
      forceModel:'kinematic-contact-no-bodyweight-or-plantar-pressure'};
    ctx.plantarPose=pose;ctx.seat=seat;
    const cy=Math.cos(seat.yawRadians||0),sy=Math.sin(seat.yawRadians||0),xOff=ctx.sock+.5+ctx.slide+seat.x;
    const evaluate=(pitch,angle,cloud)=>{
      pose.toeAngleRadians=angle;
      const c=Math.cos(pitch),s=Math.sin(pitch);let all=-Infinity,heel=-Infinity,ball=-Infinity,count=0,verified=0,unsupported=0;
      let sum=0;
      for(const q of cloud) {
        const p=posePoint(ctx,q.x,q.y,q.z),px=p.x+xOff,py=p.y+ctx.sock,xp=c*px-s*py;
        const x=cy*xp+sy*p.z,z=-sy*xp+cy*p.z+seat.z,h=sample(shoe,x,z);
        if(!h){unsupported++;continue;}
        const d=h.height-(s*px+c*py);all=Math.max(all,d);sum+=d;count++;if(h.verified)verified++;
        if(q.region==='heel')heel=Math.max(heel,d);if(q.region==='ball')ball=Math.max(ball,d);
      }
      if(!count || !Number.isFinite(heel) || !Number.isFinite(ball)) return null;
      const y=Math.max(heel,ball,all-MAX_SOFT_MM)+CLEARANCE;
      const heelGap=y-heel,ballGap=y-ball;
      // Bearing contact dominates. Toe articulation and soft flattening are
      // used only as much as needed, and cannot move the insole or scale a foot.
      const cost=Math.max(0,heelGap-CLEARANCE-.04)**2+Math.max(0,ballGap-CLEARANCE-.04)**2+
        .1*(angle/MAX_TOE_RADIANS)**2+.012*Math.max(0,all+CLEARANCE-y)**2;
      return {pitch,angle,y,cost,heelGap,ballGap,count,verified,unsupported,meanGap:y-sum/count,maxCompression:Math.max(0,all+CLEARANCE-y)};
    };
    const sparse=points.filter((q,k)=>k%5===0),reference=profile.seatingPlane.pitchRadians;
    let best=null;
    for(let pitch=Math.max(-.14,reference-.1);pitch<=Math.min(.14,reference+.1)+1e-7;pitch+=.006)
      for(let angle=0;angle<=MAX_TOE_RADIANS+1e-7;angle+=MAX_TOE_RADIANS/12) {
        const r=evaluate(pitch,angle,sparse);if(r && (!best || r.cost<best.cost))best=r;
      }
    if(!best){delete ctx.plantarPose;return false;}
    let fine=null;
    for(let pitch=best.pitch-.008;pitch<=best.pitch+.008+1e-7;pitch+=.001)
      for(let angle=Math.max(0,best.angle-MAX_TOE_RADIANS/10);angle<=Math.min(MAX_TOE_RADIANS,best.angle+MAX_TOE_RADIANS/10)+1e-7;angle+=MAX_TOE_RADIANS/60) {
        const r=evaluate(pitch,angle,points);if(r && (!fine || r.cost<fine.cost))fine=r;
      }
    best=fine||evaluate(best.pitch,best.angle,points);
    seat.pitchRadians=best.pitch;seat.y=best.y;seat.source=profile.source||'estimated-insole';
    seat.supportSurface=profile.surfaceType||'longitudinal-profile';seat.plantarSampleCount=points.length;
    pose.toeAngleRadians=best.angle;
    pose.diagnostics={heelBearingGapMm:best.heelGap,ballBearingGapMm:best.ballGap,
      maxSoftCompressionMm:best.maxCompression,supportedSamples:best.count,verifiedSamples:best.verified,
      estimatedSamples:best.count-best.verified,unsupportedSamples:best.unsupported,
      contactLimited:best.heelGap>.5 || best.ballGap>.5 || best.unsupported>points.length*.1};
    // Kept only on this simulation context; no product or source nodes mutate.
    Object.defineProperty(pose,'shoe',{value:shoe,enumerable:false});
    return true;
  }

  function constrainPoint(ctx, p) {
    const pose=ctx.plantarPose;if(!pose || !pose.shoe) return p;
    const support=sample(pose.shoe,p.x,p.z);if(!support)return p;
    // A unilateral contact: only a penetration moves the plantar soft surface.
    // Unsupported arch gaps remain; neither an insole nor a foot is pulled shut.
    const penetration=support.height+pose.clearanceMm-p.y;
    if(penetration>0 && penetration<=pose.maxSoftCompressionMm+.01) return {x:p.x,y:p.y+penetration,z:p.z};
    return p;
  }

  function surfaceGeometry(shoe) {
    const T=shoe.shape,p=T.supportBedProfile;if(!p || !p.seatingPlane)return null;
    const rows=65,columns=17,positions=new Float32Array(rows*columns*3),verifiedMask=new Uint8Array(rows*columns),estimatedMask=new Uint8Array(rows*columns),indices=[];
    for(let r=0;r<rows;r++) {
      const x=(.025+.95*r/(rows-1))*T.Ls,sec=LF.geom.lastSection(T,x);
      for(let c=0;c<columns;c++) {
        const z=sec.c+(c/(columns-1)*2-1)*sec.a*.975,q=sample(shoe,x,z),i=r*columns+c;
        positions[i*3]=x;positions[i*3+1]=q?q.height:p.seatingPlane.offsetMm+p.seatingPlane.slope*x;positions[i*3+2]=z;
        verifiedMask[i]=q&&q.verified?1:0;estimatedMask[i]=q&&!q.verified?1:0;
        if(r<rows-1 && c<columns-1){const a=i,b=i+columns;indices.push(a,b,a+1,a+1,b,b+1);}
      }
    }
    return {positions,indices:new Uint32Array(indices),verifiedMask,estimatedMask,source:sourceOf(shoe),
      sourceProfile:p.source,physicalModel:'fixed-insole-unilateral-contact',measurement:'file-geometry-inference-not-measured-interior'};
  }
  LF.plantarContact={solve,posePoint,constrainPoint,sample,surfaceGeometry,sourceOf,
    assumptions:{clearanceMm:CLEARANCE,nominalContactMm:NOMINAL_CONTACT_MM,surfaceDiscretizationMarginMm:SURFACE_MARGIN_MM,
      maxSoftCompressionMm:MAX_SOFT_MM,maxToeAngleRadians:MAX_TOE_RADIANS}};
})((window.LF=window.LF||{}));
