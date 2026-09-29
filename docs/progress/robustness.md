# robustness agent progress
- [start] reading io.js / render.js / adjust.js / store.js for canvas creation + caps
- Findings: doc.source/fg (and render caches, preview, layer images) come from io.createCanvas WITHOUT willReadFrequently -> GPU-backed -> lost on GPU crash. mask/maskAI already CPU.
- adjust.js: webglcontextlost sets glFailed=true forever -> CPU adjust for rest of session (slow on 4096 px).
- Machine commit is very tight (free commit ~0.9 GB while server python holds 7.4 GB): first baseline run died with "RangeError: Array buffer allocation failed" in cpuAdjust during export -> need memory-error relief + friendly toast.
- Plan: createCanvas default CPU-backed (opt-out {gpu:true}); GL ctx rebuild; view contextlost/restored -> rerender; core/memory.js relieveMemory()+friendly msg; adaptive caps.
