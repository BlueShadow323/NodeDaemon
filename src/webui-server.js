const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_DURATION = 86400000;
const CLEANUP_INTERVAL = 3600000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_DURATION = 60000;

const sessions = new Map();
const loginAttempts = new Map();
const csrfTokens = new Map();
const webuiDir = path.join(__dirname, '..', 'webui');
const htmlCache = new Map();

let cleanupTimer = null;

function jsonResponse(res, code, message, data) {
  const body = { code, message };
  if (data !== undefined) body.data = data;
  res.statusCode = code;
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function generateCSRFToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(username) {
  const sessionId = generateSessionId();
  const csrfToken = generateCSRFToken();
  const session = {
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION
  };
  sessions.set(sessionId, session);
  csrfTokens.set(sessionId, csrfToken);
  return { sessionId, csrfToken };
}

function getSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) return null;
  const session = sessions.get(sessionId);
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    csrfTokens.delete(sessionId);
    return null;
  }
  return session;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const parts = c.trim().split('=');
    if (parts.length >= 2) cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
  });
  return cookies;
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now, blockedUntil: 0 });
    return true;
  }
  const record = loginAttempts.get(ip);
  if (now < record.blockedUntil) return false;
  if (now - record.firstAttempt > LOGIN_BLOCK_DURATION) {
    record.count = 1;
    record.firstAttempt = now;
    return true;
  }
  record.count++;
  if (record.count > MAX_LOGIN_ATTEMPTS) {
    record.blockedUntil = now + LOGIN_BLOCK_DURATION;
    return false;
  }
  return true;
}

function verifyCSRF(req, sessionId) {
  const tokenCookie = parseCookies(req.headers['cookie'])['csrf-token'];
  const tokenHeader = req.headers['x-csrf-token'];
  if (!tokenCookie || !tokenHeader) return false;
  const storedToken = csrfTokens.get(sessionId);
  if (!storedToken) return false;
  return crypto.timingSafeEqual(Buffer.from(storedToken), Buffer.from(tokenHeader)) &&
         crypto.timingSafeEqual(Buffer.from(storedToken), Buffer.from(tokenCookie));
}

function requireAuth(req, res) {
  const cookies = parseCookies(req.headers['cookie']);
  const sessionId = cookies['session-id'];
  if (!sessionId) return null;
  const session = getSession(sessionId);
  if (!session) {
    res.setHeader('Set-Cookie', 'session-id=; Max-Age=0; Path=/webui; HttpOnly; SameSite=Lax');
    return null;
  }
  return sessionId;
}

function callDaemonAPI(daemonPort, daemonSecret, method, apiPath, bodyData) {
  return new Promise((resolve) => {
    const timestamp = String(Date.now());
    const bodyStr = bodyData ? JSON.stringify(bodyData) : '';
    const hmac = crypto.createHmac('sha256', daemonSecret);
    hmac.update(timestamp + bodyStr);
    const signature = hmac.digest('hex');
    const options = {
      hostname: '127.0.0.1',
      port: daemonPort,
      path: apiPath,
      method,
      headers: {
        'X-Timestamp': timestamp,
        'X-Signature': signature,
        'Content-Type': 'application/json'
      }
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ code: 500, message: 'Invalid response from daemon' });
        }
      });
    });
    req.on('error', () => {
      resolve({ code: 500, message: 'Daemon server unreachable' });
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function getMimeType(ext) {
  const mimes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };
  return mimes[ext] || 'application/octet-stream';
}

function serveStaticFile(res, filePath) {
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(webuiDir)) {
    jsonResponse(res, 403, 'Forbidden');
    return;
  }
  const mime = getMimeType(path.extname(normalized));
  const cached = htmlCache.get(normalized);
  if (cached) {
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(cached);
    return;
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      jsonResponse(res, 404, 'Not found');
      return;
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-cache');
    if (mime.startsWith('text/') || mime.startsWith('application/javascript')) {
      htmlCache.set(normalized, data);
    }
    res.end(data);
  });
}

let watcherActive = false;
function watchWebUIDir() {
  if (watcherActive || !fs.existsSync(webuiDir)) return;
  try {
    watcherActive = true;
    fs.watch(webuiDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const filePath = path.join(webuiDir, filename);
      const normalized = path.normalize(filePath);
      if (htmlCache.has(normalized)) {
        htmlCache.delete(normalized);
      }
    });
  } catch (e) { /* watcher not critical */ }
}

function getServicesData(configLoader) {
  const names = configLoader.listServices();
  const configs = {};
  for (const name of names) {
    const cfg = configLoader.loadServiceConfig(name);
    if (cfg) configs[name] = cfg;
  }
  return { names, configs };
}

