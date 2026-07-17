const http = require('http');
const crypto = require('crypto');
const os = require('os');

function jsonResponse(res, code, message, data) {
  const body = { code, message };
  if (data !== undefined) {
    body.data = data;
  }
  res.statusCode = code;
  res.end(JSON.stringify(body));
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Signature, X-Timestamp');
}

function verifySignature(body, signature, timestamp, secret) {
  if (!secret || !signature || !timestamp) return false;
  if (typeof signature !== 'string' || signature.length !== 64 || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const now = Date.now();
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 300000) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(timestamp + body);
  const expected = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function getCPUMeasure() {
  const cpus = os.cpus();
  let idle = 0;
  let tick = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    tick += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, tick };
}

async function getServerStatus() {
  const m1 = getCPUMeasure();
  await new Promise(r => setTimeout(r, 100));
  const m2 = getCPUMeasure();
  const idleDiff = m2.idle - m1.idle;
  const tickDiff = m2.tick - m1.tick;
  const cpuUsage = tickDiff > 0 ? parseFloat(((1 - idleDiff / tickDiff) * 100).toFixed(1)) : 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  return {
    cpu: cpuUsage,
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usage: parseFloat(((usedMem / totalMem) * 100).toFixed(1))
    },
    uptime: Math.floor(os.uptime()),
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname()
  };
}

function createServer(serviceManager, configLoader, secret) {
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      jsonResponse(res, 405, 'Method not allowed');
      return;
    }

    const controlMatch = req.url.match(/^\/service\/control\/([^/]+)$/);
    const statusMatch = req.url.match(/^\/service\/status\/([^/]+)$/);
    const statusAllMatch = req.url === '/service/status';
    const serverStatusMatch = req.url === '/os/status';
    const listServiceMatch = req.url === '/service/list';

    if (!controlMatch && !statusMatch && !statusAllMatch && !serverStatusMatch && !listServiceMatch) {
      jsonResponse(res, 404, 'Not found');
      return;
    }

    const signature = req.headers['x-signature'];
    const timestamp = req.headers['x-timestamp'];

    if (listServiceMatch) {
      if (!verifySignature('', signature, timestamp, secret)) {
        jsonResponse(res, 401, 'Invalid signature');
        return;
      }
      const services = configLoader.listServices();
      jsonResponse(res, 200, 'OK', services);
      return;
    }

    if (statusAllMatch) {
      if (!verifySignature('', signature, timestamp, secret)) {
        jsonResponse(res, 401, 'Invalid signature');
        return;
      }
      const names = configLoader.listServices();
      const allStatus = {};
      for (const name of names) {
        allStatus[name] = serviceManager.getDetailedStatus(name);
      }
      jsonResponse(res, 200, 'OK', allStatus);
      return;
    }

    if (serverStatusMatch) {
      if (!verifySignature('', signature, timestamp, secret)) {
        jsonResponse(res, 401, 'Invalid signature');
        return;
      }
      const data = await getServerStatus();
      jsonResponse(res, 200, 'OK', data);
      return;
    }

    if (statusMatch) {
      const serviceName = statusMatch[1];
      if (!verifySignature('', signature, timestamp, secret)) {
        jsonResponse(res, 401, 'Invalid signature');
        return;
      }
      const config = configLoader.loadServiceConfig(serviceName);
      if (!config) {
        jsonResponse(res, 404, `Service ${serviceName} not found`);
        return;
      }
      const status = serviceManager.getDetailedStatus(serviceName);
      jsonResponse(res, 200, 'OK', status);
      return;
    }

    const serviceName = controlMatch[1];
    const bodyRaw = [];
    let bodySize = 0;
    const MAX_BODY = 1048576;

    req.on('error', () => {
      jsonResponse(res, 413, 'Request body too large');
    });

    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        req.destroy();
        return;
      }
      bodyRaw.push(chunk);
    });
    req.on('end', async () => {
      try {
        if (bodySize > MAX_BODY) {
          jsonResponse(res, 413, 'Request body too large');
          return;
        }
        const rawBody = Buffer.concat(bodyRaw).toString();

      if (!verifySignature(rawBody, signature, timestamp, secret)) {
        jsonResponse(res, 401, 'Invalid signature');
        return;
      }

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        jsonResponse(res, 400, 'Invalid JSON body');
        return;
      }

      const config = configLoader.loadServiceConfig(serviceName);
      if (!config) {
        jsonResponse(res, 404, `Service ${serviceName} not found`);
        return;
      }

      let result;
      switch (body.type) {
        case 'start':
          result = await serviceManager.start(serviceName, config);
          break;
        case 'stop':
          result = serviceManager.stop(serviceName);
          break;
        case 'restart':
          result = await serviceManager.restart(serviceName, config);
          break;
        case 'force-stop':
          result = serviceManager.forceStop(serviceName);
          break;
        default:
          jsonResponse(res, 400, 'Invalid type, must be start/stop/restart/force-stop');
          return;
      }

      jsonResponse(res, result.success ? 200 : 500, result.message);
      } catch (err) {
        jsonResponse(res, 500, err.message);
      }
    });
  });
}

module.exports = { createServer };
