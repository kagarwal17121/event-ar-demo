#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// ---------- CLI ARGS ----------
function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const k = a.slice(2);
            const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
            out[k] = v;
        }
    }
    return out;
}
const args = parseArgs(process.argv);

// Required
const NAME = args.name || 'New Model';
const CATEGORY = args.category || 'Uncategorized';

// Source image: either local file or URL
const IMAGE_PATH = args.image || null;     // e.g. .\refs\chair.jpg
const IMAGE_URL = args.imageUrl || null;  // e.g. https://example.com/chair.jpg
if (!IMAGE_PATH && !IMAGE_URL) {
    console.error('✖ Provide either --image <localPath> OR --imageUrl <http(s)://...>');
    process.exit(1);
}

// Options
const PROMPT = args.prompt || '';
const TOPOLOGY = (args.topology || 'quad').toLowerCase();     // 'quad' | 'tri'
const TARGET = args.target ? Number(args.target) : undefined;  // polycount number (>=100)
const POLY_MODE = (args.poly || 'adaptive').toLowerCase();     // 'adaptive' (default) or anything else ignored
const WANT_TEX = String(args.texture || 'yes').toLowerCase() !== 'no';
const WANT_PBR = String(args.pbr || 'yes').toLowerCase() !== 'no';
const TEX_SIZE = args.textureSize ? Number(args.textureSize) : 2048;
const THUMB_FROM_PREVIEW = !!args.thumbFromPreview;

// ---------- ENV ----------
const API_KEY = process.env.MESHY_API_KEY;
if (!API_KEY || !API_KEY.trim()) {
    console.error('✖ Missing MESHY_API_KEY in .env');
    process.exit(1);
}
const BASE = (process.env.MESHY_BASE_URL || 'https://api.meshy.ai/v1').replace(/\/+$/, '');
const CREATE_URL = `${BASE}/image-to-3d`;

// Polling config
const POLL_MS = Number(process.env.MESHY_POLL_MS || '4000');       // 4s
const TIMEOUT_MIN = Number(process.env.MESHY_TIMEOUT_MIN || '45'); // 45 min

