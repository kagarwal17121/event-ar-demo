// tools/meshy-img2glb.js
// Node 18+. Creates ONE Meshy Image->3D model using options similar to the web UI.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.MESHY_API_KEY;
const BASE = (process.env.MESHY_BASE_URL || 'https://api.meshy.ai/v1').replace(/\/+$/,'');
if (!API_KEY) { console.error('✖ Missing MESHY_API_KEY in .env'); process.exit(1); }

// ---- args ----
const argv = process.argv;
const get = (k, d)=> {
  const i = argv.indexOf(`--${k}`);
  return (i>-1 && argv[i+1] && !argv[i+1].startsWith('--')) ? argv[i+1] : d;
};
const has = (k)=> argv.includes(`--${k}`);

const imageUrl = get('imageUrl');
const name     = get('name', 'New Model');
const category = get('category', 'Uncategorized');
const poly     = (get('poly','adaptive')||'').toLowerCase();      // adaptive|ultra|max|low|medium|high|fixed
const polycount= parseInt(get('polycount','300000'),10);          // used when poly=fixed
const topology = (get('topology','quad')||'').toLowerCase();      // quad|triangle
const texture  = (get('texture','yes')||'').toLowerCase() !== 'no';
const pbr      = (get('pbr','yes')||'').toLowerCase() !== 'no';
const textureSize = parseInt(get('textureSize','2048'),10);
const thumbFromPreview = has('thumbFromPreview');

if (!imageUrl) { console.error('✖ Provide --imageUrl <public URL>'); process.exit(1); }

const modelsDir = path.resolve('models');
const thumbsDir = path.join(modelsDir,'thumbs');
const jsonPath  = path.join(modelsDir,'models.json');
fs.mkdirSync(modelsDir,{recursive:true});
fs.mkdirSync(thumbsDir,{recursive:true});

function status(...m){ console.log(...m); }

// Map “poly” to Meshy fields
function polyPresetToBody(poly){
  switch(poly){
    case 'ultra':  return { target_polycount: 800_000 };
    case 'max':    return { target_polycount: 1_200_000 };
    case 'high':   return { target_polycount: 600_000 };
    case 'medium': return { target_polycount: 300_000 };
    case 'low':    return { target_polycount: 120_000 };
    case 'fixed':  return { target_polycount: Math.max(50_000, polycount) };
    case 'adaptive':
    default:       return { target_polycount: 0, polycount_strategy: 'adaptive' }; // let server choose
  }
}

function topologyToBody(t){
  return { topology: (t === 'triangle' ? 'triangle' : 'quad') };
}

async function createTask(body){
  const url = `${BASE}/image-to-3d`;
  status('▶ Creating Meshy task\n   POST', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) { console.error('✖ Create failed:', res.status, data); throw new Error('create failed'); }
  const taskId = data.task_id || data.result || data.id;
  if (!taskId) { console.error('✖ No task id in response:', data); throw new Error('no task id'); }
  return taskId;
}

async function pollTask(taskId){
  const url = `${BASE}/tasks/${encodeURIComponent(taskId)}`;
  let last = '';
  for(;;){
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${API_KEY}` }});
    const data = await res.json().catch(()=> ({}));
    if (!res.ok) { console.error('✖ Poll failed:', res.status, data); throw new Error('poll failed'); }
    const statusTxt = (data.status || data.state || '').toUpperCase();
    if (statusTxt && statusTxt !== last){ status('   Task status:', statusTxt); last = statusTxt; }
    if (['SUCCEEDED','COMPLETED','FINISHED'].includes(statusTxt)) return data;
    if (['FAILED','CANCELED','ERROR'].includes(statusTxt)){ console.error('✖ Task failed:', data); throw new Error('task failed'); }
    await new Promise(r=> setTimeout(r, 5000));
  }
}

function extractUrls(d){
  const model = [d?.result?.model_url, d?.result?.glb_url, d?.result?.download_url, d?.output?.model_url, d?.output?.glb_url, d?.model_url, d?.glb_url, d?.download_url].find(Boolean);
  const preview = [d?.result?.preview_image, d?.result?.preview_url, d?.output?.preview_image, d?.output?.preview_url, d?.preview_image, d?.preview_url].find(Boolean);
  return { modelUrl: model, previewUrl: preview };
}

async function download(url, dest){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`download failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(ab));
}

function readCatalog(){
  if (!fs.existsSync(jsonPath)) return { categories:{} };
  const raw = fs.readFileSync(jsonPath,'utf8');
  const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  return JSON.parse(clean || '{"categories":{}}');
}
function writeCatalog(obj){
  fs.writeFileSync(jsonPath, JSON.stringify(obj,null,2));
}

(async()=>{
  try{
    // Build request body to match UI choices
    const body = {
      image_url: imageUrl,
      prompt: get('prompt',''),
      texture_size: textureSize,
      generate_texture: !!texture,        // “Yes” in UI
      generate_pbr_maps: !!pbr,           // PBR ON
      ...polyPresetToBody(poly),
      ...topologyToBody(topology)
    };

    const taskId = await createTask(body);
    const task   = await pollTask(taskId);
    const { modelUrl, previewUrl } = extractUrls(task);
    if (!modelUrl) throw new Error('no model url in task result');

    const safe = name.replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'');
    const outGLB = path.join(modelsDir, `${safe}.glb`);
    await download(modelUrl, outGLB);
    status('✔ Saved GLB ->', path.relative(process.cwd(), outGLB));

    let thumbRel;
    if (thumbFromPreview && previewUrl){
      const outJPG = path.join(thumbsDir, `${safe}.jpg`);
      await download(previewUrl, outJPG);
      status('✔ Saved preview ->', path.relative(process.cwd(), outJPG));
      thumbRel = `./models/thumbs/${path.basename(outJPG)}`;
    }

    // Update catalog
    const catalog = readCatalog();
    catalog.categories ||= {};
    catalog.categories[category] ||= [];

    // avoid duplicates by name
    if (!catalog.categories[category].some(m => (m.name||'').toLowerCase() === name.toLowerCase())){
      catalog.categories[category].push({
        name,
        url: `./models/${path.basename(outGLB)}`,
        thumbnail: thumbRel,
        scale: 1,
        rotation: [0,0,0],
        position: [0,0,0],
        shadow: true
      });
    }
    writeCatalog(catalog);
    status('✅ Catalog updated ->', path.relative(process.cwd(), jsonPath));
  }catch(err){
    console.error('✖ Error:', err.message);
    console.error('\nTroubleshooting:\n' +
      '  • If you get 404 NoMatchingRoute, set MESHY_BASE_URL=https://api.meshy.ai/openapi/v1 in .env\n' +
      '  • If you get "Invalid values", double-check --poly / --topology / flags.\n');
    process.exit(1);
  }
})();
