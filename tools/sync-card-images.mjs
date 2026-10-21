// Keeps a copy of every card's small image (YGOPRODeck's cards_small) in a folder the site serves as cards/<id>.jpg.
// YGOPRODeck asks apps not to load images from their server and to host copies instead, so the app never does:
// this runs in the site repository's GitHub workflow, downloads only the images it does not have yet, and keeps
// well under their 20-requests-per-second limit. Usage: node sync-card-images.mjs [outDir] [--limit N]
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'cards';
const limitAt = args.indexOf('--limit');
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
const PER_SECOND = 8;

mkdirSync(out, { recursive: true });
const have = new Set(readdirSync(out).filter((f) => f.endsWith('.jpg')).map((f) => Number(f.slice(0, -4))));

const res = await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php');
if (!res.ok) throw new Error(`Card list download failed: HTTP ${res.status}`);
const { data } = await res.json();
// Alternate artworks have their own ids; a deck may use any of them.
const ids = [...new Set(data.flatMap((c) => (c.card_images ?? []).map((i) => i.id)))];
const todo = ids.filter((id) => !have.has(id)).slice(0, limit);
console.log(`${ids.length} card images listed, ${have.size} already saved, ${todo.length} to download.`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let saved = 0;
let failed = 0;
for (let i = 0; i < todo.length; i += PER_SECOND) {
  const started = Date.now();
  await Promise.all(
    todo.slice(i, i + PER_SECOND).map(async (id) => {
      try {
        const img = await fetch(`https://images.ygoprodeck.com/images/cards_small/${id}.jpg`);
        if (!img.ok) throw new Error(`HTTP ${img.status}`);
        writeFileSync(`${out}/${id}.jpg`, Buffer.from(await img.arrayBuffer()));
        saved++;
      } catch (e) {
        failed++;
        if (failed <= 20) console.warn(`Skipped ${id}: ${e.message}`);
      }
    }),
  );
  if ((i / PER_SECOND) % 250 === 0 && i) console.log(`  ${saved} saved so far`);
  await sleep(Math.max(0, 1000 - (Date.now() - started)));
}
console.log(`Saved ${saved} new image${saved === 1 ? '' : 's'}${failed ? `, ${failed} skipped (tried again next run)` : ''}.`);
// Tells the workflow whether the saved copy changed.
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `saved=${saved}\n`);
if (!existsSync(`${out}/README.txt`)) {
  writeFileSync(`${out}/README.txt`, 'Card images copied from YGOPRODeck (images.ygoprodeck.com). Card artwork © Konami.\n');
}
