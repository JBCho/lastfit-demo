// Infer a shoe's support surface from actual inner layers, never from an outer roof.
(function (LF) {
  'use strict';
  function orientation(item) {
    if (!item.toCanonical) return 1;
    const o = item.toCanonical([0,0,0]);
    const a = item.toCanonical([1,0,0]), b = item.toCanonical([0,1,0]), c = item.toCanonical([0,0,1]);
    const v = [a,b,c].map(p => [p.x-o.x,p.y-o.y,p.z-o.z]);
    const [x,y,z]=v;
    return x[0]*(y[1]*z[2]-y[2]*z[1])-x[1]*(y[0]*z[2]-y[2]*z[0])+x[2]*(y[0]*z[1]-y[1]*z[0]) < 0 ? -1 : 1;
  }
  function lateralHeight(row, z) {
    const samples=row.samples;
    if(!samples || !Number.isFinite(z)) return row.verified ? row.height : null;
    let a=null,b=null;
    for(const sample of samples) {
      if(sample.z<=z) a=sample;
      if(sample.z>=z) {b=sample;break;}
    }
    // Interpolate only directly adjacent measured samples. A missing support
    // edge stays unverified, rather than extending a sole underneath the upper.
    if(!a || !b || !a.verified || !b.verified) return null;
    const f=b.z===a.z?0:(z-a.z)/(b.z-a.z);
    return a.height*(1-f)+b.height*f;
  }
  function heightAt(profile, x, verifiedOnly = false, z) {
    if (!profile || !profile.seatingPlane) return null;
    const rows = profile.points;
    let a = null, b = null;
    for (const row of rows) {
      if (row.x <= x) a = row;
      if (row.x >= x) { b = row; break; }
    }
    const ah=a && lateralHeight(a,z),bh=b && lateralHeight(b,z);
    if (a && b && ah!=null && bh!=null && b.x-a.x <= profile.length * .1) {
      const f = b.x === a.x ? 0 : (x-a.x)/(b.x-a.x);
      return ah*(1-f)+bh*f;
    }
    if (verifiedOnly) return null;
    return profile.seatingPlane.offsetMm + profile.seatingPlane.slope*x;
  }
  function seatingPlane(points, length) {
    const valid=points.filter(p=>p.verified && p.t>=.12 && p.t<=.72);
    if(valid.length<5) return null;
    const meanX=valid.reduce((s,p)=>s+p.x,0)/valid.length,meanY=valid.reduce((s,p)=>s+p.height,0)/valid.length;
    let numerator=0,denominator=0;
    for(const p of valid){numerator+=(p.x-meanX)*(p.height-meanY);denominator+=(p.x-meanX)**2;}
    const slope=Math.max(-.12,Math.min(.12,numerator/denominator)),offsetMm=meanY-slope*meanX;
    return {slope,offsetMm,pitchRadians:Math.atan(slope),source:'file-geometry-inferred',residualMm:Math.max(...valid.map(p=>Math.abs(p.height-offsetMm-slope*p.x)))};
  }
  // A nominated sole can be exported with reversed triangle winding. Its
  // actual top surface is the highest vertical intersection at each (x,z),
  // not the lowest face whose stored normal happens to point upward.
  function topEnvelope(registration, supportMeshes, selected, supportNormalSign) {
    const length=registration.productInput.length;
    const rows=registration.contour.points.map(outline=>({t:outline.t,x:outline.t*length,centerZ:outline.center,
      samples:Array.from({length:17},(_,i)=>({z:outline.center+(i/16-.5)*outline.width,height:null,undersideHeight:null,topNormal:null,bottomNormal:null,verified:false}))}));
    for(const item of supportMeshes) {
      const p=item.canonicalPositions,ix=item.mesh.geometry.index;
      const count=ix?ix.count:p.length/3,at=k=>ix?ix.getX?ix.getX(k):ix.array[k]:k;
      for(let k=0;k+2<count;k+=3) {
        const a=at(k)*3,b=at(k+1)*3,c=at(k+2)*3;
        const ax=p[a],az=p[a+2],bx=p[b]-ax,bz=p[b+2]-az,cx=p[c]-ax,cz=p[c+2]-az;
        const determinant=bx*cz-bz*cx;
        if(Math.abs(determinant)<1e-7)continue;
        const by=p[b+1]-p[a+1],cy=p[c+1]-p[a+1];
        const ny=-determinant/Math.hypot(by*cz-bz*cy,determinant,bx*cy-by*cx);
        if(Math.abs(ny)<.2)continue;
        const minX=Math.min(ax,p[b],p[c]),maxX=Math.max(ax,p[b],p[c]);
        const minZ=Math.min(az,p[b+2],p[c+2]),maxZ=Math.max(az,p[b+2],p[c+2]);
        for(const row of rows) {
          if(row.x<minX-1e-5 || row.x>maxX+1e-5)continue;
          for(const sample of row.samples) {
            if(sample.z<minZ-1e-5 || sample.z>maxZ+1e-5)continue;
            const dx=row.x-ax,dz=sample.z-az;
            const u=(dx*cz-dz*cx)/determinant,v=(bx*dz-bz*dx)/determinant;
            if(u<-.00001 || v<-.00001 || u+v>1.00001)continue;
            const height=p[a+1]+u*by+v*cy;
            if(sample.height==null || height>sample.height){sample.height=height;sample.topNormal=ny;}
            if(sample.undersideHeight==null || height<sample.undersideHeight){sample.undersideHeight=height;sample.bottomNormal=ny;}
          }
        }
      }
    }
    const points=rows.map(row=>{
      for(const sample of row.samples) {
        // At a perimeter ray only the underside may exist. Do not promote it
        // to an insole: a nominated solid sole needs both opposing sheets.
        sample.verified=sample.height!=null && sample.undersideHeight!=null &&
          sample.height-sample.undersideHeight>.2 && sample.topNormal*sample.bottomNormal<0;
        sample.thicknessMm=sample.verified?sample.height-sample.undersideHeight:null;
        if(!sample.verified)sample.height=null;
        delete sample.topNormal;delete sample.bottomNormal;
      }
      const center=row.samples[8];
      return {...row,height:center.height,verified:center.verified};
    });
    const plane=seatingPlane(points,length),valid=points.filter(p=>p.verified);
    return {source:plane?'file-geometry-inferred':'unavailable-inner-support',surfaceType:'nominated-support-top-envelope',
      length,points,seatingPlane:plane,verifiedCount:valid.length,
      verifiedSurfaceCount:points.reduce((sum,row)=>sum+row.samples.filter(s=>s.verified).length,0),
      coverage:valid.length?valid[valid.length-1].t-valid[0].t:0,
      supportMeshIndices:selected.slice(),supportNormalSign,
      normalPolicy:'highest-vertical-intersection-independent-of-export-winding'};
  }
  function infer(registration) {
    const length = registration.productInput.length, rows = [];
    const options=registration.calibration && registration.calibration.options || {};
    // Some assembled models identify their inner sole separately from the
    // tongue and laces. Only those nominated source meshes can establish the
    // support surface; a second upward-facing upper must not become a footbed.
    const selected=options.supportMeshIndices;
    if(selected!=null && (!Array.isArray(selected) || !selected.length || selected.some(index=>!Number.isInteger(index) || !registration.meshes.some(item=>item.sourceMeshIndex===index))))
      throw new RangeError('지지면 메시 번호가 착화 대상에 포함되어 있지 않습니다.');
    const supportMeshes=selected==null ? registration.meshes : registration.meshes.filter(item=>selected.includes(item.sourceMeshIndex));
    // Mirrored exports can reverse the stored triangle winding independently
    // of the node transform. Correct only a documented source discrepancy.
    const supportNormalSign=options.supportNormalSign==null ? 1 : Number(options.supportNormalSign);
    if(supportNormalSign!==1 && supportNormalSign!==-1)throw new RangeError('지지면 방향 보정은 1 또는 -1이어야 합니다.');
    if(options.supportSurface==='top-envelope') {
      if(!selected)throw new RangeError('지지면 상면 추출에는 확인된 바닥 메시 번호가 필요합니다.');
      return topEnvelope(registration,supportMeshes,selected,supportNormalSign);
    }
    if(options.supportSurface!=null)throw new RangeError('지원하지 않는 지지면 추출 방식입니다.');
    for (let t=.08; t<=.94001; t+=.04) {
      const i=Math.round(t*64), outline=registration.contour.points[i];
      const probes=[-.12,0,.12].map(f=>({z:outline.center+f*outline.width,hits:[]}));
      rows.push({t,x:t*length,probes});
    }
    // A single exterior shell supplies no measured insole. A model may opt in
    // to the existing, explicitly estimated insole at canonical y=0, so sizing
    // and placement share that frame without inventing verified floor samples.
    if(options.supportBedSource==='estimated-flat-insole') {
      return {source:'estimated-flat-insole',isEstimated:true,length,verifiedCount:0,coverage:0,
        points:rows.map(row=>({t:row.t,x:row.x,height:null,verified:false})),
        seatingPlane:{slope:0,offsetMm:0,pitchRadians:0,source:'estimated-flat-insole',isEstimated:true,residualMm:null}};
    }
    for (const item of supportMeshes) {
      const p=item.canonicalPositions, ix=item.mesh.geometry.index;
      const count=ix ? ix.count : p.length/3, at=k=>ix ? ix.getX ? ix.getX(k) : ix.array[k] : k, sign=orientation(item)*supportNormalSign;
      for (let k=0;k+2<count;k+=3) {
        const a=at(k)*3,b=at(k+1)*3,c=at(k+2)*3;
        const ax=p[a],az=p[a+2],bx=p[b]-ax,bz=p[b+2]-az,cx=p[c]-ax,cz=p[c+2]-az;
        const determinant=bx*cz-bz*cx;
        if (Math.abs(determinant)<1e-7) continue;
        const by=p[b+1]-p[a+1],cy=p[c+1]-p[a+1];
        const ny=-determinant*sign/Math.hypot(by*cz-bz*cy,determinant,bx*cy-by*cx);
        if (Math.abs(ny)<.02) continue;
        const minX=Math.min(ax,p[b],p[c]),maxX=Math.max(ax,p[b],p[c]);
        const minZ=Math.min(az,p[b+2],p[c+2]),maxZ=Math.max(az,p[b+2],p[c+2]);
        for (const row of rows) {
          if (row.x<minX-1e-5 || row.x>maxX+1e-5) continue;
          for (const probe of row.probes) {
            if (probe.z<minZ-1e-5 || probe.z>maxZ+1e-5) continue;
            const dx=row.x-ax,dz=probe.z-az;
            const u=(dx*cz-dz*cx)/determinant,v=(bx*dz-bz*dx)/determinant;
            if (u<-.00001 || v<-.00001 || u+v>1.00001) continue;
            probe.hits.push({y:p[a+1]+u*by+v*cy,ny});
          }
        }
      }
    }
    const points=rows.map(row=>{
      const heights=[];
      for(const probe of row.probes) {
        const hits=probe.hits.sort((a,b)=>a.y-b.y),unique=[];
        for(const hit of hits) if (!unique.length || hit.y-unique[unique.length-1].y>.2) unique.push(hit);
        for(let j=0;j<unique.length;j++) {
          const floor=unique[j];
          if(floor.ny<.65 || floor.y>registration.dimensions.height*.5) continue;
          const above=unique.slice(j+1),roof=above.find(h=>h.ny<-.02 && h.y-floor.y>=6);
          const paired=roof && above.some(h=>h.ny>.02 && h.y>=roof.y-.2 && h.y-roof.y<=30);
          const openHeel=row.t<=.32 && !above.some(h=>h.y-floor.y<6);
          if(paired || openHeel) {heights.push(floor.y);break;}
        }
      }
      heights.sort((a,b)=>a-b);
      return {t:row.t,x:row.x,height:heights.length>=2 ? heights[Math.floor(heights.length/2)] : null,verified:heights.length>=2};
    });
    // A heel collar lip can face upward in the same ray as the floor. Reject a
    // one-row jump incompatible with adjacent support before fixing any vertices.
    for(let i=0;i<points.length;i++) if(points[i].verified) {
      const neighbours=points.filter((p,j)=>p.verified&&j!==i&&Math.abs(p.t-points[i].t)<=.121);
      if(neighbours.length>=2) {
        const hs=neighbours.map(p=>p.height).sort((a,b)=>a-b),median=hs[Math.floor(hs.length/2)];
        if(Math.abs(points[i].height-median)>12) {points[i].verified=false;points[i].height=null;}
      }
    }
    const valid=points.filter(p=>p.verified && p.t>=.12 && p.t<=.72);
    if(valid.length<5) return {source:'unavailable-inner-support',length,points,seatingPlane:null,verifiedCount:points.filter(p=>p.verified).length,supportMeshIndices:selected && selected.slice()};
    const plane=seatingPlane(points,length);
    return {source:'file-geometry-inferred',length,points,seatingPlane:plane,verifiedCount:points.filter(p=>p.verified).length,coverage:valid[valid.length-1].t-valid[0].t,supportMeshIndices:selected && selected.slice(),supportNormalSign};
  }
  function attach(registration) {
    const profile=infer(registration);
    registration.supportBedProfile=profile;
    if(!profile.seatingPlane) return registration;
    registration.productInput.supportBedProfile=profile;
    registration.calibration.supportSource=profile.source;
    registration.calibration.seatingPlane=profile.seatingPlane;
    for(const item of registration.meshes) {
      const p=item.canonicalPositions,mask=new Uint8Array(p.length/3);
      const nominatedSole=profile.surfaceType==='nominated-support-top-envelope' && profile.supportMeshIndices.includes(item.sourceMeshIndex);
      for(let k=0;k<mask.length;k++) {
        const h=heightAt(profile,p[k*3],true,p[k*3+2]);
        if(nominatedSole || p[k*3+1]<=0 || h!=null && p[k*3+1]<=h+.5) mask[k]=1;
      }
      item.fixedSoleMask=mask;
    }
    return registration;
  }
  LF.supportBed={infer,attach,heightAt};
})((window.LF=window.LF||{}));
