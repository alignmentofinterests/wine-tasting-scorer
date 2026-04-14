const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

const store = {
  adminPassword: process.env.ADMIN_PASSWORD || 'GGWCC',
  numWines: 0,
  rankingsRevealed: false,
  participants: [],
  scores: {},
  wineNames: {},
};

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function requireAdmin(req) {
  return req.headers['x-admin-password'] === store.adminPassword;
}

function computeRankings() {
  if (store.numWines === 0) return [];
  const rankings = [];
  for (let w = 1; w <= store.numWines; w++) {
    const wineScores = [];
    for (const participant of store.participants) {
      const s = store.scores[participant.name]?.[w];
      if (s !== undefined) wineScores.push(s);
    }
    if (wineScores.length === 0) {
      rankings.push({ wine: w, name: store.wineNames[String(w)] || null, average: 0, stdDev: Infinity, numScores: 0, scores: wineScores });
      continue;
    }
    const avg = wineScores.reduce((a, b) => a + b, 0) / wineScores.length;
    const variance = wineScores.reduce((sum, s) => sum + Math.pow(s - avg, 2), 0) / wineScores.length;
    const stdDev = Math.sqrt(variance);
    rankings.push({ wine: w, name: store.wineNames[String(w)] || null, average: Math.round(avg * 100) / 100, stdDev: Math.round(stdDev * 100) / 100, numScores: wineScores.length, scores: wineScores });
  }
  rankings.sort((a, b) => b.average !== a.average ? b.average - a.average : a.stdDev - b.stdDev);
  let rank = 1;
  for (let i = 0; i < rankings.length; i++) {
    if (i > 0 && rankings[i].average === rankings[i-1].average && rankings[i].stdDev === rankings[i-1].stdDev) {
      rankings[i].rank = rankings[i-1].rank;
    } else { rankings[i].rank = rank; }
    rank++;
  }
  return rankings;
}

async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/config') {
    return json(res, { numWines: store.numWines, rankingsRevealed: store.rankingsRevealed });
  }

  if (method === 'POST' && pathname === '/api/join') {
    const body = await readBody(req);
    const { name, startingWine } = body;
    if (!name || !name.trim()) return json(res, { error: 'Name is required' }, 400);
    if (store.numWines === 0) return json(res, { error: 'The host has not set up the tasting yet. Please wait.' }, 400);
    const trimmedName = name.trim();
    const startNum = parseInt(startingWine);
    if (!startNum || startNum < 1 || startNum > store.numWines) {
      return json(res, { error: 'Starting wine must be between 1 and ' + store.numWines }, 400);
    }
    const existing = store.participants.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (existing) {
      return json(res, { success: true, name: existing.name, startingWine: existing.startingWine, numWines: store.numWines, scores: store.scores[existing.name] || {}, rejoined: true });
    }
    store.participants.push({ name: trimmedName, startingWine: startNum, joinedAt: new Date().toISOString() });
    store.scores[trimmedName] = {};
    return json(res, { success: true, name: trimmedName, startingWine: startNum, numWines: store.numWines, scores: {}, rejoined: false });
  }

  if (method === 'POST' && pathname === '/api/score') {
    const body = await readBody(req);
    const { name, wine, score } = body;
    if (!name || !wine || score === undefined) return json(res, { error: 'Name, wine, and score are required' }, 400);
    const wineNum = parseInt(wine);
    const scoreNum = parseInt(score);
    if (wineNum < 1 || wineNum > store.numWines) return json(res, { error: 'Invalid wine number' }, 400);
    if (scoreNum < 1 || scoreNum > 10) return json(res, { error: 'Score must be between 1 and 10' }, 400);
    const participant = store.participants.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!participant) return json(res, { error: 'Participant not found' }, 404);
    if (!store.scores[participant.name]) store.scores[participant.name] = {};
    store.scores[participant.name][wineNum] = scoreNum;
    return json(res, { success: true });
  }

  if (method === 'POST' && pathname === '/api/score/clear') {
    const body = await readBody(req);
    const { name, wine } = body;
    const participant = store.participants.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!participant) return json(res, { error: 'Participant not found' }, 404);
    if (store.scores[participant.name]) delete store.scores[participant.name][parseInt(wine)];
    return json(res, { success: true });
  }

  const scoresMatch = pathname.match(/^\/api\/scores\/(.+)$/);
  if (method === 'GET' && scoresMatch) {
    const nameParam = decodeURIComponent(scoresMatch[1]);
    const participant = store.participants.find(p => p.name.toLowerCase() === nameParam.toLowerCase());
    if (!participant) return json(res, { error: 'Participant not found' }, 404);
    return json(res, { name: participant.name, startingWine: participant.startingWine, scores: store.scores[participant.name] || {} });
  }

  if (method === 'GET' && pathname === '/api/rankings') {
    if (!store.rankingsRevealed) return json(res, { error: 'Rankings have not been revealed yet' }, 403);
    return json(res, computeRankings());
  }

  if (method === 'POST' && pathname === '/api/admin/login') {
    const body = await readBody(req);
    if (body.password === store.adminPassword) return json(res, { success: true });
    return json(res, { error: 'Incorrect password' }, 401);
  }

  if (method === 'POST' && pathname === '/api/admin/config') {
    if (!requireAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const body = await readBody(req);
    const num = parseInt(body.numWines);
    if (!num || num < 1 || num > 100) return json(res, { error: 'Number of wines must be between 1 and 100' }, 400);
    store.numWines = num;
    return json(res, { success: true, numWines: num });
  }

  if (method === 'POST' && pathname === '/api/admin/wine-names') {
    if (!requireAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const body = await readBody(req);
    if (body.names && typeof body.names === 'object') {
      store.wineNames = {};
      for (const [k, v] of Object.entries(body.names)) {
        const trimmed = String(v).trim();
        if (trimmed) store.wineNames[k] = trimmed;
      }
    }
    return json(res, { success: true, wineNames: store.wineNames });
  }

  if (method === 'GET' && pathname === '/api/admin/scores') {
    if (!requireAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, { numWines: store.numWines, rankingsRevealed: store.rankingsRevealed, participants: store.participants, scores: store.scores, wineNames: store.wineNames, rankings: computeRankings() });
  }

  if (method === 'POST' && pathname === '/api/admin/reveal') {
    if (!requireAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const body = await readBody(req);
    store.rankingsRevealed = !!body.revealed;
    return json(res, { success: true, rankingsRevealed: store.rankingsRevealed });
  }

  if (method === 'POST' && pathname === '/api/admin/reset') {
    if (!requireAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    store.participants = [];
    store.scores = {};
    store.wineNames = {};
    store.rankingsRevealed = false;
    return json(res, { success: true });
  }

  const pageRoutes = { '/': '/index.html', '/score': '/score.html', '/admin': '/admin.html', '/results': '/results.html' };
  let filePath;
  if (pageRoutes[pathname]) {
    filePath = path.join(__dirname, 'public', pageRoutes[pathname]);
  } else {
    filePath = path.join(__dirname, 'public', pathname);
  }
  const publicDir = path.join(__dirname, 'public');
  if (!path.resolve(filePath).startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  serveFile(res, filePath);
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log('Wine Tasting Scorer running on port ' + PORT);
});
