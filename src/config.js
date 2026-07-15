const fs = require('fs');
const path = require('path');

const SERVICES_DIR = path.join(__dirname, '..', 'services');

function loadServiceConfig(serviceName) {
  const filePath = path.join(SERVICES_DIR, `${serviceName}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw);
    const priority = typeof config.priority === 'number' ? config.priority : 0;
    return {
      cwd: config.cwd || '.',
      command: config.command || '',
      priority: Math.max(0, Math.min(999, priority)),
      maxRetries: typeof config.maxRetries === 'number' ? config.maxRetries : 3,
      retryOnAbnormalExit: config.retryOnAbnormalExit !== false,
      autoStart: config.autoStart === true,
      log: {
        enabled: config.log && config.log.enabled === true,
        retentionDays: config.log && typeof config.log.retentionDays === 'number'
          ? config.log.retentionDays : 7
      }
    };
  } catch {
    return null;
  }
}

function listServices() {
  if (!fs.existsSync(SERVICES_DIR)) {
    return [];
  }
  const files = fs.readdirSync(SERVICES_DIR);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

function loadAllServiceConfigs() {
  const names = listServices();
  const result = {};
  for (const name of names) {
    const cfg = loadServiceConfig(name);
    if (cfg) {
      result[name] = cfg;
    }
  }
  return result;
}

module.exports = { loadServiceConfig, listServices, loadAllServiceConfigs };
