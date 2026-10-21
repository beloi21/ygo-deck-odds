// Refreshes public/banlists.json with the current OCG and Master Duel Forbidden & Limited lists.
// Runs before `npm run dev` / `npm run build`, at most once a day (pass --force to refresh now).
// Any failure keeps the existing file, so the app still works offline.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// BANLISTS_OUT lets the published site's daily job write the file at its own root.
const OUT = process.env.BANLISTS_OUT ?? fileURLToPath(new URL('../public/banlists.json', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const force = process.argv.includes('--force');
// --ci (the daily GitHub job): keep a list untouched when it did not change and is under 6 days old,
// so the repository only gets a commit when there is something new (or the date needs a refresh).
const ci = process.argv.includes('--ci');
const sameEntries = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function current() {
  try {
    return existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  } catch {
    return null;
  }
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ygo-consistency-analyzer (personal deck tool; daily banlist check)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

const OCG_STATUS = { Forbidden: 'Forbidden', Limited: 'Limited', 'Semi-Limited': 'Semi-Limited' };
const MD_STATUS = { Forbidden: 'Forbidden', 'Limited 1': 'Limited', 'Limited 2': 'Semi-Limited' };

async function ocg() {
  const { data } = await getJson('https://db.ygoprodeck.com/api/v7/cardinfo.php?banlist=ocg');
  const entries = [];
  for (const c of data) {
    const status = OCG_STATUS[c.banlist_info?.ban_ocg];
    if (!status) continue;
    // Alternate artworks share the card's status.
    for (const id of new Set([c.id, ...(c.card_images ?? []).map((i) => i.id)])) entries.push({ id, name: c.name, status });
  }
  return { source: 'YGOPRODeck (OCG list)', entries };
}

async function md() {
  const entries = [];
  for (const [raw, status] of Object.entries(MD_STATUS)) {
    const cards = await getJson(`https://www.masterduelmeta.com/api/v1/cards?banStatus=${encodeURIComponent(raw)}&limit=3000`);
    for (const c of cards) entries.push({ id: Number(c.konamiID) || 0, name: c.name, status });
  }
  if (entries.length < 50) throw new Error(`Master Duel list looks incomplete (${entries.length} cards)`);
  return { source: 'Master Duel Meta', entries };
}

const old = current();
if (!force && old?.updatedAt && Date.now() - Date.parse(old.updatedAt) < DAY) {
  console.log(`Banlists are less than a day old (${old.updatedAt}); skipping.`);
  process.exit(0);
}

const lists = { ...(old?.lists ?? {}) };
let changed = false;
for (const [format, get] of [['OCG', ocg], ['MD', md]]) {
  try {
    const fresh = await get();
    const prev = lists[format];
    const recent = prev?.fetchedAt && Date.now() - Date.parse(prev.fetchedAt) < 6 * DAY;
    if (ci && prev && sameEntries(prev.entries, fresh.entries) && recent) {
      console.log(`${format} banlist unchanged (${fresh.entries.length} entries); keeping the saved copy.`);
      continue;
    }
    lists[format] = { ...fresh, fetchedAt: new Date().toISOString() };
    changed = true;
    console.log(`${format} banlist: ${lists[format].entries.length} entries.`);
  } catch (e) {
    // Node's "fetch failed" hides the real reason (DNS, refused, proxy…) in e.cause.
    const reason = [e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(': ');
    console.warn(`Could not update the ${format} banlist (${reason}); keeping the saved copy.`);
  }
}
if (changed) writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), lists }, null, 1));
