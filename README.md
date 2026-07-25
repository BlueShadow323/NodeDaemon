# Node Daemon

English | [简体中文](./README_CN.md)

<p>
  <img src="https://img.shields.io/badge/node-%3E%3D12.0.0-brightgreen" alt="Node Version" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/dependencies-dotenv-yellow" alt="Dependencies" />
</p>

A lightweight cross-platform daemon for managing background services — start, stop, restart, and auto-restart.

---

## Quick Start

### Install Dependencies

```bash
npm install
```

### Configure Environment Variables

Create a `.env` file in the project root (or set environment variables directly in your system):

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DAEMON_PORT` | HTTP server listening port | No | `10300` |
| `DAEMON_SECRET_KEY` | HMAC signing key for API authentication | **Yes** | — |

Example `.env`:

```
DAEMON_PORT=10300
DAEMON_SECRET_KEY=your-secret-key-here
```

A template is available at `.env.example`.

### Start the Daemon

```bash
npm start
```

On startup, the daemon automatically loads all services with `autoStart: true` from the `services/` directory and starts them in order of priority.

---

## Service Configuration

Define a managed service by creating `{serviceName}.json` in the `services/` directory.

### Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | `""` | Command to execute, e.g. `"npm run dev"`, `"node app.js"` |
| `cwd` | string | `"."` | Working directory for the command |
| `priority` | number | `0` | Startup priority (0-999). Higher values start first. Multiple services may share the same value |
| `autoStart` | boolean | `false` | Whether to auto-start this service when the daemon boots |
| `maxRetries` | number | `3` | Maximum auto-restart attempts after abnormal exit |
| `retryOnAbnormalExit` | boolean | `true` | Whether to auto-restart on abnormal exit. Set to `false` to disable |
| `log.enabled` | boolean | `false` | Enable log file output for stdout/stderr |
| `log.retentionDays` | number | `7` | Number of days to retain log files; older logs are cleaned automatically |

### Full Configuration Example

```json
{
  "cwd": "/opt/myapp/server",
  "command": "npm run dev",
  "priority": 500,
  "maxRetries": 3,
  "retryOnAbnormalExit": true,
  "autoStart": true,
  "log": {
    "enabled": true,
    "retentionDays": 7
  }
}
```

### Adding Multiple Services

Simply create multiple `.json` files in the `services/` directory. Each file represents one service; the filename (without `.json`) becomes the service name.

### Cross-Platform Path Configuration

The `cwd` field specifies the working directory for your service's command. Format it according to your OS:

**Windows:**
- Use backslashes (`\`) — must be escaped in JSON as `\\`
  ```json
  { "cwd": "C:\\Projects\\MyApp\\Server" }
  ```
- Or use forward slashes — Node.js accepts them on Windows
  ```json
  { "cwd": "C:/Projects/MyApp/Server" }
  ```
- Relative paths are also supported and resolved from the daemon's root directory
  ```json
  { "cwd": "../MyApp/Server" }
  ```

**Linux / macOS:**
- Use forward slashes (`/`)
  ```json
  { "cwd": "/home/user/projects/myapp/server" }
  ```
- Relative paths work the same way
  ```json
  { "cwd": "../myapp/server" }
  ```

**Portable (works across platforms):**
- Avoid hardcoded absolute paths when possible by using relative paths
- Environment variables in the command are expanded by the shell
  ```json
  { "command": "node $HOME/app/server.js" }
  ```

**The `command` field:**
- On **Windows**: you can use any command recognized by `cmd.exe` (e.g., `npm run dev`, `node app.js`, `python app.py`)
- On **Linux / macOS**: commands are executed via `sh` (e.g., `npm run dev`, `python3 app.py`, `./myapp`)

---

## HTTP API

### Authentication

All endpoints use HMAC-SHA256 signature authentication. Every request must include these headers:

| Header | Description |
|--------|-------------|
| `X-Timestamp` | Current Unix timestamp in milliseconds, e.g. `1710400000000` |
| `X-Signature` | HMAC-SHA256 hex digest |

Signature formula:

```
X-Signature = HMAC-SHA256(X-Timestamp + requestBody, DAEMON_SECRET_KEY)
```

- `X-Timestamp` and `requestBody` are concatenated as raw strings before hashing
- For endpoints without a request body, use an empty string `""`

Node.js signing example:

```javascript
const crypto = require('crypto');

const timestamp = String(Date.now());
const body = JSON.stringify({ type: 'start' });
const secret = 'your-secret-key-here';

const hmac = crypto.createHmac('sha256', secret);
hmac.update(timestamp + body);
const signature = hmac.digest('hex');
```

### Common Response Format

```json
{
  "code": 200,
  "message": "OK",
  "data": { }
}
```

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad request (e.g., invalid JSON, missing `type` field) |
| 401 | Signature verification failed |
| 404 | Endpoint not found, or the specified service does not exist |
| 405 | Only POST method is allowed |

---

### Endpoint 1: Control Service (Start / Stop / Restart)

```
POST /service/control/{serviceName}
```

**Headers:**

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-Timestamp` | Current Unix timestamp in milliseconds |
| `X-Signature` | HMAC-SHA256(`X-Timestamp` + requestBody, secret) |

**Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Operation type: `"start"`, `"stop"`, `"restart"`, or `"force-stop"` |

**cURL Example:**

```bash
SECRET="your-secret-key-here"
TIMESTAMP=$(date +%s000)
BODY='{"type":"start"}'
SIGNATURE=$(echo -n "${TIMESTAMP}${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST http://localhost:10300/service/control/my-service \
  -H "Content-Type: application/json" \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Signature: $SIGNATURE" \
  -d "$BODY"
```