function createWebUIServer(serviceManager, configLoader, daemonPort, daemonSecret, webuiConfig) {
  const webuiLang = webuiConfig.lang || 'zh-CN';
  if (cleanupTimer) clearInterval(cleanupTimer);
  watchWebUIDir();
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now > session.expiresAt) {
        sessions.delete(id);
        csrfTokens.delete(id);
      }
    }
    for (const [ip, record] of loginAttempts) {
      if (now - record.firstAttempt > LOGIN_BLOCK_DURATION * 2) {
        loginAttempts.delete(ip);
      }
    }
  }, CLEANUP_INTERVAL);

  return http.createServer((req, res) => {
    setSecurityHeaders(res);

    const url = req.url;
    const method = req.method;
    const pathname = url.split('?')[0];

    if (pathname === '/webui/api/login' && method === 'POST') {
      let bodyRaw = [];
      let bodySize = 0;
      req.on('error', () => { jsonResponse(res, 400, 'Request error'); });
      req.on('data', chunk => {
        bodySize += chunk.length;
        if (bodySize > 4096) req.destroy();
        else bodyRaw.push(chunk);
      });
      req.on('end', () => {
        if (bodySize > 4096) { jsonResponse(res, 413, 'Request body too large'); return; }
        let body;
        try { body = JSON.parse(Buffer.concat(bodyRaw).toString()); } catch { jsonResponse(res, 400, 'Invalid JSON'); return; }
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();
        if (!username || !password) { jsonResponse(res, 400, 'Username and password required'); return; }
        if (username.length > 64 || password.length > 128) { jsonResponse(res, 400, 'Invalid credentials'); return; }
        const ip = getClientIP(req);
        if (!checkLoginRateLimit(ip)) { jsonResponse(res, 429, 'Too many login attempts, please wait'); return; }
        if (username !== webuiConfig.username || password !== webuiConfig.password) { jsonResponse(res, 401, 'Invalid username or password'); return; }
        const { sessionId, csrfToken } = createSession(username);
        res.setHeader('Set-Cookie', [
          `session-id=${sessionId}; Max-Age=${SESSION_DURATION / 1000}; Path=/webui; HttpOnly; SameSite=Lax`,
          `csrf-token=${csrfToken}; Max-Age=${SESSION_DURATION / 1000}; Path=/webui; SameSite=Lax`
        ]);
        jsonResponse(res, 200, 'OK', { username });
      });
      return;
    }

    if (pathname === '/webui/api/logout' && method === 'POST') {
      const sessionId = requireAuth(req, res);
      if (!sessionId) { jsonResponse(res, 401, 'Not authenticated'); return; }
      if (!verifyCSRF(req, sessionId)) { jsonResponse(res, 403, 'Invalid CSRF token'); return; }
      sessions.delete(sessionId);
      csrfTokens.delete(sessionId);
      res.setHeader('Set-Cookie', [
        'session-id=; Max-Age=0; Path=/webui; HttpOnly; SameSite=Lax',
        'csrf-token=; Max-Age=0; Path=/webui; SameSite=Lax'
      ]);
      jsonResponse(res, 200, 'OK');
      return;
    }

    if (pathname === '/webui/api/services' && method === 'GET') {
      const sessionId = requireAuth(req, res);
      if (!sessionId) { jsonResponse(res, 401, 'Not authenticated'); return; }
      if (!verifyCSRF(req, sessionId)) { jsonResponse(res, 403, 'Invalid CSRF token'); return; }
      const servicesData = getServicesData(configLoader);
      const names = servicesData.names;
      const statuses = {};
      for (const name of names) {
        const daemonStatus = serviceManager.getDetailedStatus(name);
        const config = servicesData.configs[name];
        statuses[name] = {
          running: daemonStatus.running,
          operation: daemonStatus.operation,
          duration: daemonStatus.duration,
          abnormalExitCount: daemonStatus.abnormalExitCount,
          command: config ? config.command : '',
          cwd: config ? config.cwd : '',
          autoStart: config ? config.autoStart : false,
          priority: config ? config.priority : 0,
          maxRetries: config ? config.maxRetries : 3,
          retryOnAbnormalExit: config ? config.retryOnAbnormalExit : true,
          log: config ? config.log : { enabled: false, retentionDays: 7 }
        };
      }
      jsonResponse(res, 200, 'OK', statuses);
      return;
    }

    const serviceActionMatch = pathname.match(/^\/webui\/api\/service\/([^/]+)\/(start|stop|restart|force-stop)$/);
    if (serviceActionMatch && method === 'POST') {
      const sessionId = requireAuth(req, res);
      if (!sessionId) { jsonResponse(res, 401, 'Not authenticated'); return; }
      if (!verifyCSRF(req, sessionId)) { jsonResponse(res, 403, 'Invalid CSRF token'); return; }
      const name = decodeURIComponent(serviceActionMatch[1]);
      const action = serviceActionMatch[2];
      const config = configLoader.loadServiceConfig(name);
      if (!config) { jsonResponse(res, 404, `Service ${name} not found`); return; }
      const handleDaemonResponse = (result) => {
        jsonResponse(res, result.success ? 200 : 500, result.message);
      };
      switch (action) {
        case 'start':
          serviceManager.start(name, config).then(handleDaemonResponse);
          break;
        case 'stop':
          handleDaemonResponse(serviceManager.stop(name));
          break;
        case 'restart':
          serviceManager.restart(name, config).then(handleDaemonResponse);
          break;
        case 'force-stop':
          handleDaemonResponse(serviceManager.forceStop(name));
          break;
      }
      return;
    }

    if (pathname === '/webui/api/service/new' && method === 'POST') {
      const sessionId = requireAuth(req, res);
      if (!sessionId) { jsonResponse(res, 401, 'Not authenticated'); return; }
      if (!verifyCSRF(req, sessionId)) { jsonResponse(res, 403, 'Invalid CSRF token'); return; }
      let bodyRaw = [];
      req.on('data', chunk => bodyRaw.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(bodyRaw).toString());
          const id = (body.id || '').trim();
          if (!id || !/^[a-zA-Z0-9_\-]+$/.test(id)) { jsonResponse(res, 400, 'Invalid service ID: only letters, numbers, hyphens and underscores allowed'); return; }
          if (configLoader.loadServiceConfig(id)) { jsonResponse(res, 409, `Service '${id}' already exists`); return; }
          configLoader.saveServiceConfig(id, body);
          jsonResponse(res, 200, `Service '${id}' created`);
        } catch (e) { jsonResponse(res, 400, 'Invalid JSON body'); }
      });
      return;
    }

    const editMatch = pathname.match(/^\/webui\/api\/service\/([^/]+)\/edit$/);
    if (editMatch && method === 'POST') {
      const sessionId = requireAuth(req, res);
      if (!sessionId) { jsonResponse(res, 401, 'Not authenticated'); return; }
      if (!verifyCSRF(req, sessionId)) { jsonResponse(res, 403, 'Invalid CSRF token'); return; }
      const name = decodeURIComponent(editMatch[1]);
      if (!configLoader.loadServiceConfig(name)) { jsonResponse(res, 404, `Service '${name}' not found`); return; }
      const editStatus = serviceManager.getDetailedStatus(name);
      if (editStatus.running) { jsonResponse(res, 409, `Service '${name}' is still running. Stop it first before editing.`); return; }
      if (editStatus.operation) { jsonResponse(res, 409, `Service '${name}' has an operation in progress.`); return; }
      let bodyRaw = [];
      req.on('data', chunk => bodyRaw.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(bodyRaw).toString());
          delete body.id;
          configLoader.saveServiceConfig(name, body);
          jsonResponse(res, 200, `Service '${name}' updated`);
        } catch (e) { jsonResponse(res, 400, 'Invalid JSON body'); }
      });
      return;
    }

    const deleteMatch = pathname.match(/^\/webui\/api\/service\/([^/]+)\/delete$/);
    if (deleteMatch && method === 'POST') {
      const sessionId = requireAuth(req, res);
      if (!sessionId) { jsonResponse(res, 401, 'Not authenticated'); return; }
      if (!verifyCSRF(req, sessionId)) { jsonResponse(res, 403, 'Invalid CSRF token'); return; }
      const name = decodeURIComponent(deleteMatch[1]);
      if (!configLoader.loadServiceConfig(name)) { jsonResponse(res, 404, `Service '${name}' not found`); return; }
      const status = serviceManager.getDetailedStatus(name);
      if (status.running) { jsonResponse(res, 409, `Service '${name}' is still running. Stop it first before deleting.`); return; }
      if (status.operation) { jsonResponse(res, 409, `Service '${name}' has an operation in progress. Wait for it to complete.`); return; }
      configLoader.deleteServiceConfig(name);
      jsonResponse(res, 200, `Service '${name}' deleted`);
      return;
    }

    if (pathname === '/webui/api/server-status' && method === 'GET') {
      const sessionId = requireAuth(req, res);
      if (!sessionId) { jsonResponse(res, 401, 'Not authenticated'); return; }
      if (!verifyCSRF(req, sessionId)) { jsonResponse(res, 403, 'Invalid CSRF token'); return; }
      const daemonResult = callDaemonAPI(daemonPort, daemonSecret, 'POST', '/os/status');
      daemonResult.then(result => {
        if (result.code === 200 && result.data) {
          jsonResponse(res, 200, 'OK', result.data);
        } else {
          jsonResponse(res, 502, 'Failed to get server status');
        }
      });
      return;
    }

    if (pathname === '/') {
      res.statusCode = 302;
      res.setHeader('Location', '/webui/');
      res.end();
      return;
    }

    if (pathname.startsWith('/webui/') || pathname === '/webui') {
      if (pathname === '/webui' || pathname === '/webui/' || pathname === '/webui/index.html') {
        serveStaticFile(res, path.join(webuiDir, 'index.html'));
        return;
      }
      const apiPatterns = ['/webui/api/login', '/webui/api/logout', '/webui/api/config', '/webui/api/services', '/webui/api/service/', '/webui/api/server-status'];
      for (const p of apiPatterns) {
        if (pathname === p || pathname.startsWith(p)) {
          jsonResponse(res, 404, 'Not found');
          return;
        }
      }
      const filePath = path.join(webuiDir, pathname.replace(/^\/webui\//, ''));
      serveStaticFile(res, filePath);
      return;
    }

    jsonResponse(res, 404, 'Not found');
  });
}

module.exports = { createWebUIServer };
