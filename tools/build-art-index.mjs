// Builds the Scan tab's art index: one vector per card artwork, made with the same model the phone runs, from the
// small card images (cards/<id>.jpg) the site already keeps. Only the vectors and the model are published, never
// the images. Vectors are kept in a cache file between runs, so a daily run embeds only new artworks.
// Usage: node build-art-index.mjs --images <dir> --out <dir> [--cache <file>] [--cardinfo <file>] [--model <file>]
// Writes <out>/model.onnx, <out>/art-index.bin and <out>/manifest.json (sizes and SHA-256 of both).
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

// The model, pinned to a revision and checked by hash. DINOv2 small (Meta, Apache-2.0), 8-bit, ONNX export by Xenova.
export const MODEL = {
  name: 'dinov2-small-q8',
  url: 'https://huggingface.co/Xenova/dinov2-small/resolve/c2bb04a51fab207c420665f1946016107bffc701/onnx/model_quantized.onnx',
  sha256: '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
  output: 'cls',
  dims: 384,
  size: 224,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
};
// The part of the card both normal and Pendulum frames show as art, as fractions of the card (x0, y0, x1, y1).
export const REGION = [96 / 813, 216 / 1185, 716 / 813, 728 / 1185];

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const images = arg('images', 'cards');
const out = arg('out', 'scan');
const cacheFile = arg('cache', `.cache/art-vectors-${MODEL.name}.bin`);
const modelFile = arg('model', `.cache/models/${MODEL.name}.onnx`);
const cardinfo = arg('cardinfo');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function ensureModel() {
  if (existsSync(modelFile) && sha256(readFileSync(modelFile)) === MODEL.sha256) return;
  console.log(`Downloading ${MODEL.name}…`);
  const res = await fetch(MODEL.url);
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== MODEL.sha256) throw new Error('The downloaded model does not match its pinned SHA-256.');
  mkdirSync(dirname(modelFile), { recursive: true });
  writeFileSync(modelFile, buf);
}

/** Cards a Japanese copy can be: released in the OCG, skill cards and tokens left out. Returns [artId, cardId] pairs. */
async function artworks() {
  const json = cardinfo
    ? JSON.parse(readFileSync(cardinfo, 'utf8'))
    : await (await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes')).json();
  const pairs = [];
  for (const c of json.data) {
    const misc = c.misc_info?.[0] ?? {};
    if (c.frameType === 'skill' || c.frameType === 'token') continue;
    if (!(misc.formats ?? []).includes('OCG') && !misc.ocg_date) continue;
    for (const img of c.card_images ?? [{ id: c.id }]) pairs.push([img.id, c.id]);
  }
  return pairs;
}

/** Saved vectors: u32 count, u32 dims, then per row u32 artwork id + f32 × dims. */
function loadCache() {
  const map = new Map();
  if (!existsSync(cacheFile)) return map;
  const buf = readFileSync(cacheFile);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = view.getUint32(0, true);
  const dims = view.getUint32(4, true);
  if (dims !== MODEL.dims) return map;
  let at = 8;
  for (let i = 0; i < n; i++) {
    const id = view.getUint32(at, true);
    const v = new Float32Array(dims);
    for (let d = 0; d < dims; d++) v[d] = view.getFloat32(at + 4 + 4 * d, true);
    map.set(id, v);
    at += 4 + 4 * dims;
  }
  return map;
}

function saveCache(map) {
  const buf = Buffer.alloc(8 + map.size * (4 + 4 * MODEL.dims));
  buf.writeUInt32LE(map.size, 0);
  buf.writeUInt32LE(MODEL.dims, 4);
  let at = 8;
  for (const [id, v] of map) {
    buf.writeUInt32LE(id, at);
    for (let d = 0; d < MODEL.dims; d++) buf.writeFloatLE(v[d], at + 4 + 4 * d);
    at += 4 + 4 * MODEL.dims;
  }
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, buf);
}