---

### Endpoint 2: Query Service Status

```
POST /service/status/{serviceName}
```

Query a single service status. To get status of all services at once, call `POST /service/status` without a service name.

**Headers:**

| Header | Value |
|--------|-------|
| `X-Timestamp` | Current Unix timestamp in milliseconds |
| `X-Signature` | HMAC-SHA256(`X-Timestamp` + `""`, secret) (empty request body) |

**Request Body:** None

**Response `data` Fields (single service):**

| Field | Type | Description |
|-------|------|-------------|
| `running` | boolean | Whether the service is currently running |
| `operation` | string or null | Pending operation: `"starting"`, `"stopping"`, `"restarting"`, or `null` |
| `duration` | number or null | Running duration in seconds, or `null` if not running |
| `abnormalExitCount` | number | Number of abnormal exits (auto-restart count) |

**Response Example (single service):**

```json
{
  "code": 200,
  "message": "OK",
  "data": {
    "running": true,
    "operation": null,
    "duration": 3600,
    "abnormalExitCount": 2
  }
}
```

**cURL Example:**

```bash
SECRET="your-secret-key-here"
TIMESTAMP=$(date +%s000)
SIGNATURE=$(echo -n "${TIMESTAMP}" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST http://localhost:10300/service/status/my-service \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Signature: $SIGNATURE"
```

**All Services Status:**

```
POST /service/status
```

Returns all configured services' status as an object keyed by service name.

**Response `data` Fields (all services):**

| Field | Type | Description |
|-------|------|-------------|
| `{serviceName}` | object | Status object for each service (same fields as single status) |

**Response Example (all services):**

```json
{
  "code": 200,
  "message": "OK",
  "data": {
    "my-app": {
      "running": true,
      "operation": null,
      "duration": 3600,
      "abnormalExitCount": 0
    },
    "my-other-app": {
      "running": false,
      "operation": null,
      "duration": null,
      "abnormalExitCount": 1
    }
  }
}
```

---

### Endpoint 3: List All Services

```
POST /service/list
```

**Headers:**

| Header | Value |
|--------|-------|
| `X-Timestamp` | Current Unix timestamp in milliseconds |
| `X-Signature` | HMAC-SHA256(`X-Timestamp` + `""`, secret) (empty request body) |

**Request Body:** None

**Response `data` Fields:**

| Field | Type | Description |
|-------|------|-------------|
| (array) | string[] | List of all configured service IDs (filenames without `.json` extension) |

**Response Example:**

```json
{
  "code": 200,
  "message": "OK",
  "data": [
    "my-app",
    "my-other-app"
  ]
}
```

**cURL Example:**

```bash
SECRET="your-secret-key-here"
TIMESTAMP=$(date +%s000)
SIGNATURE=$(echo -n "${TIMESTAMP}" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST http://localhost:10300/service/list \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Signature: $SIGNATURE"
```

---

### Endpoint 4: Query Daemon Server Status

```
POST /os/status
```

**Headers:**

| Header | Value |
|--------|-------|
| `X-Timestamp` | Current Unix timestamp in milliseconds |
| `X-Signature` | HMAC-SHA256(`X-Timestamp` + `""`, secret) (empty request body) |

**Request Body:** None

**Response `data` Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `cpu` | number | Current CPU usage percentage (0–100) |
| `memory.total` | number | Total physical memory in bytes |
| `memory.used` | number | Used physical memory in bytes |
| `memory.free` | number | Free physical memory in bytes |
| `memory.usage` | number | Memory usage percentage (0–100) |
| `uptime` | number | System running time in seconds |
| `platform` | string | Operating system platform (`win32`, `linux`, `darwin`, etc.) |
| `arch` | string | CPU architecture (`x64`, `arm64`, etc.) |
| `hostname` | string | Hostname of the machine |

**Response Example:**

```json
{
  "code": 200,
  "message": "OK",
  "data": {
    "cpu": 12.5,
    "memory": {
      "total": 17179869184,
      "used": 8589934592,
      "free": 8589934592,
      "usage": 50.0
    },
    "uptime": 86400,
    "platform": "win32",
    "arch": "x64",
    "hostname": "my-server"
  }
}
```

**cURL Example:**

```bash
SECRET="your-secret-key-here"
TIMESTAMP=$(date +%s000)
SIGNATURE=$(echo -n "${TIMESTAMP}" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST http://localhost:10300/os/status \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Signature: $SIGNATURE"
```

---

### API Overview

| Operation | HTTP Method | Path | Request Body |
|-----------|-------------|------|--------------|
| Start service | POST | `/service/control/{serviceName}` | `{"type":"start"}` |
| Stop service | POST | `/service/control/{serviceName}` | `{"type":"stop"}` |
| Restart service | POST | `/service/control/{serviceName}` | `{"type":"restart"}` |
| Force stop service | POST | `/service/control/{serviceName}` | `{"type":"force-stop"}` |
| Query service status | POST | `/service/status/{serviceName}` | None |
| Query all services status | POST | `/service/status` | None |
| List all services | POST | `/service/list` | None |
| Query server status | POST | `/os/status` | None |

---

## Logging

- Log files are stored under the `logs/` directory in the project root
- Each service has its own subdirectory, e.g., `logs/my-service/`
- Logs are split daily, filename format: `YYYYMMDD.log`
- `current.log` is a temporary file for today's logs; it is merged into the dated file on rotation
- Old log files exceeding `log.retentionDays` are automatically cleaned up

---

## Shutdown

Press `Ctrl+C` or send a `SIGTERM` signal to the daemon. It will gracefully stop all running services before exiting.
