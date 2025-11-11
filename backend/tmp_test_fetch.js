(async ()=>{
  try {
    const res = await fetch('http://localhost:5010/api/analyze/tx',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({txHash:'0xdead',from:'0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',to:'0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb',value:0.1,gasUsed:21000,gasPriceGwei:30})
    });
    const j = await res.json();
    console.log(JSON.stringify(j,null,2));
  } catch (e) {
    console.error('fetch error', e);
    process.exit(1);
  }
})();
