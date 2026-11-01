// Reconstruct invalid decorative inner panels for the fixed, calibrated Dior
// wearing last. This is model preparation, separate from elastic shoe stretch.
(function(LF){
  'use strict';
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  function sample(profile,L,x,y,z){
    const at=clamp(x/L,0,1)*(profile.points.length-1),i=Math.min(profile.points.length-2,Math.floor(at)),f=at-i;
    const a=profile.points[i],b=profile.points[i+1],cy=a.centerY*(1-f)+b.centerY*f,cz=a.centerZ*(1-f)+b.centerZ*f;
    const dy=y-cy,dz=z-cz,r=Math.hypot(dy,dz),angle=(Math.atan2(dy,dz)+Math.PI*2)%(Math.PI*2);
    const atAngle=angle/(Math.PI*2)*profile.nt,j=Math.floor(atAngle)%profile.nt,k=(j+1)%profile.nt,v=atAngle-Math.floor(atAngle);
    const coord=d=>(a.ring[j][d]*(1-v)+a.ring[k][d]*v)*(1-f)+(b.ring[j][d]*(1-v)+b.ring[k][d]*v)*f;
    const iy=coord(0),iz=coord(1),target=Math.hypot(iy-cy,iz-cz)+.35;
    const outerAt=row=>row.outerRadius&&Number.isFinite(row.outerRadius[j])&&Number.isFinite(row.outerRadius[k])?
      row.outerRadius[j]*(1-v)+row.outerRadius[k]*v:null;
    const oa=outerAt(a),ob=outerAt(b),outer=oa!=null&&ob!=null?oa*(1-f)+ob*f:null;
    return{cy,cz,r,target,uy:r>1e-7?dy/r:1,uz:r>1e-7?dz/r:0,deep:outer!=null&&target-r>4&&outer-r>4,outer};
  }
  function prepare(registration,source,index,fixed){
    const profile=registration.productInput.radialProfile,L=registration.productInput.length;
    if(!profile||!['dior-reference-last-v1','jordan-high-reference-last-v1'].includes(profile.source))return null;
    const positions=source.slice(),deep=new Uint8Array(source.length/3);
    const collider=LF.diorCavity.referenceSurface(registration),clearance=1.0;
    const query={point:{},normal:{},triangle:[],barycentric:[]};
    let moved=0,maxPreparationMm=0,maxOuterPreparationMm=0;
    for(let k=0;k<deep.length;k++){
      const o=k*3,x=source[o],y=source[o+1],z=source[o+2];
      if(fixed&&fixed[k]||x<=0||x>=L)continue;
      const s=sample(profile,L,x,y,z);deep[k]=+s.deep;
      if(!collider)continue;
      const contact=collider.query(x,y,z,query);
      if(contact.signedDistance>=clearance)continue;
      // Resolve against the fixed product reference surface rather than using
      // a long polar ray across the open ankle. This repairs the old rim and
      // inner panels locally without ballooning valid exterior decoration.
      const change=clearance-contact.signedDistance;
      positions[o]=x+contact.normal.x*change;
      positions[o+1]=y+contact.normal.y*change;positions[o+2]=z+contact.normal.z*change;
      moved++;maxPreparationMm=Math.max(maxPreparationMm,change);
      if(s.outer==null||s.outer-s.r<1)maxOuterPreparationMm=Math.max(maxOuterPreparationMm,change);
    }
    const kept=[],count=index?index.count:source.length/3,at=i=>index?(index.getX?index.getX(i):index.array[i]):i;
    for(let i=0;i+2<count;i+=3){
      const ids=[at(i),at(i+1),at(i+2)];
      const allFixed=fixed&&ids.every(k=>fixed[k]);
      const p=[0,0,0];for(const k of ids)for(let d=0;d<3;d++)p[d]+=source[k*3+d]/3;
      const crossesInvalidPanel=!allFixed&&ids.some(k=>deep[k])&&p[0]>0&&p[0]<L&&sample(profile,L,...p).deep;
      if(!crossesInvalidPanel)kept.push(...ids);
    }
    // Sparse collar faces can cut across a curved last even when their three
    // vertices clear it. Prepare those face interiors against the same fixed
    // factory surface; this never consults the current visitor's foot.
    if(collider){
      const weights=[[1/3,1/3,1/3],[.5,.5,0],[0,.5,.5],[.5,0,.5]];
      for(let pass=0;pass<6;pass++){
        const corrections=new Float32Array(source.length),counts=new Uint16Array(deep.length);let contacts=0;
        for(let i=0;i<kept.length;i+=3){
          const ids=[kept[i],kept[i+1],kept[i+2]];
          if(ids.every(k=>fixed&&fixed[k]))continue;
          for(const w of weights){
            const p=[0,1,2].map(d=>ids.reduce((sum,k,j)=>sum+positions[k*3+d]*w[j],0));
            if(p[0]<=0||p[0]>=L||collider.boxDistanceSquared(...p)>.64)continue;
            const contact=collider.query(...p,query),delta=.45-contact.signedDistance;
            if(delta<=.005)continue;
            const denominator=ids.reduce((sum,k,j)=>sum+((fixed&&fixed[k])?0:w[j]*w[j]),0);
            if(denominator<1e-7)continue;
            contacts++;
            for(let j=0;j<3;j++){
              const k=ids[j];if(!w[j]||fixed&&fixed[k])continue;
              const a=Math.min(3,delta)*w[j]/denominator;
              corrections[k*3]+=contact.normal.x*a;corrections[k*3+1]+=contact.normal.y*a;corrections[k*3+2]+=contact.normal.z*a;counts[k]++;
            }
          }
        }
        if(!contacts)break;
        for(let k=0;k<counts.length;k++)if(counts[k])for(let d=0;d<3;d++)positions[k*3+d]+=corrections[k*3+d]/counts[k];
      }
    }
    moved=0;maxPreparationMm=0;maxOuterPreparationMm=0;
    for(let k=0;k<deep.length;k++){
      const o=k*3,change=Math.hypot(positions[o]-source[o],positions[o+1]-source[o+1],positions[o+2]-source[o+2]);
      if(change>.0001)moved++;
      maxPreparationMm=Math.max(maxPreparationMm,change);
      if(!deep[k])maxOuterPreparationMm=Math.max(maxOuterPreparationMm,change);
    }
    return{positions,indices:Uint32Array.from(kept),stats:{source:profile.source==='dior-reference-last-v1'?'fixed-dior-lining-reconstruction':'fixed-high-lining-reconstruction',movedVertexCount:moved,
      maxPreparationMm,maxOuterPreparationMm,removedInternalTriangles:(count-kept.length)/3,elasticDeformation:false}};
  }
  LF.diorLining={prepare};
})((window.LF=window.LF||{}));
