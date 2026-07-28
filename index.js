require('dotenv').config();

const configLoader = require('./src/config');
const ServiceManager = require('./src/service-manager');
const { createServer } = require('./src/server');
const { createWebUIServer } = require('./src/webui-server');

const PORT = parseInt(process.env.DAEMON_PORT, 10) || 10300;
const SECRET = process.env.DAEMON_SECRET_KEY;
const WEBUI_ENABLED = process.env.WEBUI_ENABLED === 'true';
const WEBUI_PORT = parseInt(process.env.WEBUI_PORT, 10) || 10400;
const WEBUI_USERNAME = (process.env.WEBUI_USERNAME || 'admin').trim();
const WEBUI_PASSWORD = (process.env.WEBUI_PASSWORD || 'admin').trim();
const WEBUI_LANG = (process.env.WEBUI_LANG || 'zh-CN').trim();

if (!SECRET) {
  console.error('DAEMON_SECRET_KEY environment variable is required');
  process.exit(1);
}

const serviceManager = new ServiceManager(configLoader);

async function startAutoServices() {
  const configs = configLoader.loadAllServiceConfigs();
  const entries = Object.entries(configs)
    .filter(([, config]) => config.autoStart)
    .sort((a, b) => b[1].priority - a[1].priority);
  for (const [name, config] of entries) {
    const result = await serviceManager.start(name, config);
    if (result.success) {
      console.log(`[daemon] Auto-started service: ${name}`);
    }
  }
}

const server = createServer(serviceManager, configLoader, SECRET);

server.listen(PORT, () => {
  console.log(`[daemon] Listening on port ${PORT}`);
  startAutoServices();
});

if (WEBUI_ENABLED) {
  const webuiConfig = { username: WEBUI_USERNAME, password: WEBUI_PASSWORD, lang: WEBUI_LANG };
  const webuiServer = createWebUIServer(serviceManager, configLoader, PORT, SECRET, webuiConfig);
  webuiServer.listen(WEBUI_PORT, () => {
    console.log(`[webui] Web UI available at http://localhost:${WEBUI_PORT}/webui/`);
  });
}

function shutdown() {
  console.log('\n[daemon] Shutting down...');
  serviceManager.stopAll();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('\n[daemon] Uncaught exception:', err.message);
  serviceManager.stopAll();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('\n[daemon] Unhandled rejection:', err.message);
  serviceManager.stopAll();
  process.exit(1);
});
process.on('exit', () => { serviceManager.stopAll(); });