// ---------- HTTP ----------
async function requestJSON(method, url, body, headers = {}) {
    const res = await fetch(url, {
        method,
        headers: { 'Authorization': `Bearer ${API_KEY}`, ...headers },
        body
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch {
        json = { raw: text };
    }
    if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText} ${text ? `-- ${text}` : ''}`.trim());
    }
    return json;
}

async function downloadToFile(url, outPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return outPath;
}

// ---------- TASK POLLING ----------
const TASK_PATHS = (id) => ([
    `/tasks/${id}`,
    `/task/${id}`,
    `/image-to-3d/${id}`,
    `/image-to-3d/tasks/${id}`,
    `/jobs/${id}`,
    `/task-status/${id}`
]);

async function pollTask(base, taskId) {
    const urls = TASK_PATHS(taskId).map(p => base.replace(/\/+$/, '') + p);
    const start = Date.now();
    const timeout = TIMEOUT_MIN * 60 * 1000;
    let lastSeen = null;

    process.stdout.write('⏳ Processing');

    while (Date.now() - start < timeout) {
        await new Promise(r => setTimeout(r, POLL_MS));
        for (const url of urls) {
            try {
                const t = await requestJSON('GET', url);
                lastSeen = t;
                const statusRaw = t.status || t.state || t.task_status || t.result_status || t.progress?.status || '';
                const status = String(statusRaw).toUpperCase();
                process.stdout.write('.');
                if (['SUCCEEDED', 'SUCCESS', 'DONE', 'COMPLETED'].includes(status)) return t;
                if (['FAILED', 'ERROR', 'CANCELED'].includes(status)) {
                    process.stdout.write('\n');
                    console.error('✖ Task failed at', url, '\nPayload:', JSON.stringify(t, null, 2));
                    process.exit(1);
                }
            } catch {
                // try next path
            }
        }
    }
    process.stdout.write('\n');
    console.error('✖ Timed out waiting for task after', TIMEOUT_MIN, 'minutes.');
    if (lastSeen) {
        console.error('Last payload seen:\n', JSON.stringify(lastSeen, null, 2));
    } else {
        console.error('No readable payloads returned from any status endpoints.');
    }
    process.exit(1);
}

// ---------- PAYLOAD BUILD ----------
function buildJSONPayload() {
    const payload = {
        // Common knobs (names may be accepted by Meshy OpenAPI)
        prompt: PROMPT || undefined,
        topology: TOPOLOGY === 'tri' ? 'triangle' : 'quad',
        texture: WANT_TEX,
        pbr: WANT_PBR,
        texture_size: TEX_SIZE
    };
    if (IMAGE_URL) payload.image_url = IMAGE_URL;
    if (POLY_MODE === 'adaptive' && !TARGET) {
        payload.target_polycount_mode = 'ADAPTIVE';
    } else if (TARGET && TARGET >= 100) {
        payload.target_polycount = TARGET;
    }
    return payload;
}

function buildMultipartPayload() {
    const form = new FormData();
    // fields
    if (PROMPT) form.append('prompt', PROMPT);
    form.append('topology', TOPOLOGY === 'tri' ? 'triangle' : 'quad');
    form.append('texture', String(WANT_TEX));
    form.append('pbr', String(WANT_PBR));
    form.append('texture_size', String(TEX_SIZE));
    if (POLY_MODE === 'adaptive' && !TARGET) {
        form.append('target_polycount_mode', 'ADAPTIVE');
    } else if (TARGET && TARGET >= 100) {
        form.append('target_polycount', String(TARGET));
    }
    // file
    const filePath = path.resolve(IMAGE_PATH);
    if (!fs.existsSync(filePath)) {
        console.error(`✖ Image not found: ${filePath}`);
        process.exit(1);
    }
    form.append('image_file', fs.createReadStream(filePath), path.basename(filePath));
    return form;
}

// ---------- CREATE TASK ----------
(async function main() {
    try {
        console.log('▶ Creating Meshy task');
        console.log('   POST', CREATE_URL);

        let createRes;
        if (IMAGE_URL) {
            const payload = buildJSONPayload();
            createRes = await requestJSON('POST', CREATE_URL, JSON.stringify(payload), {
                'Content-Type': 'application/json'
            });
        } else {
            const form = buildMultipartPayload();
            createRes = await requestJSON('POST', CREATE_URL, form, form.getHeaders());
        }

        // Detect task id from various shapes
        let taskId = createRes.task_id || createRes.id || createRes.taskId || (typeof createRes.result === 'string' ? createRes.result : (createRes.result && createRes.result.id));
        if (!taskId) {
            console.error('✖ Create task did not include a recognizable task id. Response:\n', JSON.stringify(createRes, null, 2));
            process.exit(1);
        }
        console.log('   ✓ task:', taskId);

        // Poll
        const final = await pollTask(BASE, taskId);
        console.log('\n✓ Task completed');

        // Try to discover GLB & preview URLs from result payload
        function findStringByExt(obj, exts) {
            let found = null;
            const seen = new Set();
            (function walk(o) {
                if (!o || found) return;
                if (typeof o === 'string') {
                    const low = o.toLowerCase();
                    if (exts.some(ext => low.endsWith(ext))) { found = o; return; }
                } else if (Array.isArray(o)) {
                    for (const v of o) walk(v);
                } else if (typeof o === 'object') {
                    if (seen.has(o)) return;
                    seen.add(o);
                    for (const k of Object.keys(o)) walk(o[k]);
                }
            })(obj);
            return found;
        }

        // Common places
        const result = final.result || final.data || final;
        let glbUrl =
            result.glb_url || result.model_url || result.asset_url ||
            findStringByExt(result, ['.glb', '.gltf']);
        let previewUrl =
            result.preview_url || result.image_url ||
            findStringByExt(result, ['.jpg', '.jpeg', '.png', '.webp']);

        if (!glbUrl) {
            console.error('✖ Could not find a GLB URL in the task result.\nResult:\n', JSON.stringify(result, null, 2));
            process.exit(1);
        }

        // -------- Save files locally --------
        const slug = NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const outGlb = path.join('models', `${slug}.glb`);
        await downloadToFile(glbUrl, outGlb);
        console.log('✔ GLB saved ->', outGlb);

        let outThumb = null;
        if (THUMB_FROM_PREVIEW && previewUrl) {
            outThumb = path.join('models', 'thumbs', `${slug}.jpg`);
            await downloadToFile(previewUrl, outThumb);
            console.log('✔ Preview saved ->', outThumb);
        }

        // -------- Update models/models.json (categories map) --------
        const catalogPath = path.join('models', 'models.json');
        if (!fs.existsSync(catalogPath)) {
            // initialize if missing
            fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
            fs.writeFileSync(catalogPath, JSON.stringify({ categories: {} }, null, 2));
        }

        let catalog;
        try {
            catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
        } catch (e) {
            console.error(`✖ Failed to read/parse JSON: ${catalogPath}\n${e.message}`);
            process.exit(1);
        }
        if (!catalog.categories || typeof catalog.categories !== 'object') {
            catalog.categories = {};
        }
        if (!catalog.categories[CATEGORY]) {
            catalog.categories[CATEGORY] = [];
        }

        const entry = {
            name: NAME,
            url: `./models/${slug}.glb`,
            thumbnail: outThumb ? `./models/thumbs/${slug}.jpg` : undefined,
            scale: 1,
            rotation: [0, 0, 0],
            position: [0, 0, 0],
            shadow: true
        };
        // Remove undefined fields to keep JSON tidy
        Object.keys(entry).forEach(k => entry[k] === undefined && delete entry[k]);

        // Dedup by url
        const arr = catalog.categories[CATEGORY];
        const idx = arr.findIndex(it => it.url === entry.url);
        if (idx >= 0) arr[idx] = entry; else arr.push(entry);

        fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
        console.log('✔ Catalog updated ->', catalogPath);

        console.log('\n✅ Done');
        console.log(`   Name:      ${NAME}`);
        console.log(`   Category:  ${CATEGORY}`);
        console.log(`   GLB:       ${entry.url}`);
        if (entry.thumbnail) console.log(`   Thumbnail: ${entry.thumbnail}`);
    } catch (err) {
        // Friendlier errors
        const msg = String(err && err.message || err);
        if (/NoMatchingRoute/i.test(msg) || /404/i.test(msg)) {
            console.error('✖ Create failed: 404 NoMatchingRoute');
            console.error('ℹ Try setting MESHY_BASE_URL=https://api.meshy.ai/openapi/v1 in your .env');
        } else if (/TargetPolycount/i.test(msg)) {
            console.error('✖ Create failed:', msg);
            console.error('ℹ If using --target, it must be >= 100. Or omit --target and keep --poly adaptive.');
        } else {
            console.error('✖ Error:', msg);
        }
        process.exit(1);
    }
})();
