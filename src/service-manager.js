const { spawn, execSync } = require('child_process');
const path = require('path');
const ServiceLogger = require('./logger');

function killProcessTree(pid, force) {
  if (process.platform === 'win32') {
    const args = [`/pid`, String(pid), `/T`];
    if (force) args.push('/F');
    try {
      execSync(`taskkill ${args.join(' ')}`, { stdio: 'ignore' });
    } catch {}
    return;
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';

  try {
    const result = execSync(`ps -o pid= --ppid ${pid}`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const lines = result.trim().split('\n');
    for (const line of lines) {
      const childPid = parseInt(line.trim(), 10);
      if (!isNaN(childPid)) {
        killProcessTree(childPid, force);
      }
    }
  } catch {}

  try {
    process.kill(pid, signal);
  } catch {}
}

class ServiceManager {
  constructor(configLoader) {
    this.processes = {};
    this.loggers = {};
    this.retryCounts = {};
    this.startTimes = {};
    this.pendingOps = {};
    this.stopping = {};
    this.retryTimers = {};
    this.configLoader = configLoader;
  }

  async start(name, config, isRetry) {
    if (this.processes[name]) {
      return { success: false, message: `Service ${name} is already running` };
    }

    this.pendingOps[name] = 'starting';

    const logger = new ServiceLogger(name, config);
    this.loggers[name] = logger;
    logger.open();

    const cwd = path.resolve(config.cwd);
    const cmd = config.command;

    return new Promise((resolve) => {
      try {
        const spawnOptions = {
          cwd,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        };
        if (process.platform !== 'win32') {
          spawnOptions.setpgid = true;
        }
        const child = spawn(cmd, [], spawnOptions);

        this.processes[name] = child;
        if (!isRetry) {
          this.retryCounts[name] = 0;
        }
        this.startTimes[name] = Date.now();
        delete this.pendingOps[name];

        child.stdout.on('data', (data) => {
          logger.write(data.toString());
        });

        child.stderr.on('data', (data) => {
          logger.write(data.toString());
        });

        child.on('error', (err) => {
          delete this.processes[name];
          delete this.startTimes[name];
          delete this.pendingOps[name];
          const l = this.loggers[name];
          if (l) {
            l.write(`Failed to start: ${err.message}\n`);
            l.close();
            delete this.loggers[name];
          }
          resolve({ success: false, message: `Failed to start ${name}: ${err.message}` });
        });

        child.on('exit', (code, signal) => {
          if (this.processes[name] !== child) return;
          delete this.processes[name];
          delete this.startTimes[name];
          const l = this.loggers[name];
          if (l) {
            l.write(`Process exited with code ${code}, signal ${signal}\n`);
            l.close();
            delete this.loggers[name];
          }

          if (this.stopping[name]) {
            delete this.stopping[name];
            return;
          }

          const abnormal = code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL';
          if (abnormal && config.retryOnAbnormalExit) {
            this.retryCounts[name] = (this.retryCounts[name] || 0) + 1;
            if (this.retryCounts[name] <= config.maxRetries) {
              this.retryTimers[name] = setTimeout(() => {
                delete this.retryTimers[name];
                if (this.stopping[name]) {
                  delete this.stopping[name];
                  return;
                }
                const freshConfig = this.configLoader.loadServiceConfig(name);
                if (freshConfig) {
                  this.start(name, freshConfig, true);
                }
              }, 1000);
            }
          }
        });

        resolve({ success: true, message: `Service ${name} started` });
      } catch (err) {
        delete this.loggers[name];
        delete this.pendingOps[name];
        resolve({ success: false, message: err.message });
      }
    });
  }

  stop(name) {
    this.stopping[name] = true;
    clearTimeout(this.retryTimers[name]);
    delete this.retryTimers[name];
    const child = this.processes[name];
    if (!child) {
      return { success: false, message: `Service ${name} is not running` };
    }

    this.pendingOps[name] = 'stopping';

    const l = this.loggers[name];
    if (l) {
      l.write(`Process stopped by daemon\n`);
      l.close();
      delete this.loggers[name];
    }

    const pid = child.pid;
    killProcessTree(pid, false);
    killProcessTree(pid, true);
    delete this.processes[name];
    delete this.startTimes[name];
    delete this.pendingOps[name];

    return { success: true, message: `Service ${name} stopped` };
  }

  forceStop(name) {
    this.stopping[name] = true;
    clearTimeout(this.retryTimers[name]);
    delete this.retryTimers[name];
    const child = this.processes[name];
    if (!child) {
      return { success: false, message: `Service ${name} is not running` };
    }

    this.pendingOps[name] = 'force-stopping';

    const l = this.loggers[name];
    if (l) {
      l.close();
      delete this.loggers[name];
    }

    const pid = child.pid;
    killProcessTree(pid, true);
    delete this.processes[name];
    delete this.startTimes[name];
    delete this.pendingOps[name];

    return { success: true, message: `Service ${name} force stopped` };
  }

  async restart(name, config) {
    this.pendingOps[name] = 'restarting';
    this.stopping[name] = true;
    clearTimeout(this.retryTimers[name]);
    delete this.retryTimers[name];
    if (this.processes[name]) {
      const l = this.loggers[name];
      if (l) {
        l.write(`Process stopped by daemon\n`);
        l.close();
        delete this.loggers[name];
      }
      killProcessTree(this.processes[name].pid, false);
      killProcessTree(this.processes[name].pid, true);
      delete this.processes[name];
      delete this.startTimes[name];
    }
    const result = await this.start(name, config);
    delete this.stopping[name];
    return result;
  }

  stopAll() {
    const names = Object.keys(this.processes);
    for (const name of names) {
      clearTimeout(this.retryTimers[name]);
      delete this.retryTimers[name];
      this.stop(name);
    }
  }

  getDetailedStatus(name) {
    const running = !!this.processes[name];
    const startTime = this.startTimes[name] || null;
    const retryCount = this.retryCounts[name] || 0;
    const pendingOp = this.pendingOps[name] || null;

    let duration = null;
    if (running && startTime) {
      duration = Math.floor((Date.now() - startTime) / 1000);
    }

    return {
      running,
      operation: pendingOp,
      duration,
      abnormalExitCount: retryCount
    };
  }
}

module.exports = ServiceManager;
