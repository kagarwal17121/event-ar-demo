#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');

const API_KEY = process.env.MESHY_API_KEY;
if (!API_KEY) { console.error('✖ Missing MESHY_API_KEY in .env'); process.exit(1); }

const CANDIDATE_BASES = [
    (process.env.MESHY_BASE_URL || '').replace(/\/+$/, ''),
    'https://api.meshy.ai/openapi/v1',
    'https://api.meshy.ai/v1',
].filter(Boolean);

const CREATE_PATHS = ['/image-to-3d', '/image-to-3d/async', '/image-to-3d-task'];
const TASK_PATHS = (id) => [`/tasks/${id}`, `/task/${id}`];

function arg(name, def) { const i = process.argv.indexOf('--' + name); return (i !== -1 && i + 1 < process.argv.length) ? process.argv[i + 1] : def; }
function flag(name) { return process.argv.includes('--' + name); }
function yn(v, d = false) { if (v == null) return d; v = ('' + v).toLowerCase(); return v === 'yes' || v === 'true' || v === '1'; }

const imageUrl = arg('imageUrl');
const name = arg('name', 'Untitled');
const category = arg('category', 'Unsorted');
const polyOpt = arg('poly', null);      // 'adaptive' | low|medium|high|ultra | number
const targetOpt = arg('target', null);    // explicit fixed number
const topology = (arg('topology', 'quad').toLowerCase() === 'triangle' ? 'triangle' : 'quad');
const texture = yn(arg('texture', 'yes'), true);
const pbr = yn(arg('pbr', 'yes'), true);
const textureSize = Number(arg('textureSize', '2048')) || 2048;
const thumbFromPreview = flag('thumbFromPreview');
const saveGlb = arg('saveGlb', null);

if (!imageUrl) { console.error('✖ Provide --imageUrl (public URL to your reference image)'); process.exit(1); }

function buildPayload() {
    const payload = {
        image_url: imageUrl,
        topology,
        generate_texture: !!texture,
        generate_pbr: !!pbr,
        texture_size: textureSize
    };
    const poly = polyOpt ? String(polyOpt).toLowerCase() : null;

    if (poly === 'adaptive') {
        payload.polycount_method = 'adaptive';
    } else {
        // fixed
        let target = null;
        if (targetOpt != null && !Number.isNaN(Number(targetOpt))) target = Math.max(100, Number(targetOpt));
        else if (poly && !Number.isNaN(Number(poly))) target = Math.max(100, Number(poly));
        else if (['low', 'medium', 'high', 'ultra'].includes(poly)) {
            const map = { low: 5000, medium: 30000, high: 80000, ultra: 200000 };
            target = map[poly];
        }
        if (target != null) {
            payload.polycount_method = 'fixed';
            payload.target_polycount = target;   // both spellings to be safe
            payload.targetPolycount = target;
        }
    }
    return payload;
}

function requestJSON(method, url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const opts = {
            method,
            hostname: u.hostname,
            path: u.pathname + (u.search || ''),
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'x-api-key': API_KEY,
                'Accept': 'application/json'
            }
        };
        let dataStr = null;
        if (body) {
            dataStr = JSON.stringify(body);
            opts.headers['Content-Type'] = 'application/json';
            opts.headers['Content-Length'] = Buffer.byteLength(dataStr);
        }
        const req = https.request(opts, res => {
            let buf = ''; res.setEncoding('utf8');
            res.on('data', d => buf += d);
            res.on('end', () => {
                let json = null; try { json = buf ? JSON.parse(buf) : {}; } catch (e) { }
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                if (ok) return resolve(json || {});
                reject({ status: res.statusCode, body: json || buf });
            });
        });
        req.on('error', reject);
        if (dataStr) req.write(dataStr);
        req.end();
    });
}

async function tryCreate(payload) {
    const errors = [];
    for (const base of CANDIDATE_BASES) {
        for (const p of CREATE_PATHS) {
            const url = base.replace(/\/+$/, '') + p;
            try {
                console.log('   POST', url);
                const r = await requestJSON('POST', url, payload);
                const taskId = r.task_id || r.id || r.result;
                if (taskId) return { base, createPath: p, taskId };
                errors.push({ url, err: 'No task id in response', body: r });
            } catch (e) {
                errors.push({ url, err: e });
                // If it’s a definite 404, move on silently
                if (e.status !== 404) console.log('   … failed', e.status, e.body?.message || e.body);
            }
        }
    }
    console.error('✖ Create failed across all routes');
    errors.slice(0, 3).forEach(e => console.error('  -', e.url, e.err?.status || '', e.err?.body?.message || e.err));
    process.exit(1);
}

