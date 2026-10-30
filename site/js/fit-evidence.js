// Evidence-informed starting sizes. A reference is never a verified fit or a
// pressure result: neither selected display GLB has a measured SKU interior.
(function(LF){
  'use strict';
  const MIN=230,MAX=300,STEP=5;
  const POLICY=Object.freeze({
    relatedModelTransferUncertaintyMm:4,
    expectedWidthComplianceMm:2,
    maximumWidthExtrapolationMm:6,
    widthPenaltyScaleMm:2.5,
    widthPenaltyWeight:2,
    nominalSizeStepPenalty:2,
    toeRoomPenaltyWeight:.25,
    nominalToeRoomMm:[5,18],idealToeRoomMm:10,
    summaryExtrapolationGuardSd:4,
    maximumChartUpsizeSteps:2,
  });
  const finite=x=>typeof x==='number'&&Number.isFinite(x);
  const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
  const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
  function chartRows(catalog){
    const chart=catalog&&catalog.fit&&catalog.fit.sizeChart;
    if(!chart||!Array.isArray(chart.rows))return [];
    const grouped=new Map();
    for(const row of chart.rows){
      if(!finite(row.labelMm)||row.labelMm<MIN||row.labelMm>MAX||(row.labelMm-MIN)%STEP||!finite(row.footLengthMm)||row.footLengthMm<=0)continue;
      // KR labels can have two US entries. The app's existing product grading
      // uses the larger reference foot for that label; keep the same convention.
      const current=grouped.get(row.labelMm);
      if(!current||row.footLengthMm>current.footLengthMm)grouped.set(row.labelMm,{size:row.labelMm,footLengthMm:row.footLengthMm});
    }
    return [...grouped.values()].sort((a,b)=>a.size-b.size);
  }
  function minimumChartSize(catalog,length){
    if(!finite(length)||length<=0)return null;
    const row=chartRows(catalog).find(row=>row.footLengthMm>=length);
    return row?row.size:null;
  }
  function reference(options){
    const {catalog,foot,simulationResult}=options||{},fit=catalog&&catalog.fit,evidence=fit&&fit.evidence;
    if(!evidence||!evidence.selectedProduct||!foot||simulationResult&&simulationResult.status==='ready')return null;
    if(!['length','ballWidth','instepHeight'].every(key=>finite(foot[key])&&foot[key]>0))return null;
    const selected=evidence.selectedProduct,interior=selected.exactInteriorMeasurements;
    // Once a matching measured interior is supplied, it needs its own calibrated
    // fit path. Do not silently substitute unrelated models for stronger data.
    if(!interior||interior.isMeasured!==false)return null;
    const rows=chartRows(catalog),minimum=minimumChartSize(catalog,foot.length);
    if(minimum==null)return null; // No clamping an out-of-range foot to 300.
    const studies=evidence.anthropometry&&evidence.anthropometry.studies||[];
    const gradingStudy=studies.find(study=>study.id==='jurca-2019-1p2m-scans');
    const slopeRows=gradingStudy&&gradingStudy.gradingResearchPrior&&gradingStudy.gradingResearchPrior.observedSlopes||[];
    const widthSlopes=slopeRows.map(row=>row.footWidth).filter(finite);
    if(!widthSlopes.length)return null;
    // Sex is unknown and is not inferred. This midpoint is an explicit research
    // transfer assumption, not a Nike grade or an individual regression.
    const widthSlope=mean(widthSlopes);
    const domains=slopeRows.map(row=>row.footLengthRangeMm).filter(range=>Array.isArray(range)&&range.every(finite));
    if(!domains.length)return null;
    const domainUnion=[Math.min(...domains.map(v=>v[0])),Math.max(...domains.map(v=>v[1]))];
    const chartFoot=rows.find(row=>row.size===minimum).footLengthMm;
    if(chartFoot<domainUnion[0]||chartFoot>domainUnion[1])return null;
    const summary=studies.find(study=>study.id==='kwon-2024-sizekorea8');
    const heightStats=summary&&summary.statistics&&summary.statistics.instepHeight;
    const sexSummaries=heightStats?Object.values(heightStats).filter(v=>v&&finite(v.mean)&&finite(v.sd)):[];
    const heightEnvelope=sexSummaries.length?[
      Math.min(...sexSummaries.map(v=>v.mean-POLICY.summaryExtrapolationGuardSd*v.sd)),
      Math.max(...sexSummaries.map(v=>v.mean+POLICY.summaryExtrapolationGuardSd*v.sd)),
    ]:null;
    // This bounds unsupported extrapolation, not the biological population or
    // a shoe's height capacity. H4 and the demo's 50%-length section differ.
    if(!heightEnvelope||foot.instepHeight<heightEnvelope[0]||foot.instepHeight>heightEnvelope[1])return null;
    const ids=new Set(selected.relatedModelMeasurementIds||[]);
    const samples=(evidence.relatedMeasurements||[]).filter(sample=>ids.has(sample.id)&&
      sample.exactMatchToSelectedProducts===false&&sample.measurementScope==='related-model-laboratory-sample'&&
      sample.measurements&&finite(sample.measurements.innerLengthMm)&&finite(sample.measurements.ballWidthMm)&&
      sample.measurements.innerLengthMm>0&&sample.measurements.ballWidthMm>0&&sample.size&&
      rows.some(row=>row.size===sample.size.equivalentKrLabelMm));
    if(!samples.length)return null;
    const pref=options.pref||{},sock=LF.data&&LF.data.SOCKS&&LF.data.SOCKS[pref.sock||'regular'];
    if(!sock||!finite(sock.t))return null;
    const occupiedWidth=foot.ballWidth+2*sock.t;
    const estimates=row=>samples.map(sample=>{
      const anchor=rows.find(value=>value.size===sample.size.equivalentKrLabelMm),delta=row.footLengthMm-anchor.footLengthMm;
      return {id:sample.id,innerLengthMm:sample.measurements.innerLengthMm+delta,
        ballWidthMm:sample.measurements.ballWidthMm+widthSlope*delta};
    });
    const floor=rows.find(row=>row.size===minimum),floorEstimate=estimates(floor);
    // Do not turn an unsupported wide foot into a long shoe to force a size.
    // The 6mm cap is a conservative reference-policy assumption, not a measured
    // maximum width or a validated stretch allowance of either selected model.
    if(occupiedWidth-mean(floorEstimate.map(v=>v.ballWidthMm))>POLICY.maximumWidthExtrapolationMm)return null;
    const candidates=[];
    for(const row of rows){
      if(row.size<minimum||row.size>minimum+POLICY.maximumChartUpsizeSteps*STEP)continue;
      const estimatesAtSize=estimates(row),lengths=estimatesAtSize.map(v=>v.innerLengthMm),widths=estimatesAtSize.map(v=>v.ballWidthMm);
      const estimatedLength=mean(lengths),estimatedWidth=mean(widths),toeRoom=estimatedLength-foot.length-2*sock.t;
      const widthExcess=occupiedWidth-estimatedWidth,widthRisk=Math.max(0,widthExcess-POLICY.expectedWidthComplianceMm);
      const roomValid=toeRoom>=POLICY.nominalToeRoomMm[0]&&toeRoom<=POLICY.nominalToeRoomMm[1];
      const widthValid=widthExcess<=POLICY.maximumWidthExtrapolationMm;
      const cost=(row.size-minimum)/STEP*POLICY.nominalSizeStepPenalty+
        POLICY.toeRoomPenaltyWeight*((toeRoom-POLICY.idealToeRoomMm)/4)**2+
        POLICY.widthPenaltyWeight*(widthRisk/POLICY.widthPenaltyScaleMm)**2;
      candidates.push({size:row.size,chartReferenceFootLengthMm:row.footLengthMm,eligible:roomValid&&widthValid,cost,
        reason:!roomValid?'related-model-toe-room-outside-reference-window':!widthValid?'width-outside-reference-scope':'reference-only-not-fit-verified',
        nominalRelatedToeRoomMm:toeRoom,widthRiskMm:widthRisk,
        relatedModelEstimates:{isSelectedProductMeasurement:false,isMeasured:false,
          innerLengthMm:{nominal:estimatedLength,range:[Math.min(...lengths)-POLICY.relatedModelTransferUncertaintyMm,Math.max(...lengths)+POLICY.relatedModelTransferUncertaintyMm]},
          ballWidthMm:{nominal:estimatedWidth,range:[Math.min(...widths)-POLICY.relatedModelTransferUncertaintyMm,Math.max(...widths)+POLICY.relatedModelTransferUncertaintyMm]},
          instepHeightMm:null,heelWidthMm:null,insoleLengthMm:null},
        pressureValidated:false,fitVerified:false});
    }
    const ranked=candidates.filter(row=>row.eligible).sort((a,b)=>a.cost-b.cost||a.size-b.size);
    if(!ranked.length)return null;
    const best=ranked[0],riskFlags=['selected-product-interior-unmeasured','related-model-transfer','instep-confirmation-required','heel-confirmation-required'];
    if(domains.some(range=>chartFoot<range[0]||chartFoot>range[1]))riskFlags.push('partial-research-grading-domain');
    if(best.widthRiskMm>0)riskFlags.push('width-confirmation-required');
    if(best.size>minimum)riskFlags.push('width-sensitive-reference-upsize');
    const cautions=[
      '제조사 발 길이 표와 관련 Low/Mid 모델의 측정치를 참고한 치수이며, 선택한 제품의 내부 실측은 아닙니다.',
      '발등과 뒤꿈치의 실제 내부 치수를 알 수 없어 확인이 필요합니다. 발가락 공간 높이를 발등 높이로 사용하지 않았습니다.',
      '입력한 발 치수는 유지했습니다. 성별 전체 통계는 개인 치수나 제품 수용 높이를 대신하지 않습니다.',
      '압력과 적합성이 확인된 추천이 아닙니다. 실제 착화로 볼·발등·뒤꿈치를 확인해 주세요.',
    ];
    if(best.widthRiskMm>0)cautions.push('볼 너비가 관련 모델 기준보다 커서 폭 또는 와이드 옵션을 별도로 확인해야 합니다.');
    return {status:'reference',size:best.size,confidence:'low',pressureValidated:false,fitVerified:false,geometryFitVerified:false,
      source:'manufacturer-chart-and-related-model-reference',reason:'제조사 표와 관련 모델 측정치를 참고한 치수입니다. 적합·압력은 미확인입니다.',
      minimumChartSize:minimum,riskFlags,cautions,evidenceCandidates:candidates,
      exactInteriorMeasurements:clone(interior),
      heightAssessment:{productInstepCapacityMm:null,toeBoxHeightUsedAsInstep:false,measuredAtMatchingLandmark:false,
        confirmationRequired:true,populationSummariesUsedForSizing:false,
        summaryExtrapolationEnvelopeMm:heightEnvelope,extrapolationEnvelopeIsMeasuredCoverage:false},
      provenance:{selectedProductIdentityVerified:selected.exactProductIdentityVerified===true,
        sourceRegistry:clone(evidence.sources||[]),
        manufacturerChart:{sourceUrl:fit.sizeChart.sourceUrl,measurementType:fit.sizeChart.measurementType,
          instruction:'Choose the larger chart entry between foot lengths; labels are not interior measurements.'},
        relatedModels:samples.map(sample=>({id:sample.id,productName:sample.productName,size:clone(sample.size),
          originalMeasurements:clone(sample.measurements),sourceIds:clone(sample.sourceIds),methodId:sample.methodId,
          exactMatchToSelectedProduct:false,measuredUncertaintyMm:sample.measuredUncertaintyMm})),
        anthropometry:studies.map(study=>({id:study.id,sourceUrl:study.sourceUrl})),
        engineeringAssumptions:{...clone(POLICY),widthGradingMmPerFootLengthMm:widthSlope,
          widthGradingResearchDomainUnionMm:domainUnion,
          widthGradingIsManufacturerSpecification:false,widthGradingIsIndividualRegression:false,
          relatedLengthGrading:'same change as manufacturer reference foot length; not a measured size run',
          sockAllowance:'twice the configured sock thickness, engineering approximation',
          allPolicyNumbersAreValidatedProductLimits:false},
        simulationSummary:simulationResult?{status:simulationResult.status,size:simulationResult.size||null,reason:simulationResult.reason||null}:null},
    };
  }
  LF.fitEvidence={minimumChartSize,reference,policy:POLICY};
})((window.LF=window.LF||{}));
