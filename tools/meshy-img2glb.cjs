#!/usr/bin/env node
/* tools/meshy-img2glb.cjs
 * Create a 3D model from a single reference image via Meshy API,
 * then optionally persist it into ./models and models/models.json.
 *
 * Usage (PowerShell backticks shown for readability):
 *   npm run meshy:img2glb -- `
 *     --imageUrl "https://.../chair.jpg" `
 *     --name "Chair v1" `
 *     --category "Furniture" `
 *     --poly adaptive `                # or: --target 200000 (fixed)
 *     --topology quad `                # quad | triangle
 *     --texture yes `                  # yes | no
 *     --pbr yes `                      # yes | no
 *     --textureSize 2048 `
 *     --thumbFromPreview               # optional: save preview as thumbnail
 *     --saveGlb "./models/chair-v1.glb"  # optional explicit path
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');

function arg(name, def = undefined) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
function flag(name) { return process.argv.includes('--' + name); }
function yn(v, def=false){ if(v==null) return def; v=String(v).toLowerCase(); return v==='yes'||v==='true'||v==='1'; }

const API_KEY = process.env.MESHY_API_KEY;
if (!API_KEY) {
  console.error('✖ Missing MESHY_API_KEY in .env');
  process.exit(1);
}
const BASE = (process.env.MESHY_BASE_URL || 'https://api.meshy.ai/openapi/v1').replace(/\/+$/,'');
const CREATE_URL = `${BASE}/image-to-3d`;
const TASK_URL   = (id)=> `${BASE}/tasks/${id}`;

const imageUrl   = arg('imageUrl');
const name       = arg('name','Untitled');
const category   = arg('category','Unsorted');

const polyOpt    = arg('poly', null);           // 'adaptive' | low|medium|high|ultra | number
const targetOpt  = arg('target', null);         // explicit number
const topology   = (arg('topology','quad')||'').toLowerCase()==='triangle' ? 'triangle':'quad';
const texture    = yn(arg('texture','yes'), true);
const pbr        = yn(arg('pbr','yes'), true);
const textureSize= Number(arg('textureSize','2048')) || 2048;
const thumbFromPreview = flag('thumbFromPreview');

const saveGlb    = arg('saveGlb', null); // e.g., ./models/chair-v1.glb

if (!imageUrl) {
  console.error('✖ Provide --imageUrl (public URL to your reference image).');
  process.exit(1);
}

function postJSON(url, body) {
  return new Promise((resolve,reject)=>{
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = https.request({
      method:'POST',
      hostname: u.hostname,
      path: u.pathname + (u.search||''),
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, res=>{
      let buf='';
      res.setEncoding('utf8');
      res.on('data', d=> buf+=d);
      res.on('end', ()=>{
        let json=null;
        try { json = buf ? JSON.parse(buf) : {}; } catch(e){ /* leave as text */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json||{});
        reject({status:res.statusCode, body: json||buf});
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
function getJSON(url) {
  return new Promise((resolve,reject)=>{
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + (u.search||''),
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    }, res=>{
      let buf=''; res.setEncoding('utf8');
      res.on('data', d=> buf+=d);
      res.on('end', ()=>{
        let json=null; try{ json = buf ? JSON.parse(buf) : {}; }catch(e){}
        if (res.statusCode>=200 && res.statusCode<300) return resolve(json||{});
        reject({status:res.statusCode, body:json||buf});
      });
    }).on('error', reject);
  });
}
function downloadTo(url, outPath){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    https.get(u, res=>{
      if (res.statusCode>=300 && res.statusCode<400 && res.headers.location) {
        return downloadTo(res.headers.location, outPath).then(resolve,reject);
      }
      if (res.statusCode!==200) return reject(new Error(`Download HTTP ${res.statusCode}`));
      fs.mkdirSync(path.dirname(outPath), {recursive:true});
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on('finish', ()=> file.close(()=> resolve(outPath)));
    }).on('error', reject);
  });
}

function buildPayload() {
  const payload = {
    image_url: imageUrl,
    topology,                               // 'quad' | 'triangle'
    generate_texture: !!texture,
    generate_pbr: !!pbr,
    texture_size: textureSize
  };

  // Polycount handling
  const poly = polyOpt ? String(polyOpt).toLowerCase() : null;

  if (poly === 'adaptive') {
    payload.polycount_method = 'adaptive';
    // IMPORTANT: do not send any target field in adaptive mode
  } else {
    // fixed mode
    let target = null;

    if (targetOpt != null && !Number.isNaN(Number(targetOpt))) {
      target = Math.max(100, Number(targetOpt));
    } else if (poly && !Number.isNaN(Number(poly))) {
      target = Math.max(100, Number(poly));
    } else if (poly && ['low','medium','high','ultra'].includes(poly)) {
      const map = { low: 5000, medium: 30000, high: 80000, ultra: 200000 };
      target = map[poly];
    }

    if (target != null) {
      payload.polycount_method = 'fixed';
      // Be liberal in what we send (covers API variations)
      payload.target_polycount = target;
      payload.targetPolycount  = target;
    }
  }

  return payload;
}