async function pollTask(base, taskId) {
    const paths = TASK_PATHS(taskId).map(p => base.replace(/\/+$/, '') + p);
    const start = Date.now(), timeout = 15 * 60 * 1000;
    process.stdout.write('⏳ Processing');

    while (Date.now() - start < timeout) {
        await new Promise(r => setTimeout(r, 4000));
        for (const url of paths) {
            try {
                const t = await requestJSON('GET', url);
                const status = (t.status || t.state || '').toUpperCase();
                process.stdout.write('.');
                if (['SUCCEEDED', 'SUCCESS', 'DONE'].includes(status)) return t;
                if (['FAILED', 'ERROR'].includes(status)) throw new Error(JSON.stringify(t));
            } catch (e) { /* try next path */ }
        }
    }
    process.stdout.write('\n');
    console.error('✖ Timed out waiting for task'); process.exit(1);
}

function downloadTo(url, outPath) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        https.get(u, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                return downloadTo(res.headers.location, outPath).then(resolve, reject);
            if (res.statusCode !== 200) return reject(new Error(`Download HTTP ${res.statusCode}`));
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            const f = fs.createWriteStream(outPath);
            res.pipe(f); f.on('finish', () => f.close(() => resolve(outPath)));
        }).on('error', reject);
    });
}

(async () => {
    try {
        console.log('▶ Creating Meshy task');
        const payload = buildPayload();

        if (!payload.polycount_method) console.log('   mode: adaptive (no target)');
        else console.log('   mode:', payload.polycount_method, 'target:', payload.target_polycount || payload.targetPolycount);

        const { base, createPath, taskId } = await tryCreate(payload);
        console.log('   ✓ route selected:', base + createPath, 'task:', taskId);

        const t = await pollTask(base, taskId);
        process.stdout.write('\n');

        const previewUrl = t.preview_url || t.previewUrl || t.preview || t.output?.preview_url || null;
        const modelUrl = t.model_url || t.modelUrl || t.output?.model_url || t.output?.glb_url || null;
        console.log('✓ Task succeeded');
        console.log('   preview :', previewUrl || '(none)');
        console.log('   model   :', modelUrl || '(none)');

        // Save GLB / thumb
        let outGlb = saveGlb;
        if (!outGlb && modelUrl) {
            const safe = name.toLowerCase().replace(/[^a-z0-9\-]+/g, '-').replace(/(^-|-$)/g, '');
            outGlb = path.join('models', `${safe || 'model'}.glb`);
        }
        let outThumb = null;
        if (thumbFromPreview && previewUrl) {
            const safe = name.toLowerCase().replace(/[^a-z0-9\-]+/g, '-').replace(/(^-|-$)/g, '');
            outThumb = path.join('models', 'thumbs', `${safe}.jpg`);
            console.log('⬇ preview ->', outThumb);
            await downloadTo(previewUrl, outThumb);
        }
        if (modelUrl && outGlb) {
            console.log('⬇ glb ->', outGlb);
            await downloadTo(modelUrl, outGlb);
        }

        // Update catalog
        if (outGlb) {
            const jsonPath = path.join('models', 'models.json');
            let json = { categories: {} };
            if (fs.existsSync(jsonPath)) try { json = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { }
            json.categories ||= {}; json.categories[category] ||= [];
            const entry = {
                name, url: outGlb.replace(/\\/g, '/'),
                thumbnail: outThumb ? outThumb.replace(/\\/g, '/') : undefined,
                scale: 1, rotation: [0, 0, 0], position: [0, 0, 0], shadow: true
            };
            if (!json.categories[category].some(m => m.url === entry.url))
                json.categories[category].push(entry);
            fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
            fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
            console.log('📝 Updated', jsonPath);
        }

        console.log('✅ Done');
    } catch (e) {
        console.error('\n✖ Error:', e.status ? e.status : '', e.body?.message || e.body || e);
        console.error('\nTroubleshooting:');
        console.error('  • If you still see 404/NoMatchingRoute, your tenant may use a different route.');
        console.error('  • This script already tries multiple bases & paths. If all fail, ask Meshy support which base to use.');
        process.exit(1);
    }
})();
