// tools/meshy-img2glb.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Args ----------
const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(`--${k}`);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) return true;
  return v;
};

const imageLocal = flag('image');           // local path (NOT accepted by your Meshy account)
const imageUrl   = flag('imageUrl');        // public URL (REQUIRED for your Meshy account)
const name       = flag('name')      || 'New Model';
const category   = flag('category')  || 'Unsorted';
const prompt     = flag('prompt')    || 'High-quality event decor asset, clean geometry, PBR, real scale';
const thumbFromPreview = !!flag('thumbFromPreview');

// ---------- Config ----------
const API_KEY = process.env.MESHY_API_KEY;
if (!API_KEY) {
  console.error('✖ Missing MESHY_API_KEY in .env');
  process.exit(1);
}

// If your account needs it, set MESHY_BASE_URL in .env to:
//   https://api.meshy.ai/openapi/v1
const BASE_URL = (process.env.MESHY_BASE_URL || 'https://api.meshy.ai/v1').replace(/\/+$/, '');
const CREATE_URL = `${BASE_URL}/image-to-3d`;
const TASK_URL   = (id) => `${BASE_URL}/tasks/${id}`;

// ---------- FS setup ----------
const MODELS_DIR = path.resolve(process.cwd(), 'models');
const THUMBS_DIR = path.resolve(MODELS_DIR, 'thumbs');
fs.mkdirSync(MODELS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

// ---------- HTTP helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

async function httpBuffer(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(()=>'');
    const err = new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---------- Validate input ----------
if (!imageUrl) {
  // You passed a local file (or nothing). Your Meshy account requires a public URL.
  if (imageLocal) {
    console.error('✖ Your Meshy endpoint requires a public image URL.\n' +
      '  Please upload your image somewhere public (e.g. GitHub “raw”, Cloudinary, S3) and run with:\n' +
      '    --imageUrl "https://example.com/your.jpg"\n' +
      '  Tip (GitHub): commit the image to /refs, open it on GitHub, click “Raw”, copy that URL, and use it as --imageUrl.');
  } else {
    console.error('✖ Missing image: use --imageUrl "<public URL>"');
  }
  process.exit(1);
}

// ---------- 1) Create task (JSON with image_url) ----------
console.log(`▶ Creating Meshy task from URL: ${imageUrl}`);
console.log(`   POST ${CREATE_URL}`);

try {
  const createPayload = {
    prompt,
    image_url: imageUrl
    // Add extra fields your account supports here if needed
  };

  const createRes = await httpJson(CREATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(createPayload)
  });

  const taskId = createRes.task_id || createRes.id;
  if (!taskId) {
    console.error('✖ Create task did not return task id:', createRes);
    process.exit(1);
  }
  console.log(`   ✔ Task created: ${taskId}`);

  // ---------- 2) Poll until ready ----------
  console.log('▶ Polling task status…');
  let status = 'PENDING', result = null;
  const started = Date.now();
  const timeoutMs = 10 * 60 * 1000;

  while (Date.now() - started < timeoutMs) {
    await sleep(5000);
    const t = await httpJson(TASK_URL(taskId), {
      headers: { Authorization: `Bearer ${API_KEY}` }
    });
    status = (t.status || t.state || '').toUpperCase();
    const out = t.result || t.output || t.data || t;

    if (status === 'SUCCEEDED' || status === 'COMPLETED' || out?.model_url) {
      result = out;
      break;
    }
    if (status === 'FAILED' || status === 'ERROR') {
      console.error('✖ Task failed:', t);
      process.exit(1);
    }
    process.stdout.write('.');
  }
  console.log('');

  if (!result?.model_url) {
    console.error('✖ No model_url in task result. Raw:', result);
    process.exit(1);
  }

  // ---------- 3) Download GLB (+ optional preview) ----------
  const safeName = name.replace(/[^\w\-]+/g, '_');
  const glbOut = path.join(MODELS_DIR, `${safeName}.glb`);
  console.log(`▶ Downloading GLB -> ${glbOut}`);
  const glbBuf = await httpBuffer(result.model_url, { headers: { Authorization: `Bearer ${API_KEY}` } });
  fs.writeFileSync(glbOut, glbBuf);

  let thumbRel = null;
  const previewUrl = result.preview_url || result.thumbnail_url || result.image_url;
  if (thumbFromPreview && previewUrl) {
    const jpgOut = path.join(THUMBS_DIR, `${safeName}.jpg`);
    console.log(`▶ Downloading preview -> ${jpgOut}`);
    const jpgBuf = await httpBuffer(previewUrl, { headers: { Authorization: `Bearer ${API_KEY}` } });
    fs.writeFileSync(jpgOut, jpgBuf);
    thumbRel = `./models/thumbs/${safeName}.jpg`;
  }

  // ---------- 4) Update catalog ----------
  const catalogPath = path.join(MODELS_DIR, 'models.json');
  let catalog = { categories: {} };
  if (fs.existsSync(catalogPath)) {
    try { catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); }
    catch { console.warn('! models.json existed but failed to parse. Recreating…'); }
  }
  catalog.categories ||= {};
  catalog.categories[category] ||= [];

  const entry = {
    name,
    url: `./models/${safeName}.glb`,
    scale: 1,
    rotation: [0,0,0],
    position: [0,0,0],
    shadow: true
  };
  if (thumbRel) entry.thumbnail = thumbRel;

  const arr = catalog.categories[category];
  const ix = arr.findIndex(x => x.name === name);
  if (ix >= 0) arr[ix] = entry; else arr.push(entry);

  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  console.log('✔ Catalog updated:', catalogPath);

  console.log('\n✅ Done.');
  console.log(`   Model: ${entry.url}`);
  if (thumbRel) console.log(`   Thumb: ${thumbRel}`);
  console.log(`   Category: ${category}`);
} catch (err) {
  if (err.body) {
    console.error(`✖ Create task failed: ${err.status}`, err.body);
  } else {
    console.error('✖ Error:', err.message);
  }
  console.error('\nTroubleshooting:');
  console.error('  • If you still see 404/NoMatchingRoute, set MESHY_BASE_URL=https://api.meshy.ai/openapi/v1 in .env');
  console.error('  • The script currently calls:');
  console.error('      CREATE_URL =', CREATE_URL);
  console.error('      TASK_URL   =', `${BASE_URL}/tasks/{id}`);
  process.exit(1);
}
