// tools/rebuild-catalog.cjs
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'models', 'models.json');
const ROOT = path.join(__dirname, '..', 'models');

const STAGE = [
  'concert-stage.glb',
  'Mandap_1.glb',
  'Marigold_Haldi_Stage.glb',
  'Vibrant_Floral_Mayra_Stage.glb',
  'Yellow_Lotus_Stage.glb',
  'podium.glb'
];
const BACKDROP = [
  'Floral_Arch_1.glb',
  'Floral_Backdrop.glb',
  'Floral_Hoop_Arch.glb',
  'Floral_Stage_1.glb',
  'decor.glb'
];
const FURNITURE = [
  'Sofa.glb',
  'base_basic_shaded.glb',
  'chair-v1.glb'
];

function exists(p){ try { fs.accessSync(p); return true; } catch { return false; } }
function entry(name){
  return {
    name: name
      .replace(/_/g,' ')
      .replace(/\.glb$/i,'')
      .replace(/\bglb\b/i,'')
      .replace(/\s+/g,' ')
      .replace(/\b\w/g,m=>m.toUpperCase()),
    url: `./models/${name}`,
    thumbnail: null,
    scale: 1,
    rotation: [0,0,0],
    position: [0,0,0],
    shadow: true
  };
}

const categories = { Stage: [], Backdrop: [], Furniture: [] };
for (const f of STAGE)     if (exists(path.join(ROOT,f))) categories.Stage.push(entry(f));
for (const f of BACKDROP)  if (exists(path.join(ROOT,f))) categories.Backdrop.push(entry(f));
for (const f of FURNITURE) if (exists(path.join(ROOT,f))) categories.Furniture.push(entry(f));

const total = Object.values(categories).reduce((a,b)=>a+b.length,0);
if (!total) {
  console.error('✖ No models found. Refusing to overwrite models.json with empty content.');
  process.exit(1);
}

const json = { categories };
fs.writeFileSync(OUT, JSON.stringify(json, null, 2));
console.log(`✓ Wrote ${OUT} with ${total} items in ${Object.keys(categories).length} categories`);
