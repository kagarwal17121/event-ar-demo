// tools/meshy-img2glb.js
// Node 18+ (uses global fetch). Robust to different Meshy response shapes.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { argv } = require('process');

const API_KEY = process.env.MESHY_API_KEY;
const BASE = (process.env.MESHY_BASE_URL || 'https://api.meshy.ai/v1').replace(/\/+$/,'');
if (!API_KEY) {
  console.error('✖ Missing MESHY_API_KEY in .env');
  process.exit(1);
}

// ---- tiny arg parser (no deps) ----
function parseArg(name) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i+1 < argv.length && !argv[i+1].startsWith('--')) return argv[i+1];
  return argv.includes(`--${name}`) ? true : undefined;
}

const imagePath    = parseArg('image');         // local file (NOT used with Meshy: needs URL)
const imageUrl     = parseArg('imageUrl');      // public URL (recommended)
const name         = parseArg('name') || 'New Model';
const category     = parseArg('category') || 'Uncategorized';
const prompt       = parseArg('prompt') || '';
const thumbFromPrev= !!parseArg('thumbFromPreview');

if (!imageUrl && !imagePath) {
  console.error('✖ Provide --imageUrl <public URL> (Meshy requires a URL).');
  process.exit(1);
}

const modelsDir   = path.resolve('models');
const thumbsDir   = path.join(modelsDir, 'thumbs');
const jsonPath    = path.join(modelsDir, 'models.json');

// ensure dirs
fs.mkdirSync(modelsDir, { recursive: true });
fs.mkdirSync(thumbsDir, { recursive: true });

// slug
const slug = name.replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'');
const outGLB   = path.join(modelsDir, `${slug}.glb`);
const outThumb = path.join(thumbsDir, `${slug}.jpg`);

function setStatus(...m){ console.log(...m); }

async function createTask() {
  const url = `${BASE}/image-to-3d`;
  const body = {
    image_url: imageUrl,
    prompt,
    // Tweak defaults below to your taste:
    topology: 'mid',
    target_polycount: 300_000,
    texture_size: 2048
  };

  setStatus('▶ Creating Meshy task from URL:', imageUrl);
  setStatus('   POST', url);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(()=> ({}));
  if (!res.ok) {
    console.error('✖ Create task failed:', res.status, data);
    throw new Error('Create task failed');
  }

  // Meshy variants seen in the wild:
  // { task_id: "..." }  OR  { result: "..." }  OR  { id: "..." }
  const taskId = data.task_id || data.result || data.id;
  if (!taskId || typeof taskId !== 'string') {
    console.error('✖ Create task did not return task id:', data);
    throw new Error('No task id');
  }
  return taskId;
}

async function pollTask(taskId) {
  const url = `${BASE}/tasks/${encodeURIComponent(taskId)}`;
  setStatus('⏳ Task:', taskId);
  setStatus('   GET', url);

  let lastStatus = '';
  for (;;) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const data = await res.json().catch(()=> ({}));

    if (!res.ok) {
      console.error('✖ Poll failed:', res.status, data);
      throw new Error('Poll failed');
    }

    const status = (data.status || data.state || '').toUpperCase();
    if (status && status !== lastStatus) {
      setStatus('   Status:', status);
      lastStatus = status;
    }

    if (status === 'SUCCEEDED' || status === 'COMPLETED' || status === 'FINISHED') {
      return data;
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'ERROR') {
      console.error('✖ Task failed:', data);
      throw new Error('Task failed');
    }

    await new Promise(r=> setTimeout(r, 5000));
  }
}

// Try to extract GLB URL and preview from multiple possible shapes
function extractUrls(taskData) {
  // candidates for model url
  const candidates = [
    taskData?.result?.model_url,
    taskData?.result?.glb_url,
    taskData?.result?.download_url,
    taskData?.output?.model_url,
    taskData?.output?.glb_url,
    taskData?.model_url,
    taskData?.glb_url,
    taskData?.download_url
  ].filter(Boolean);

  // candidates for preview
  const previews = [
    taskData?.result?.preview_image,
    taskData?.result?.preview_url,
    taskData?.output?.preview_image,
    taskData?.output?.preview_url,
    taskData?.preview_image,
    taskData?.preview_url
  ].filter(Boolean);

  return { modelUrl: candidates[0], previewUrl: previews[0] };
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const ab = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(ab));
}

function readJSONSafe(p) {
  if (!fs.existsSync(p)) return { categories: {} };
  const raw = fs.readFileSync(p, 'utf8').trim();
  // Guard against accidental BOM
  const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  return JSON.parse(clean || '{"categories":{}}');
}

function writeJSONPretty(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

(async () => {
  try {
    const taskId = await createTask();
    const taskData = await pollTask(taskId);

    const { modelUrl, previewUrl } = extractUrls(taskData);
    if (!modelUrl) {
      console.error('✖ Could not find model URL in task result. Full payload:\n', JSON.stringify(taskData, null, 2));
      process.exit(1);
    }

    // Save GLB
    await downloadToFile(modelUrl, outGLB);
    setStatus('✔ Saved GLB ->', path.relative(process.cwd(), outGLB));

    // Optional preview -> thumbnail
    if (thumbFromPrev && previewUrl) {
      await downloadToFile(previewUrl, outThumb);
      setStatus('✔ Saved preview ->', path.relative(process.cwd(), outThumb));
    }

    // Update catalog
    const relGLB   = `./models/${path.basename(outGLB)}`;
    const relThumb = fs.existsSync(outThumb) ? `./models/thumbs/${path.basename(outThumb)}` : undefined;

    const catalog = readJSONSafe(jsonPath);
    catalog.categories ||= {};
    catalog.categories[category] ||= [];

    // Avoid dup by name
    const exists = catalog.categories[category].some(m => (m.name||'').toLowerCase() === name.toLowerCase());
    if (!exists) {
      const entry = {
        name,
        url: relGLB,
        scale: 1,
        rotation: [0,0,0],
        position: [0,0,0],
        shadow: true
      };
      if (relThumb) entry.thumbnail = relThumb;
      catalog.categories[category].push(entry);
      writeJSONPretty(jsonPath, catalog);
      setStatus('✔ Updated catalog:', path.relative(process.cwd(), jsonPath));
    } else {
      setStatus('ℹ︎ Catalog already had an entry named:', name);
    }

    setStatus('\n✅ Done. Add it from category:', category);
  } catch (err) {
    console.error('\n✖ Error:', err.message);
    process.exit(1);
  }
})();
