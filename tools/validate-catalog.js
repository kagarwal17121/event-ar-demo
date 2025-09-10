// tools/validate-catalog.js
const fs = require('fs');
const path = require('path');

const P = p => path.resolve(process.cwd(), p);

function fail(msg){ console.error('✖ ' + msg); process.exitCode = 1; }
function ok(msg){ console.log('✔ ' + msg); }

function checkJson() {
  const p = P('models/models.json');
  if (!fs.existsSync(p)) { fail('models/models.json not found'); return null; }
  let text = fs.readFileSync(p, 'utf8');

  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
    fs.writeFileSync(p, text);
    ok('Removed BOM from models/models.json');
  }

  let data;
  try { data = JSON.parse(text); }
  catch (e) { fail('JSON parse error: ' + e.message); return null; }

  if (!data || !data.categories || typeof data.categories !== 'object') {
    fail('Expected {"categories":{...}} at root'); return null;
  }
  ok('JSON parsed & has categories');
  return data;
}

function checkFiles(data) {
  let total = 0, missing = 0, heavy = 0;
  for (const [cat, items] of Object.entries(data.categories)) {
    console.log('\n[' + cat + ']');
    if (!Array.isArray(items)) { fail(`Category "${cat}" is not an array`); continue; }
    for (const it of items) {
      total++;
      if (!it || !it.url) { fail('Item missing "url"'); continue; }
      const url = it.url.replace(/^\.\//, ''); // './models/x.glb' -> 'models/x.glb'
      const f = P(url);
      if (!fs.existsSync(f)) { missing++; fail('Missing: ' + url); continue; }
      const sz = fs.statSync(f).size;
      const mb = (sz/1024/1024).toFixed(1);
      const name = it.name || path.basename(url);
      console.log(`  • ${name}  (${mb} MB)`);
      if (sz > 30*1024*1024) { heavy++; console.warn('    ⚠ >30MB; consider compressing (Draco / simplify)'); }
    }
  }
  console.log(`\nSummary: ${total} items, ${missing} missing, ${heavy} >30MB`);
}

const data = checkJson();
if (data) checkFiles(data);
