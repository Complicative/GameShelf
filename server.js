// Requires Node.js 18+. No npm install required.
const http = require('node:http');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const ENV_FILE = path.join(__dirname, '.env');

if (fsSync.existsSync(ENV_FILE)) {
  const contents = fsSync.readFileSync(ENV_FILE, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    process.env[match[1]] = value;
  }
}

const BGG_USERNAME = process.env.BGG_USERNAME || null;
const BGG_API_TOKEN = process.env.BGG_API_TOKEN || null;
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const BASE = 'https://boardgamegeek.com/xmlapi2';
const CUSTOM_NAMES_FILE = path.join(ROOT, 'custom-names.json');
const CUSTOM_CATEGORIES_FILE = path.join(ROOT, 'custom-categories.json');
const CUSTOM_LANGUAGES_FILE = path.join(ROOT, 'custom-languages.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readCustomNames() {
  try {
    const text = await fs.readFile(CUSTOM_NAMES_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeCustomNames(customNames) {
  await fs.writeFile(CUSTOM_NAMES_FILE, JSON.stringify(customNames, null, 2), 'utf8');
}

async function readCustomCategories() {
  try {
    const text = await fs.readFile(CUSTOM_CATEGORIES_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function readCustomLanguages() {
  try {
    const text = await fs.readFile(CUSTOM_LANGUAGES_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function decode(value = '') {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi, (match, dec, hex) => {
    if (dec || hex) { const n = parseInt(dec || hex, hex ? 16 : 10); return n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : match; }
    return ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[match.toLowerCase()] || match;
  });
}
function attr(tag, name) { return decode(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] || ''); }
function elements(xml, name) { return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/${name}>)`, 'g'))].map(m => m[0]); }
function first(xml, name) { return elements(xml, name)[0] || ''; }
function text(xml, name) { return decode(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(xml)?.[1] || ''); }
function value(xml, name) { return attr(first(xml, name), 'value'); }
function links(xml, type) { return elements(xml, 'link').filter(tag => attr(tag,'type') === type).map(tag => attr(tag,'value')); }

async function request(endpoint) {
  for (let attempt = 0; attempt < 9; attempt++) {
    const response = await fetch(`${BASE}${endpoint}`, { headers: { Authorization: `Bearer ${BGG_API_TOKEN}`, Accept: 'application/xml' }, signal: AbortSignal.timeout(30000) });
    if ([202,429,500,503].includes(response.status)) { await pause(Math.min(5000 * (attempt + 1), 20000)); continue; }
    if (!response.ok) throw new Error(`BGG returned HTTP ${response.status}${response.status === 401 ? ' — check your API token' : ''}`);
    const xml = await response.text();
    if (!xml.includes('<items')) throw new Error('Unexpected response from BoardGameGeek');
    return xml;
  }
  throw new Error('BoardGameGeek is still processing or rate limiting the request. Please refresh shortly.');
}

let cache = null;
let cacheUntil = 0;
let pending = null;
async function fetchGames() {
  if (cache && Date.now() < cacheUntil) return cache;
  if (pending) return pending;
  pending = (async () => {
    const customNames = await readCustomNames();
    const customCategories = await readCustomCategories();
    const customLanguages = await readCustomLanguages();
    const collection = await request(`/collection?username=${encodeURIComponent(BGG_USERNAME)}&own=1&stats=1`);
    const owned = elements(collection, 'item').map(item => ({
      id: attr(item, 'objectid'), name: text(item, 'name'), year: text(item,'yearpublished'),
      thumbnail: text(item,'thumbnail'), image: text(item,'image'), plays: Number(text(item,'numplays')) || 0,
      minPlayers: value(item,'minplayers'), maxPlayers: value(item,'maxplayers'),
      time: value(item,'playingtime'), minTime: value(item,'minplaytime'), maxTime: value(item,'maxplaytime'),
      rating: attr(first(item,'average'),'value'), weight: attr(first(item,'averageweight'),'value')
    })).filter(g => /^\d+$/.test(g.id));
    const detailMap = new Map();
    for (let i = 0; i < owned.length; i += 20) {
      if (i) await pause(1500);
      const ids = owned.slice(i,i+20).map(g => g.id);
      const xml = await request(`/thing?id=${ids.join(',')}&stats=1`);
      for (const item of elements(xml,'item')) {
        const names = elements(item,'name');
        const primary = names.find(n => attr(n,'type') === 'primary') || names[0] || '';
        const stats = first(item,'statistics');
        const ratings = first(stats,'ratings');
        detailMap.set(attr(item,'id'), {
          name: attr(primary,'value'), year: value(item,'yearpublished'),
          image: text(item,'image'), thumbnail: text(item,'thumbnail'),
          minPlayers: value(item,'minplayers'), maxPlayers: value(item,'maxplayers'),
          time: value(item,'playingtime'), minTime: value(item,'minplaytime'), maxTime: value(item,'maxplaytime'),
          minAge: value(item,'minage'), rating: value(ratings,'average'), weight: value(ratings,'averageweight'),
          description: text(item,'description').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]+>/g,'').trim(),
          categories: links(item,'boardgamecategory'), mechanics: links(item,'boardgamemechanic'), designers: links(item,'boardgamedesigner')
        });
      }
    }
    const games = owned.map(g => {
      const details = detailMap.get(g.id) || {};
      const originalName = details.name || g.name;
      const customName = customNames[g.id]?.trim() || '';
      const apiCategories = (details.categories || []).map(category => String(category).trim()).filter(Boolean);
      const extraCategories = Array.isArray(customCategories[g.id]) ? customCategories[g.id].map(category => String(category).trim()).filter(Boolean) : [];
      const combinedCategories = [...new Set([...apiCategories, ...extraCategories])];
      const languages = Array.isArray(customLanguages[g.id])
        ? [...new Set(customLanguages[g.id].filter(language => language === 'English' || language === 'German'))]
        : [];
      return { ...g, ...Object.fromEntries(Object.entries(details).filter(([,v]) => v !== '' && v != null)),
        apiCategories, customCategories: extraCategories, categories: combinedCategories,
        languages,
        mechanics: details.mechanics || [], designers: details.designers || [], description: details.description || '', minAge: details.minAge || '',
        originalName,
        customName,
        name: customName || originalName };
    }).sort((a,b) => a.name.localeCompare(b.name));
    cache = games; cacheUntil = Date.now() + 30 * 60 * 1000;
    return games;
  })();
  try { return await pending; } finally { pending = null; }
}

const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
http.createServer(async (req,res) => {
  const send = (status, body, type='application/json; charset=utf-8') => { res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(body); };
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/custom-name') {
      if (req.method !== 'POST') return send(405,JSON.stringify({error:'Method not allowed'}));
      const rawBody = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; if (data.length > 1_000_000) { reject(new Error('Request payload too large')); } });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      let payload = {};
      try { payload = JSON.parse(rawBody || '{}'); }
      catch { return send(400, JSON.stringify({ error: 'Invalid JSON body.' })); }
      const { gameId, customName } = payload;
      if (!gameId) throw new Error('Missing game id.');
      const customNames = await readCustomNames();
      const trimmedName = typeof customName === 'string' ? customName.trim() : '';
      if (trimmedName) customNames[String(gameId)] = trimmedName;
      else delete customNames[String(gameId)];
      await writeCustomNames(customNames);
      cache = null;
      return send(200, JSON.stringify({ ok: true, gameId: String(gameId), customName: trimmedName }));
    }
    if (pathname === '/api/custom-categories') {
      if (req.method !== 'POST') return send(405,JSON.stringify({error:'Method not allowed'}));
      const rawBody = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
          data += chunk;
          if (data.length > 1_000_000) reject(new Error('Request payload too large'));
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      let payload;
      try { payload = JSON.parse(rawBody || '{}'); }
      catch { return send(400, JSON.stringify({ error: 'Invalid JSON body.' })); }
      const gameId = String(payload.gameId || '');
      if (!/^\d+$/.test(gameId)) return send(400, JSON.stringify({ error: 'A valid game id is required.' }));
      if (!Array.isArray(payload.customCategories) || payload.customCategories.some(category => typeof category !== 'string')) {
        return send(400, JSON.stringify({ error: 'Custom categories must be an array of names.' }));
      }
      const customCategories = await readCustomCategories();
      const names = [...new Set(payload.customCategories.map(category => category.trim()).filter(Boolean))];
      if (names.length) customCategories[gameId] = names;
      else delete customCategories[gameId];
      await fs.writeFile(CUSTOM_CATEGORIES_FILE, JSON.stringify(customCategories, null, 2), 'utf8');
      cache = null;
      return send(200, JSON.stringify({ ok: true, gameId, customCategories: names }));
    }
    if (pathname === '/api/custom-languages') {
      if (req.method !== 'POST') return send(405,JSON.stringify({error:'Method not allowed'}));
      const rawBody = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
          data += chunk;
          if (data.length > 1_000_000) reject(new Error('Request payload too large'));
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      let payload;
      try { payload = JSON.parse(rawBody || '{}'); }
      catch { return send(400, JSON.stringify({ error: 'Invalid JSON body.' })); }
      const gameId = String(payload.gameId || '');
      if (!/^\d+$/.test(gameId)) return send(400, JSON.stringify({ error: 'A valid game id is required.' }));
      const supportedLanguages = ['English', 'German'];
      if (!Array.isArray(payload.languages) || payload.languages.some(language => !supportedLanguages.includes(language))) {
        return send(400, JSON.stringify({ error: 'Languages must be English, German, or both.' }));
      }
      const customLanguages = await readCustomLanguages();
      const languages = [...new Set(payload.languages)];
      if (languages.length) customLanguages[gameId] = languages;
      else delete customLanguages[gameId];
      await fs.writeFile(CUSTOM_LANGUAGES_FILE, JSON.stringify(customLanguages, null, 2), 'utf8');
      cache = null;
      return send(200, JSON.stringify({ ok: true, gameId, languages }));
    }
    if (req.method !== 'GET') return send(405,JSON.stringify({error:'Method not allowed'}));
    if (pathname === '/api/games') {
      if (!BGG_USERNAME || !BGG_API_TOKEN) throw new Error('Set BGG_USERNAME and BGG_API_TOKEN in the environment before starting the server.');
      return send(200, JSON.stringify({games:await fetchGames()}));
    }
    const files = {'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js'};
    if (!files[pathname]) return send(404,JSON.stringify({error:'Not found'}));
    const file = files[pathname];
    return send(200,await fs.readFile(path.join(ROOT,file)),types[path.extname(file)]);
  } catch (error) { console.error(error); send(500,JSON.stringify({error:error.message})); }
}).listen(PORT, () => console.log(`Board game library listening on port ${PORT}`));