/** The art region of one card image as the model's input: RGB, size × size, normalised, channels first. */
export async function artTensor(file) {
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const left = Math.round(REGION[0] * width);
  const top = Math.round(REGION[1] * height);
  const { data } = await img
    .extract({ left, top, width: Math.round(REGION[2] * width) - left, height: Math.round(REGION[3] * height) - top })
    .resize(MODEL.size, MODEL.size, { fit: 'fill', kernel: 'linear' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const s = MODEL.size * MODEL.size;
  const t = new Float32Array(3 * s);
  for (let i = 0; i < s; i++) for (let c = 0; c < 3; c++) t[c * s + i] = (data[3 * i + c] / 255 - MODEL.mean[c]) / MODEL.std[c];
  return t;
}

export function unit(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const k = s > 0 ? 1 / Math.sqrt(s) : 0;
  return v.map((x) => x * k);
}

/** One vector per input from the model's output (the class token for DINOv2, the logits otherwise). */
export function vectorsOf(output, batch) {
  const out = [];
  const per = output.data.length / batch;
  for (let b = 0; b < batch; b++) {
    const row = output.data.subarray(b * per, (b + 1) * per);
    out.push(unit(Float32Array.from(MODEL.output === 'cls' ? row.subarray(0, MODEL.dims) : row)));
  }
  return out;
}

/** Same layout as src/lib/artIndex.ts encodeIndex (kept in step with it by the index test). */
function encodeIndex(rows) {
  const n = rows.length;
  const dims = MODEL.dims;
  const buf = Buffer.alloc(16 + 12 * n + n * dims);
  buf.write('YGAI', 0, 'latin1');
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(n, 8);
  buf.writeUInt32LE(dims, 12);
  rows.forEach(([artId, cardId, v], i) => {
    let max = 0;
    for (const x of v) max = Math.max(max, Math.abs(x));
    const k = max > 0 ? 127 / max : 0;
    buf.writeUInt32LE(artId, 16 + 4 * i);
    buf.writeUInt32LE(cardId, 16 + 4 * n + 4 * i);
    buf.writeFloatLE(max, 16 + 8 * n + 4 * i);
    for (let d = 0; d < dims; d++) buf.writeInt8(Math.round(v[d] * k), 16 + 12 * n + i * dims + d);
  });
  return buf;
}

async function main() {
  await ensureModel();
  const session = await ort.InferenceSession.create(modelFile);
  const have = new Set(readdirSync(images).filter((f) => f.endsWith('.jpg')).map((f) => Number(f.slice(0, -4))));
  const pairs = (await artworks()).filter(([artId]) => have.has(artId));
  const cache = loadCache();
  const todo = pairs.filter(([artId]) => !cache.has(artId));
  console.log(`${pairs.length} OCG artworks with an image, ${todo.length} to embed.`);

  const BATCH = 16;
  for (let i = 0; i < todo.length; i += BATCH) {
    const group = todo.slice(i, i + BATCH);
    const tensors = await Promise.all(group.map(([artId]) => artTensor(`${images}/${artId}.jpg`)));
    const input = new Float32Array(group.length * tensors[0].length);
    tensors.forEach((t, k) => input.set(t, k * t.length));
    const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [group.length, 3, MODEL.size, MODEL.size]) };
    const result = await session.run(feeds);
    vectorsOf(result[session.outputNames[0]], group.length).forEach((v, k) => cache.set(group[k][0], v));
    if ((i / BATCH) % 50 === 0) console.log(`  ${Math.min(i + BATCH, todo.length)} / ${todo.length}`);
    if ((i / BATCH) % 200 === 199) saveCache(cache);
  }
  if (todo.length) saveCache(cache);
  // Tells the site's workflow whether the vector cache changed and needs saving.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `embedded=${todo.length}\n`);

  const rows = pairs.map(([artId, cardId]) => [artId, cardId, cache.get(artId)]);
  const index = encodeIndex(rows);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/art-index.bin`, index);
  copyFileSync(modelFile, `${out}/model.onnx`);
  const manifest = {
    model: MODEL.name,
    output: MODEL.output,
    dims: MODEL.dims,
    size: MODEL.size,
    mean: MODEL.mean,
    std: MODEL.std,
    region: REGION,
    count: rows.length,
    built: new Date().toISOString(),
    files: {
      'model.onnx': { bytes: readFileSync(modelFile).length, sha256: MODEL.sha256 },
      'art-index.bin': { bytes: index.length, sha256: sha256(index) },
    },
  };
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 1));
  console.log(`Wrote ${rows.length} artworks (${(index.length / 1e6).toFixed(1)} MB) to ${out}.`);
}

// Run only when started directly, so the accuracy check can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
