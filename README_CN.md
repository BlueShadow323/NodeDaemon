# Node Daemon

[English](./README.md) | 简体中文

<p>
  <img src="https://img.shields.io/badge/node-%3E%3D12.0.0-brightgreen" alt="Node 版本" />
  <img src="https://img.shields.io/badge/平台-Windows%20%7C%20Linux-blue" alt="支持平台" />
  <img src="https://img.shields.io/badge/许可证-MIT-green" alt="许可证" />
  <img src="https://img.shields.io/badge/依赖-dotenv-yellow" alt="依赖" />
</p>

一个轻量级的跨平台守护进程，用于管理后台服务的启动、停止、重启及自动重启。

---

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

在项目根目录创建 `.env` 文件或直接在系统中设置以下环境变量：

| 变量名 | 说明 | 是否必填 | 默认值 |
|--------|------|----------|--------|
| `DAEMON_PORT` | HTTP 服务监听端口 | 否 | `10300` |
| `DAEMON_SECRET_KEY` | HMAC 签名密钥，用于接口鉴权 | **是** | 无 |

示例 `.env`：

```
DAEMON_PORT=10300
DAEMON_SECRET_KEY=your-secret-key-here
```

模板文件见 `.env.example`。

### 启动守护进程

```bash
npm start
```

启动后，daemon 会自动加载 `services/` 目录下所有 `autoStart: true` 的服务，并按优先级顺序启动。

---

## 服务配置

在 `services/` 目录下创建 `{服务名称}.json` 文件来定义一个受管理服务。

### 配置字段说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `command` | string | `""` | 要执行的命令，例如 `"npm run dev"`、`"node app.js"` |
| `cwd` | string | `"."` | 命令的工作目录路径 |
| `priority` | number | `0` | 启动优先级（0-999），数值越高越先启动。多个服务可设为相同值 |
| `autoStart` | boolean | `false` | 是否在 daemon 启动时自动启动该服务 |
| `maxRetries` | number | `3` | 进程异常退出时的最大自动重启次数 |
| `retryOnAbnormalExit` | boolean | `true` | 是否在非正常退出时自动重启。设为 `false` 则进程退出后不再重启 |
| `log.enabled` | boolean | `false` | 是否开启日志记录。开启后 stdout/stderr 会被写入日志文件 |
| `log.retentionDays` | number | `7` | 日志文件保留天数，超过此天数的旧日志会自动清理 |

### 完整配置示例

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

### 添加多个服务

只需在 `services/` 目录下创建多个 `.json` 文件即可，每个文件对应一个独立服务，文件名（不含 `.json`）即为服务名称。

### 跨平台路径配置

`cwd` 字段指定服务命令的工作目录，请根据操作系统选择格式：

**Windows：**
- 使用反斜杠（`\`）—— 在 JSON 中需要转义为 `\\`
  ```json
  { "cwd": "C:\\Projects\\MyApp\\Server" }
  ```
- 或使用正斜杠 —— Node.js 在 Windows 下也支持
  ```json
  { "cwd": "C:/Projects/MyApp/Server" }
  ```
- 相对路径同样支持，相对于 daemon 根目录
  ```json
  { "cwd": "../MyApp/Server" }
  ```

**Linux / macOS：**
- 使用正斜杠（`/`）
  ```json
  { "cwd": "/home/user/projects/myapp/server" }
  ```
- 相对路径同理
  ```json
  { "cwd": "../myapp/server" }
  ```

**跨平台通用建议：**
- 尽量使用相对路径而非硬编码绝对路径
- command 中的环境变量会被 shell 自动展开
  ```json
  { "command": "node $HOME/app/server.js" }
  ```

**`command` 字段说明：**
- **Windows** 上使用 `cmd.exe` 可识别的命令（如 `npm run dev`、`node app.js`、`python app.py`）
- **Linux / macOS** 上通过 `sh` 执行（如 `npm run dev`、`python3 app.py`、`./myapp`）

---

## HTTP 接口说明

### 鉴权方式

所有接口均使用 HMAC-SHA256 签名鉴权，每次请求需在 Header 中传入：

| 请求头 | 说明 |
|--------|------|
| `X-Timestamp` | 当前 Unix 时间戳（毫秒），例如 `1710400000000` |
| `X-Signature` | HMAC-SHA256 签名结果（十六进制字符串） |

签名计算方式：

```
X-Signature = HMAC-SHA256(X-Timestamp + requestBody, DAEMON_SECRET_KEY)
```

- `X-Timestamp` 与 `requestBody` 直接拼接为字符串后作为 HMAC 输入
- 对于无请求体的接口，`requestBody` 为空字符串 `""`

Node.js 签名示例：

```javascript
const crypto = require('crypto');

const timestamp = String(Date.now());
const body = JSON.stringify({ type: 'start' });
const secret = 'your-secret-key-here';

