const fs = require('fs');
const path = require('path');

const LOGS_BASE = path.resolve('logs');

class ServiceLogger {
  constructor(serviceName, config) {
    this.serviceName = serviceName;
    this.enabled = config.log && config.log.enabled;
    this.retentionDays = config.log ? config.log.retentionDays : 7;
    this.dir = path.join(LOGS_BASE, serviceName);
    this.currentDate = null;
  }

  _ensureDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  _getDateStr(date) {
    const d = date || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  _currentLogPath() {
    return path.join(this.dir, 'current.log');
  }

  _dateLogPath(dateStr) {
    return path.join(this.dir, `${dateStr}.log`);
  }

  _mergeToDate(dateStr) {
    const src = this._currentLogPath();
    if (!fs.existsSync(src)) return;
    const dst = this._dateLogPath(dateStr);
    const content = fs.readFileSync(src, 'utf-8');
    if (content) {
      fs.appendFileSync(dst, content, 'utf-8');
    }
    fs.writeFileSync(src, '', 'utf-8');
  }

  _cleanup() {
    if (this.retentionDays <= 0) return;
    if (!fs.existsSync(this.dir)) return;
    const now = Date.now();
    const files = fs.readdirSync(this.dir);
    for (const file of files) {
      if (file === 'current.log' || !file.endsWith('.log')) continue;
      const fp = path.join(this.dir, file);
      const stat = fs.statSync(fp);
      if ((now - stat.mtimeMs) / 86400000 > this.retentionDays) {
        fs.unlinkSync(fp);
      }
    }
  }

  open() {
    if (!this.enabled) return;
    this._ensureDir();
    this.currentDate = this._getDateStr();
    const cp = this._currentLogPath();
    if (fs.existsSync(cp)) {
      const stat = fs.statSync(cp);
      const fileDate = this._getDateStr(new Date(stat.mtimeMs));
      if (fileDate !== this.currentDate) {
        this._mergeToDate(fileDate);
      }
    }
    this._cleanup();
  }

  write(data) {
    if (!this.enabled) return;
    const today = this._getDateStr();
    if (this.currentDate && this.currentDate !== today) {
      this._mergeToDate(this.currentDate);
      this.currentDate = today;
    }
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(this._currentLogPath(), `[${ts}] ${data}`, 'utf-8');
  }

  close() {
  }
}

module.exports = ServiceLogger;
