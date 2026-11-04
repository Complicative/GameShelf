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

const BGG_API_TOKEN = process.env.BGG_API_TOKEN || null;
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const BASE = 'https://boardgamegeek.com/xmlapi2';
const CUSTOM_NAMES_FILE = path.join(ROOT, 'custom-names.json');
const CUSTOM_CATEGORIES_FILE = path.join(ROOT, 'custom-categories.json');
const CUSTOM_LANGUAGES_FILE = path.join(ROOT, 'custom-languages.json');
const BGG_USERS_FILE = path.join(ROOT, 'bgg-users.json');
const GAME_CACHE_FILE = path.join(ROOT, 'games-cache.json');
const LEGACY_GAME_CACHE_DIR = path.join(ROOT, 'game-cache');
const GAME_IMAGES_DIR = path.join(ROOT, 'game-images');
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

async function readBggUsers() {
  try {
    const parsed = JSON.parse(await fs.readFile(BGG_USERS_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !Array.isArray(parsed.users) || !Array.isArray(parsed.defaultSelection) ||
      parsed.users.some(username => typeof username !== 'string') ||
      parsed.defaultSelection.some(username => typeof username !== 'string')) {
      throw new Error('The BGG users file has an invalid format.');
    }
    const users = [...new Map(parsed.users.map(username => [username.toLocaleLowerCase(), username])).values()];
    const availableUsers = new Set(users.map(username => username.toLocaleLowerCase()));
    const defaultSelection = [...new Map(parsed.defaultSelection
      .filter(username => availableUsers.has(username.toLocaleLowerCase()))
      .map(username => [username.toLocaleLowerCase(), users.find(user => user.toLocaleLowerCase() === username.toLocaleLowerCase())])).values()];
    return { users, defaultSelection };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { users: [], defaultSelection: [] };
  }
}

async function writeBggUsers(bggUsers) {
  await fs.writeFile(BGG_USERS_FILE, JSON.stringify(bggUsers, null, 2), 'utf8');
}

async function readJsonBody(req) {
  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('Request payload too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
  return JSON.parse(rawBody || '{}');
}

async function readImageBody(req, maxSize) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) throw new Error('Thumbnail image is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
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

let gameCache;
let gameCacheLoad;
let gameCacheWrite = Promise.resolve();

function withValidThumbnail(id, game) {
  const cachedGame = { ...game };
  if (cachedGame.thumbnailSource !== 'generated' ||
    cachedGame.thumbnail !== `/game-images/${id}-thumbnail.webp`) {
    delete cachedGame.thumbnail;
    delete cachedGame.thumbnailSource;
  }
  return cachedGame;
}

async function removeObsoleteThumbnails(cachedGames) {
  try {
    const entries = await fs.readdir(GAME_IMAGES_DIR, { withFileTypes: true });
    await Promise.all(entries.flatMap(entry => {
      const match = /^(\d+)-thumbnail\.(?:jpe?g|png|gif|webp)$/i.exec(entry.name);
      if (!entry.isFile() || !match) return [];
      const game = cachedGames.get(match[1]);
      if (game?.thumbnailSource === 'generated' &&
        game.thumbnail === `/game-images/${entry.name}`) return [];
      return [fs.unlink(path.join(GAME_IMAGES_DIR, entry.name))];
    }));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function loadGameCache() {
  let cachedGames;
  try {
    const parsed = JSON.parse(await fs.readFile(GAME_CACHE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('The games cache file has an invalid format.');
    }
    cachedGames = new Map(Object.entries(parsed).map(([id, game]) => {
      if (!/^\d+$/.test(id) || !game || typeof game !== 'object' || Array.isArray(game) || game.id !== id) {
        throw new Error(`The cached data for game ${id} has an invalid format.`);
      }
      return [id, withValidThumbnail(id, game)];
    }));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    cachedGames = new Map();
    try {
      const entries = await fs.readdir(LEGACY_GAME_CACHE_DIR, { withFileTypes: true });
      for (const entry of entries) {
        const match = /^(\d+)\.json$/.exec(entry.name);
        if (!entry.isFile() || !match) continue;
        const game = JSON.parse(await fs.readFile(path.join(LEGACY_GAME_CACHE_DIR, entry.name), 'utf8'));
        if (!game || typeof game !== 'object' || Array.isArray(game) || game.id !== match[1]) {
          throw new Error(`The cached data for game ${match[1]} has an invalid format.`);
        }
        cachedGames.set(match[1], withValidThumbnail(match[1], game));
      }
    } catch (migrationError) {
      if (migrationError.code !== 'ENOENT') throw migrationError;
    }
    if (cachedGames.size) await writeGameCache(cachedGames);
  }
  await removeObsoleteThumbnails(cachedGames);
  return cachedGames;
}

async function getGameCache() {
  if (!gameCacheLoad) {
    gameCacheLoad = loadGameCache().then(cache => {
      gameCache = cache;
      return cache;
    });
  }
  return gameCacheLoad;
}

async function writeGameCache(cache = gameCache) {
  const contents = JSON.stringify(Object.fromEntries(cache), null, 2);
  const write = gameCacheWrite.then(async () => {
    await fs.writeFile(GAME_CACHE_FILE, contents, 'utf8');
  });
  gameCacheWrite = write.catch(() => {});
  return write;
}

function imageExtension(response, imageUrl) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLocaleLowerCase();
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp'
  };
  if (extensions[contentType]) return extensions[contentType];
  const extension = path.extname(new URL(imageUrl).pathname).slice(1).toLocaleLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension)) return extension;
  throw new Error(`BoardGameGeek returned an unsupported image type for ${imageUrl}.`);
}

async function cacheGameImage(id, imageUrl) {
  if (!imageUrl) return '';
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Could not download the image for game ${id} (HTTP ${response.status}).`);
  const extension = imageExtension(response, imageUrl);
  const filename = `${id}.${extension}`;
  await fs.mkdir(GAME_IMAGES_DIR, { recursive: true });
  await fs.writeFile(path.join(GAME_IMAGES_DIR, filename), Buffer.from(await response.arrayBuffer()));
  return `/game-images/${filename}`;
}

async function request(endpoint) {
  for (let attempt = 0; attempt < 9; attempt++) {
    console.log(`[BGG API] GET ${BASE}${endpoint} (attempt ${attempt + 1}/9)`);
    const response = await fetch(`${BASE}${endpoint}`, { headers: { Authorization: `Bearer ${BGG_API_TOKEN}`, Accept: 'application/xml' }, signal: AbortSignal.timeout(30000) });
    if ([202,429,500,503].includes(response.status)) { await pause(Math.min(5000 * (attempt + 1), 20000)); continue; }
    if (!response.ok) throw new Error(`BGG returned HTTP ${response.status}${response.status === 401 ? ' — check your API token' : ''}`);
    const xml = await response.text();
    const bggError = text(xml, 'message').trim();
    if (bggError) {
      if (bggError.toLocaleLowerCase() === 'invalid username specified') {
        throw new Error('BoardGameGeek did not recognize this username. Enter the account username, not its profile or display name.');
      }
      throw new Error(`BoardGameGeek: ${bggError}`);
    }
    if (!/<items\b/.test(xml)) throw new Error('BoardGameGeek returned an unexpected response.');
    return xml;
  }
  throw new Error('BoardGameGeek is still processing or rate limiting the request. Please refresh shortly.');
}

const userGameCache = new Map();
const pendingUserGames = new Map();
async function fetchUserGames(username, refresh = false) {
  const cacheKey = username.toLocaleLowerCase();
  if (pendingUserGames.has(cacheKey)) return pendingUserGames.get(cacheKey);
  if (!refresh && userGameCache.has(cacheKey)) return userGameCache.get(cacheKey);
  const loading = (async () => {
    const collection = await request(`/collection?username=${encodeURIComponent(username)}&own=1&stats=1`);
    const owned = elements(collection, 'item').map(item => ({
      id: attr(item, 'objectid'), name: text(item, 'name'), year: text(item,'yearpublished'),
      image: text(item,'image'), plays: Number(text(item,'numplays')) || 0,
      minPlayers: value(item,'minplayers'), maxPlayers: value(item,'maxplayers'),
      time: value(item,'playingtime'), minTime: value(item,'minplaytime'), maxTime: value(item,'maxplaytime'),
      rating: attr(first(item,'average'),'value'), weight: attr(first(item,'averageweight'),'value')
    })).filter(game => /^\d+$/.test(game.id));
    const cachedGames = await getGameCache();
    const uncachedGames = [];
    for (const game of owned) {
      if (!cachedGames.has(game.id)) uncachedGames.push(game);
    }
    const detailMap = new Map();
    for (let i = 0; i < uncachedGames.length; i += 20) {
      if (i) await pause(1500);
      const batch = uncachedGames.slice(i, i + 20);
      const ids = batch.map(game => game.id);
      const xml = await request(`/thing?id=${ids.join(',')}&stats=1`);
      for (const item of elements(xml, 'item')) {
        const names = elements(item, 'name');
        const primary = names.find(name => attr(name, 'type') === 'primary') || names[0] || '';
        const ratings = first(first(item, 'statistics'), 'ratings');
        detailMap.set(attr(item, 'id'), {
          name: attr(primary, 'value'), year: value(item, 'yearpublished'),
          image: text(item, 'image'),
          minPlayers: value(item, 'minplayers'), maxPlayers: value(item, 'maxplayers'),
          time: value(item, 'playingtime'), minTime: value(item, 'minplaytime'), maxTime: value(item, 'maxplaytime'),
          minAge: value(item, 'minage'), rating: value(ratings, 'average'), weight: value(ratings, 'averageweight'),
          description: text(item, 'description').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '').trim(),
          categories: links(item, 'boardgamecategory'), mechanics: links(item, 'boardgamemechanic'), designers: links(item, 'boardgamedesigner')
        });
      }
      for (const game of batch) {
        const details = detailMap.get(game.id) || {};
        const imageUrl = details.image || game.image;
        const image = await cacheGameImage(game.id, imageUrl);
        const cachedGame = {
          ...game,
          ...Object.fromEntries(Object.entries(details).filter(([, detail]) => detail !== '' && detail != null)),
          image,
          apiCategories: details.categories || [],
          mechanics: details.mechanics || [],
          designers: details.designers || [],
          description: details.description || '',
          minAge: details.minAge || ''
        };
        cachedGames.set(game.id, cachedGame);
      }
    }
    const games = owned.map(game => {
      const cachedGame = cachedGames.get(game.id);
      const updatedGame = { ...game, ...cachedGame, plays: game.plays };
      updatedGame.image = cachedGame.image || '';
      updatedGame.thumbnail = cachedGame.thumbnailSource === 'generated' ? cachedGame.thumbnail : '';
      updatedGame.apiCategories = cachedGame.apiCategories || [];
      updatedGame.mechanics = cachedGame.mechanics || [];
      updatedGame.designers = cachedGame.designers || [];
      updatedGame.description = cachedGame.description || '';
      updatedGame.minAge = cachedGame.minAge || '';
      cachedGames.set(game.id, updatedGame);
      return updatedGame;
    });
    await writeGameCache(cachedGames);
    userGameCache.set(cacheKey, games);
    return games;
  })();
  pendingUserGames.set(cacheKey, loading);
  try { return await loading; }
  finally { pendingUserGames.delete(cacheKey); }
}

async function fetchGames(usernames, refreshUsernames = []) {
  const refreshSet = new Set(refreshUsernames.map(username => username.toLocaleLowerCase()));
  const ownedById = new Map();
  for (const [index, username] of usernames.entries()) {
    const userKey = username.toLocaleLowerCase();
    if (index && (refreshSet.has(userKey) || !userGameCache.has(userKey))) await pause(1500);
    const userGames = await fetchUserGames(username, refreshSet.has(username.toLocaleLowerCase()));
    for (const game of userGames) {
      const existingGame = ownedById.get(game.id);
      if (existingGame) existingGame.owners.push(username);
      else ownedById.set(game.id, { ...game, owners: [username] });
    }
  }
  const customNames = await readCustomNames();
  const customCategories = await readCustomCategories();
  const customLanguages = await readCustomLanguages();
  return [...ownedById.values()].map(game => {
    const originalName = game.name;
    const customName = customNames[game.id]?.trim() || '';
    const apiCategories = game.apiCategories.map(category => String(category).trim()).filter(Boolean);
    const extraCategories = Array.isArray(customCategories[game.id])
      ? customCategories[game.id].map(category => String(category).trim()).filter(Boolean)
      : [];
    const languages = Array.isArray(customLanguages[game.id])
      ? [...new Set(customLanguages[game.id].filter(language => language === 'English' || language === 'German'))]
      : [];
    return {
      ...game,
      apiCategories,
      customCategories: extraCategories,
      categories: [...new Set([...apiCategories, ...extraCategories])],
      languages,
      originalName,
      customName,
      name: customName || originalName
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const imageTypes = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp'};
http.createServer(async (req,res) => {
  const send = (status, body, type='application/json; charset=utf-8', cacheControl='no-store') => { res.writeHead(status, {'Content-Type':type,'Cache-Control':cacheControl,'X-Content-Type-Options':'nosniff'}); res.end(body); };
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/bgg-users') {
      if (req.method === 'GET') return send(200, JSON.stringify(await readBggUsers()));
      if (!['POST', 'DELETE'].includes(req.method)) return send(405, JSON.stringify({ error: 'Method not allowed' }));
      let payload;
      try { payload = await readJsonBody(req); }
      catch (error) {
        if (error instanceof SyntaxError) return send(400, JSON.stringify({ error: 'Invalid JSON body.' }));
        throw error;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return send(400, JSON.stringify({ error: 'The request body must be an object.' }));
      }
      const username = typeof payload.username === 'string' ? payload.username.trim() : '';
      if (!username || username.length > 100 || /[\u0000-\u001f\u007f]/.test(username)) {
        return send(400, JSON.stringify({ error: 'Enter a valid BGG username (up to 100 characters).' }));
      }
      const bggUsers = await readBggUsers();
      const normalizedUsername = username.toLocaleLowerCase();
      if (req.method === 'POST') {
        if (!bggUsers.users.some(user => user.toLocaleLowerCase() === normalizedUsername)) bggUsers.users.push(username);
      } else {
        bggUsers.users = bggUsers.users.filter(user => user.toLocaleLowerCase() !== normalizedUsername);
        bggUsers.defaultSelection = bggUsers.defaultSelection.filter(user => user.toLocaleLowerCase() !== normalizedUsername);
      }
      await writeBggUsers(bggUsers);
      return send(200, JSON.stringify(bggUsers));
    }
    if (pathname === '/api/bgg-users/default') {
      if (req.method !== 'POST') return send(405, JSON.stringify({ error: 'Method not allowed' }));
      let payload;
      try { payload = await readJsonBody(req); }
      catch (error) {
        if (error instanceof SyntaxError) return send(400, JSON.stringify({ error: 'Invalid JSON body.' }));
        throw error;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return send(400, JSON.stringify({ error: 'The request body must be an object.' }));
      }
      if (!Array.isArray(payload.selectedUsers) || payload.selectedUsers.some(username => typeof username !== 'string')) {
        return send(400, JSON.stringify({ error: 'The current selection must be a list of BGG usernames.' }));
      }
      const bggUsers = await readBggUsers();
      const usersByName = new Map(bggUsers.users.map(username => [username.toLocaleLowerCase(), username]));
      const selectedUsers = [...new Set(payload.selectedUsers.map(username => username.toLocaleLowerCase()))];
      if (selectedUsers.some(username => !usersByName.has(username))) {
        return send(400, JSON.stringify({ error: 'The selection contains a BGG user that is not in the list.' }));
      }
      bggUsers.defaultSelection = selectedUsers.map(username => usersByName.get(username));
      await writeBggUsers(bggUsers);
      return send(200, JSON.stringify(bggUsers));
    }
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
      return send(200, JSON.stringify({ ok: true, gameId, languages }));
    }
    const thumbnailMatch = /^\/api\/game-thumbnail\/(\d+)$/.exec(pathname);
    if (thumbnailMatch) {
      if (req.method !== 'PUT') return send(405, JSON.stringify({ error: 'Method not allowed' }));
      if (req.headers['content-type'] !== 'image/webp') {
        return send(415, JSON.stringify({ error: 'Thumbnails must be WebP images.' }));
      }
      let image;
      try { image = await readImageBody(req, 500_000); }
      catch (error) {
        if (error.message === 'Thumbnail image is too large.') return send(413, JSON.stringify({ error: error.message }));
        throw error;
      }
      const webpChunk = image.length >= 16 ? image.toString('ascii', 12, 16) : '';
      if (image.length < 20 || image.toString('ascii', 0, 4) !== 'RIFF' ||
        image.readUInt32LE(4) !== image.length - 8 || image.toString('ascii', 8, 12) !== 'WEBP' ||
        !['VP8 ', 'VP8L', 'VP8X'].includes(webpChunk) ||
        image.readUInt32LE(16) > image.length - 20) {
        return send(400, JSON.stringify({ error: 'The thumbnail is not a valid WebP image.' }));
      }
      const gameId = thumbnailMatch[1];
      const thumbnail = `/game-images/${gameId}-thumbnail.webp`;
      const cachedGames = await getGameCache();
      const cachedGame = cachedGames.get(gameId);
      if (!cachedGame) return send(404, JSON.stringify({ error: 'Game is not in the cache.' }));
      await fs.mkdir(GAME_IMAGES_DIR, { recursive: true });
      await fs.writeFile(path.join(GAME_IMAGES_DIR, `${gameId}-thumbnail.webp`), image);
      cachedGame.thumbnail = thumbnail;
      cachedGame.thumbnailSource = 'generated';
      for (const userGames of userGameCache.values()) {
        const userGame = userGames.find(game => game.id === gameId);
        if (userGame) {
          userGame.thumbnail = thumbnail;
          userGame.thumbnailSource = 'generated';
        }
      }
      await writeGameCache(cachedGames);
      return send(200, JSON.stringify({ gameId, thumbnail }));
    }
    if (req.method !== 'GET') return send(405,JSON.stringify({error:'Method not allowed'}));
    const imageMatch = /^\/game-images\/(\d+(?:-thumbnail)?\.(?:jpe?g|png|gif|webp))$/.exec(pathname);
    if (imageMatch) {
      const imagePath = path.join(GAME_IMAGES_DIR, imageMatch[1]);
      return send(200, await fs.readFile(imagePath), imageTypes[path.extname(imagePath)], 'public, max-age=86400');
    }
    if (pathname === '/api/games') {
      const url = new URL(req.url, 'http://localhost');
      let usernames;
      if (url.searchParams.has('users')) {
        let selectedUsers;
        try { selectedUsers = JSON.parse(url.searchParams.get('users')); }
        catch { return send(400, JSON.stringify({ error: 'Invalid BGG user selection.' })); }
        if (!Array.isArray(selectedUsers) || selectedUsers.some(username => typeof username !== 'string')) {
          return send(400, JSON.stringify({ error: 'BGG user selection must be a list of usernames.' }));
        }
        const bggUsers = await readBggUsers();
        const usersByName = new Map(bggUsers.users.map(username => [username.toLocaleLowerCase(), username]));
        const normalizedUsers = [...new Set(selectedUsers.map(username => username.toLocaleLowerCase()))];
        if (normalizedUsers.some(username => !usersByName.has(username))) {
          return send(400, JSON.stringify({ error: 'The selection contains a BGG user that is not in the list.' }));
        }
        usernames = normalizedUsers.map(username => usersByName.get(username));
      } else usernames = [];
      let refreshUsernames = [];
      if (url.searchParams.has('refreshUsers')) {
        let requestedRefresh;
        try { requestedRefresh = JSON.parse(url.searchParams.get('refreshUsers')); }
        catch { return send(400, JSON.stringify({ error: 'Invalid BGG refresh selection.' })); }
        if (!Array.isArray(requestedRefresh) || requestedRefresh.some(username => typeof username !== 'string')) {
          return send(400, JSON.stringify({ error: 'BGG refresh selection must be a list of usernames.' }));
        }
        const selectedNames = new Set(usernames.map(username => username.toLocaleLowerCase()));
        const userNames = new Map(usernames.map(username => [username.toLocaleLowerCase(), username]));
        const normalizedRefresh = [...new Set(requestedRefresh.map(username => username.toLocaleLowerCase()))];
        if (normalizedRefresh.some(username => !selectedNames.has(username))) {
          return send(400, JSON.stringify({ error: 'Only selected BGG users can be refreshed.' }));
        }
        refreshUsernames = normalizedRefresh.map(username => userNames.get(username));
      }
      if (usernames.length && !BGG_API_TOKEN) throw new Error('Set BGG_API_TOKEN in the environment before starting the server.');
      return send(200, JSON.stringify({ games: await fetchGames(usernames, refreshUsernames) }));
    }
    const files = {'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js'};
    if (!files[pathname]) return send(404,JSON.stringify({error:'Not found'}));
    const file = files[pathname];
    return send(200,await fs.readFile(path.join(ROOT,file)),types[path.extname(file)]);
  } catch (error) { console.error(error); send(500,JSON.stringify({error:error.message})); }
}).listen(PORT, () => console.log(`Board game library listening on port ${PORT}`));
