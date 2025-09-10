#!/usr/bin/env node
/**
 * tools/meshy-img2glb.js
 * Image -> 3D (GLB) via Meshy API, then write into models/ and models/models.json
 *
 * Usage:
 *   node tools/meshy-img2glb.js --image ".\refs\chair.jpg" --name "Chair v1" --category "Furniture" [--prompt "extra prompt"] [--thumbFromPreview]
 *
 * Notes:
 * - Adjust ENDPOINT_CREATE / ENDPOINT_STATUS if your Meshy plan exposes different paths.
 * - The script is defensive and prints the raw responses if something is unexpected.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FormData from 'form-data';

// ---------- CONFIG: tweak if your account uses different endpoints ----------
const ENDPOINT_CREATE = 'https://api.meshy.ai/v2/image-to-3d';        // POST create task
const ENDPOINT_STATUS = (taskId) => `https://api.meshy.ai/v2/tasks/${taskId}`; // GET task status

// ----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT     = path.resolve(__dirname, '..');
const MODELS   = path.resolve(ROOT, '../models');
const THUMBS   = path.resolve(MODELS, 'thumbs');
const CATALOG  = path.resolve(MODELS, 'models.json');

const API_KEY  = process.env.MESHY_API_KEY;
if (!API_KEY) {
  console.error('✖ Missing MESHY_API_KEY in .env');
  process.exit(1);
}

function argOf(name, def=null) {
  const i = process.argv.findIndex(a => a === `--${name}`);
  if (i>=0 && process.argv[i+1]) return process.argv[i+1];
  return def;
}

function boolFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sanitizeFileBase(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80) || 'model';
}

function readJsonNoBOM(file) {
  let txt = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : '';
  if (txt && txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
  return txt ? JSON.parse(txt) : { categories:{} };
}

function writeJsonPretty(file, obj) {
  const txt = JSON.stringify(obj, null, 2);
  fs.writeFileSync(file, txt, { encoding:'utf8' });
}

async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function createTask(imagePath, prompt) {
  const form = new FormData();
  // attach image
  form.append('image', fs.createReadStream(imagePath)); // content-type auto set by form-data
  // optional prompt
  if (prompt) form.append('prompt', prompt);
  // You can add more params if your plan supports them, e.g.:
  // form.append('output_format', 'glb');
  // form.append('texture_size', '2048');

  const res = await fetch(ENDPOINT_CREATE, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}` },
    body: form
  });

  const body = await res.json().catch(()=> ({}));
  if (!res.ok) {
    console.error('✖ Create task failed:', res.status, body);
    throw new Error('Create task failed');
  }

  // Try common shapes: { task_id } or { id } or { data: { task_id } }
  const taskId = body.task_id || body.id || body?.data?.task_id || body?.data?.id;
  if (!taskId) {
    console.error('✖ Could not find task id in response:', body);
    throw new Error('Missing task id in response');
  }
  return taskId;
}

async function pollTask(taskId) {
  const started = Date.now();
  const timeoutMs = 25 * 60 * 1000; // 25 minutes (adjust as needed)

  while (true) {
    if (Date.now()-started > timeoutMs) throw new Error('Timed out waiting for Meshy task');

    const res = await fetch(ENDPOINT_STATUS(taskId), {
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const body = await res.json().catch(()=> ({}));

    // Debug prints so you can see the actual schema once
    // console.log('DEBUG status:', JSON.stringify(body, null, 2));

    // Heuristic field picking — adjust these lines if your responses use different field names
    const status  = body.status || body.state || body?.data?.status || body?.data?.state;
    const prog    = body.progress ?? body?.data?.progress;
    const err     = body.error    || body?.data?.error;

    if (err) throw new Error(`Task error: ${err}`);

    if (status && ['succeeded','finished','completed','SUCCESS','SUCCEEDED','DONE'].includes(String(status).toUpperCase())) {
      // Try to find model URL & preview URL in common places:
      const modelUrl   =
        body.model_url   || body.glb_url   || body.result_url ||
        body?.data?.model_url || body?.data?.glb_url || body?.data?.result_url;

      const previewUrl =
        body.preview_url || body.image_url  || body.thumbnail_url ||
        body?.data?.preview_url || body?.data?.image_url || body?.data?.thumbnail_url;

      if (!modelUrl) {
        console.error('✖ No GLB/model URL in success response:', body);
        throw new Error('No model URL found');
      }
      return { modelUrl, previewUrl };
    }

    // Not done yet
    process.stdout.write(`… status: ${status||'unknown'}${prog!=null?` (${prog}%)`:''}\r`);
    await sleep(6000);
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

async function main() {
  const image   = argOf('image');
  const name    = argOf('name', 'New Model');
  const category= argOf('category', 'Unsorted');
  const prompt  = argOf('prompt', '');
  const thumbFromPreview = boolFlag('thumbFromPreview');

  if (!image) {
    console.log('Usage: node tools/meshy-img2glb.js --image "<path>" --name "Name" --category "Category" [--prompt "text"] [--thumbFromPreview]');
    process.exit(1);
  }
  if (!fs.existsSync(image)) {
    console.error(`✖ Image not found: ${path.resolve(image)}`);
    process.exit(1);
  }
  fs.mkdirSync(MODELS, { recursive:true });
  fs.mkdirSync(THUMBS, { recursive:true });

  console.log(`▶ Creating Meshy task from: ${image}`);
  const taskId = await createTask(image, prompt);
  console.log(`✔ Task created: ${taskId}`);

  console.log('▶ Waiting for completion…');
  const { modelUrl, previewUrl } = await pollTask(taskId);
  console.log('\n✔ Task done');
  console.log('   modelUrl  :', modelUrl);
  if (previewUrl) console.log('   previewUrl:', previewUrl);

  const fileBase = sanitizeFileBase(name);
  const glbOut   = path.join(MODELS, `${fileBase}.glb`);
  const thumbOut = path.join(THUMBS, `${fileBase}.jpg`);

  console.log(`▶ Downloading GLB → ${glbOut}`);
  await download(modelUrl, glbOut);

  let thumbRel = null;
  if (thumbFromPreview && previewUrl) {
    console.log(`▶ Downloading preview → ${thumbOut}`);
    try {
      await download(previewUrl, thumbOut);
      thumbRel = `./models/thumbs/${fileBase}.jpg`;
    } catch {
      console.warn('! Failed to download preview image — continuing without thumbnail.');
    }
  }

  // Update catalog
  const relGlb = `./models/${fileBase}.glb`;
  const entry = {
    name,
    url: relGlb,
    thumbnail: thumbRel || undefined,
    scale: 1,
    rotation: [0,0,0],
    position: [0,0,0],
    shadow: true
  };

  const json = readJsonNoBOM(CATALOG);
  if (!json.categories) json.categories = {};
  if (!json.categories[category]) json.categories[category] = [];
  json.categories[category].push(entry);
  writeJsonPretty(CATALOG, json);

  console.log('\n✓ Added to catalog:');
  console.log(`  - name    : ${name}`);
  console.log(`  - category: ${category}`);
  console.log(`  - url     : ${relGlb}`);
  if (thumbRel) console.log(`  - thumb   : ${thumbRel}`);
  console.log(`\nUpdated: ${path.relative(process.cwd(), CATALOG)}`);
}

main().catch(err=>{
  console.error('\n✖ Error:', err?.message || err);
  process.exit(1);
});
