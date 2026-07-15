require('dotenv').config();

const configLoader = require('./src/config');
const ServiceManager = require('./src/service-manager');
const { createServer } = require('./src/server');

const PORT = parseInt(process.env.DAEMON_PORT, 10) || 10300;
const SECRET = process.env.DAEMON_SECRET_KEY;

if (!SECRET) {
  console.error('DAEMON_SECRET_KEY environment variable is required');
  process.exit(1);
}

const serviceManager = new ServiceManager();

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

process.on('SIGINT', async () => {
  console.log('\n[daemon] Shutting down...');
  await serviceManager.stopAll();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', async () => {
  console.log('[daemon] Shutting down...');
  await serviceManager.stopAll();
  server.close(() => process.exit(0));
});
