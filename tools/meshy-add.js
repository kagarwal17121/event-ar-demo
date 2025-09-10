// tools/meshy-add.js
// Usage:
//   npm run meshy:add -- --file ".\models\podium.glb" --name "Podium" --category "Stage" [--thumb ".\models\thumbs\podium.jpg"]

const fs = require('fs');
const path = require('path');

function stripBOM(s) { return typeof s === 'string' ? s.replace(/^\uFEFF/, '') : s; }
function die(msg) { console.error('✖ ' + msg); process.exit(1); }
function ok(msg)  { console.log('✔ ' + msg); }

// --- parse argv ---
const args = process.argv.slice(2);
function val(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : undefined; }

const inFile   = val('--file');
const name     = val('--name');
const category = val('--category');
const thumb    = val('--thumb');

if (!inFile)   die('Missing --file (path to .glb)');
if (!name)     die('Missing --name (display name)');
if (!category) die('Missing --category');

const repoRoot = process.cwd();
const modelsDir = path.join(repoRoot, 'models');
const thumbsDir = path.join(modelsDir, 'thumbs');
const jsonPath  = path.join(modelsDir, 'models.json');

// ensure dirs
fs.mkdirSync(modelsDir, { recursive: true });
fs.mkdirSync(thumbsDir, { recursive: true });

// ensure input GLB exists
const srcGlbAbs = path.resolve(inFile);
if (!fs.existsSync(srcGlbAbs)) die(`GLB not found: ${srcGlbAbs}`);

// destination GLB name (keep original filename)
const glbBase = path.basename(srcGlbAbs);
const dstGlbRel = `./models/${glbBase}`;
const dstGlbAbs = path.join(repoRoot, 'models', glbBase);

// copy GLB
fs.copyFileSync(srcGlbAbs, dstGlbAbs);
ok(`Copied GLB -> ${dstGlbRel}`);

// optional thumbnail
let thumbRel = undefined;
if (thumb) {
  const srcThumbAbs = path.resolve(thumb);
  if (!fs.existsSync(srcThumbAbs)) die(`Thumbnail not found: ${srcThumbAbs}`);
  const thumbBase = path.basename(srcThumbAbs);
  const dstThumbAbs = path.join(thumbsDir, thumbBase);
  fs.copyFileSync(srcThumbAbs, dstThumbAbs);
  thumbRel = `./models/thumbs/${thumbBase}`;
  ok(`Copied thumbnail -> ${thumbRel}`);
}

// read or init models.json (strip BOM if present)
let data = { categories: {} };
if (fs.existsSync(jsonPath)) {
  try {
    const raw = stripBOM(fs.readFileSync(jsonPath, 'utf8'));
    data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('not an object');
    if (!data.categories || typeof data.categories !== 'object') data.categories = {};
  } catch (e) {
    die(`Failed to read/parse JSON: ${jsonPath}\n${e.message}`);
  }
} else {
  ok('models/models.json not found — creating new');
}

// ensure category exists
if (!data.categories[category]) data.categories[category] = [];

// check duplicate (by url OR name)
const exists = data.categories[category].some(m => m.url === dstGlbRel || m.name === name);
if (exists) die(`Model already exists in category "${category}" (same url or name)`);

// push entry
const entry = {
  name,
  url: dstGlbRel,
  thumbnail: thumbRel || null,
  scale: 1,
  rotation: [0, 0, 0],
  position: [0, 0, 0],
  shadow: true
};
data.categories[category].push(entry);

// write pretty (no BOM)
fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
ok(`Added "${name}" to category "${category}" and saved models/models.json`);