const hmac = crypto.createHmac('sha256', secret);
hmac.update(timestamp + body);
const signature = hmac.digest('hex');
```

### 通用响应格式

```json
{
  "code": 200,
  "message": "OK",
  "data": { }
}
```

| code | 说明 |
|------|------|
| 200 | 操作成功 |
| 400 | 请求参数错误（如无效 JSON、缺少 `type` 字段） |
| 401 | 签名验证失败 |
| 404 | 接口路径不存在，或指定的服务名称未配置 |
| 405 | 仅支持 POST 方法 |

---

### 接口一：控制服务启停

```
POST /service/control/{serviceName}
```

**Headers：**

| 请求头 | 说明 |
|--------|------|
| `Content-Type` | `application/json` |
| `X-Timestamp` | 当前 Unix 时间戳（毫秒） |
| `X-Signature` | HMAC-SHA256(`X-Timestamp` + requestBody, secret) |

**请求体：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 操作类型：`"start"`（启动）、`"stop"`（停止）、`"restart"`（重启）、`"force-stop"`（强制停止） |

**cURL 调用示例：**

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

### 接口二：查询服务状态

```
POST /service/status/{serviceName}
```

查询单个服务状态。如需同时获取所有服务的状态，请调用 `POST /service/status`（不指定服务名称）。

**Headers：**

| 请求头 | 说明 |
|--------|------|
| `X-Timestamp` | 当前 Unix 时间戳（毫秒） |
| `X-Signature` | HMAC-SHA256(`X-Timestamp` + `""`, secret)（请求体为空字符串） |

**请求体：** 无

**响应 `data` 字段说明（单个服务）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `running` | boolean | 服务是否正在运行 |
| `operation` | string 或 null | 正在执行的操作：`"starting"`（启动中）、`"stopping"`（停止中）、`"restarting"`（重启中），无操作时为 `null` |
| `duration` | number 或 null | 服务已运行时长（秒），未运行时为 `null` |
| `abnormalExitCount` | number | 服务异常退出累计次数（自动重启计数） |

**响应示例（单个服务）：**

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

**cURL 调用示例：**

```bash
SECRET="your-secret-key-here"
TIMESTAMP=$(date +%s000)
SIGNATURE=$(echo -n "${TIMESTAMP}" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST http://localhost:10300/service/status/my-service \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Signature: $SIGNATURE"
```

**查询所有服务状态：**

```
POST /service/status
```

返回所有已配置服务的状态，以服务名称为 key 的对象形式。

**响应 `data` 字段说明（所有服务）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `{serviceName}` | object | 每个服务的状态对象（字段同单个服务状态） |

**响应示例（所有服务）：**

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

### 接口三：列出所有服务

```
POST /service/list
```

**Headers：**

| 请求头 | 说明 |
|--------|------|
| `X-Timestamp` | 当前 Unix 时间戳（毫秒） |
| `X-Signature` | HMAC-SHA256(`X-Timestamp` + `""`, secret)（请求体为空字符串） |

**请求体：** 无

**响应 `data` 字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| (数组) | string[] | 所有已配置的服务 ID 列表（文件名不含 `.json` 后缀） |

**响应示例：**

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

**cURL 调用示例：**

```bash
SECRET="your-secret-key-here"
TIMESTAMP=$(date +%s000)
SIGNATURE=$(echo -n "${TIMESTAMP}" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST http://localhost:10300/service/list \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Signature: $SIGNATURE"
```

---

### 接口四：查询操作系统状态

```
POST /os/status
```

**Headers：**

| 请求头 | 说明 |
|--------|------|
| `X-Timestamp` | 当前 Unix 时间戳（毫秒） |
| `X-Signature` | HMAC-SHA256(`X-Timestamp` + `""`, secret)（请求体为空字符串） |

**请求体：** 无

**响应 `data` 字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `cpu` | number | 当前 CPU 使用率（0–100） |
| `memory.total` | number | 物理内存总量（字节） |
| `memory.used` | number | 已用物理内存（字节） |
| `memory.free` | number | 空闲物理内存（字节） |
| `memory.usage` | number | 内存使用率（0–100） |
| `uptime` | number | 系统已运行时长（秒） |
| `platform` | string | 操作系统平台（`win32`、`linux`、`darwin` 等） |
| `arch` | string | CPU 架构（`x64`、`arm64` 等） |
| `hostname` | string | 机器主机名 |

**响应示例：**

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

**cURL 调用示例：**

```bash
SECRET="your-secret-key-here"
TIMESTAMP=$(date +%s000)
SIGNATURE=$(echo -n "${TIMESTAMP}" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST http://localhost:10300/os/status \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Signature: $SIGNATURE"
```

---

### 接口一览

| 操作 | HTTP 方法 | 路径 | 请求体 |
|------|-----------|------|--------|
| 启动服务 | POST | `/service/control/{serviceName}` | `{"type":"start"}` |
| 停止服务 | POST | `/service/control/{serviceName}` | `{"type":"stop"}` |
| 重启服务 | POST | `/service/control/{serviceName}` | `{"type":"restart"}` |
| 强制停止服务 | POST | `/service/control/{serviceName}` | `{"type":"force-stop"}` |
| 查询服务状态 | POST | `/service/status/{serviceName}` | 无 |
| 查询所有服务状态 | POST | `/service/status` | 无 |
| 列出所有服务 | POST | `/service/list` | 无 |
| 查询系统状态 | POST | `/os/status` | 无 |

---

## 日志

- 日志文件存放在项目根目录的 `logs/` 文件夹下
- 每个服务一个子目录，如 `logs/my-service/`
- 日志按天拆分，文件名格式为 `YYYYMMDD.log`
- `current.log` 为当日正在写入的临时日志文件，跨天时自动合并到日期文件
- 超过 `log.retentionDays` 设置的保留天数后，旧日志文件会被自动清理

---

## 关机

按 `Ctrl+C` 或向进程发送 `SIGTERM` 信号时，daemon 会依次停止所有正在运行的管理服务，然后退出。