(async()=>{
  try{
    console.log('▶ Creating Meshy task');
    console.log('   POST', CREATE_URL);

    const payload = buildPayload();
    const create = await postJSON(CREATE_URL, payload);

    // Accept either { task_id } or { id } or { result } (older API variants)
    const taskId = create.task_id || create.id || create.result;
    if (!taskId) {
      console.error('✖ Create did not return a task id:', create);
      process.exit(1);
    }

    // Poll
    let status='QUEUED', result=null, previewUrl=null, modelUrl=null;
    const start = Date.now();
    const timeoutMs = 15 * 60 * 1000; // 15 min

    process.stdout.write('⏳ Processing');
    while (Date.now() - start < timeoutMs) {
      await new Promise(r=> setTimeout(r, 4000));
      const t = await getJSON(TASK_URL(taskId));
      status = (t.status || t.state || '').toUpperCase();
      process.stdout.write('.');
      // Try to read outputs across variants
      previewUrl = t.preview_url || t.previewUrl || t.preview || t.output?.preview_url || null;
      modelUrl   = t.model_url   || t.modelUrl   || t.output?.model_url || t.output?.glb_url || null;
      if (status === 'SUCCEEDED' || status === 'SUCCESS' || status === 'DONE') { result = t; break; }
      if (status === 'FAILED' || status === 'ERROR') {
        process.stdout.write('\n');
        console.error('✖ Task failed:', t);
        process.exit(1);
      }
    }
    process.stdout.write('\n');

    if (!result) {
      console.error('✖ Timed out waiting for task completion.');
      process.exit(1);
    }

    console.log('✓ Task succeeded');
    console.log('   preview :', previewUrl || '(none)');
    console.log('   model   :', modelUrl   || '(none)');

    // Save GLB if asked
    let outGlb = saveGlb;
    if (!outGlb && modelUrl) {
      // auto name from --name when not provided
      const safe = name.toLowerCase().replace(/[^a-z0-9\-]+/g,'-').replace(/(^-|-$)/g,'');
      outGlb = path.join('models', `${safe || 'model'}.glb`);
    }

    if (modelUrl && outGlb) {
      console.log('⬇ downloading GLB ->', outGlb);
      await downloadTo(modelUrl, outGlb);
    }

    // Save thumbnail if requested and preview available
    let outThumb = null;
    if (thumbFromPreview && previewUrl) {
      const safe = (name||'preview').toLowerCase().replace(/[^a-z0-9\-]+/g,'-').replace(/(^-|-$)/g,'');
      outThumb = path.join('models','thumbs',`${safe}.jpg`);
      console.log('⬇ downloading preview ->', outThumb);
      await downloadTo(previewUrl, outThumb);
    }

    // Update models/models.json (if we wrote a GLB)
    if (outGlb) {
      const jsonPath = path.join('models','models.json');
      let json = { categories:{} };
      if (fs.existsSync(jsonPath)) {
        try { json = JSON.parse(fs.readFileSync(jsonPath,'utf8')); } catch(e){}
      }
      json.categories ||= {};
      json.categories[category] ||= [];

      const modelEntry = {
        name,
        url: outGlb.replace(/\\/g,'/'),
        thumbnail: outThumb ? outThumb.replace(/\\/g,'/') : undefined,
        scale: 1,
        rotation: [0,0,0],
        position: [0,0,0],
        shadow: true
      };
      // avoid duplicates
      const exists = json.categories[category].some(m => (m.url===modelEntry.url));
      if (!exists) json.categories[category].push(modelEntry);

      fs.mkdirSync(path.dirname(jsonPath), {recursive:true});
      fs.writeFileSync(jsonPath, JSON.stringify(json,null,2));
      console.log('📝 Updated', jsonPath);
    }

    console.log('✅ Done');

  }catch(err){
    if (err && err.status && err.body) {
      console.error('✖ Create failed:', err.status, err.body);
      if (err.status === 404) {
        console.error('\nℹ If you see 404/NoMatchingRoute, set MESHY_BASE_URL=https://api.meshy.ai/openapi/v1 in .env');
      } else if (err.status === 400) {
        console.error('\nℹ 400 usually means a field mismatch. We now send:');
        console.error('  • polycount_method (adaptive|fixed)');
        console.error('  • target_polycount + targetPolycount (when fixed)');
      }
    } else {
      console.error('✖ Error:', err);
    }
    process.exit(1);
  }
})();
