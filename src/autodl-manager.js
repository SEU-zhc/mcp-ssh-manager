import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * AutoDL (autodl.com) 容器实例 Pro API client + local instance registry.
 *
 * Docs: https://www.autodl.com/docs/instance_pro_api/
 * All endpoints live under https://api.autodl.com and authenticate with a
 * developer token (console -> 设置 -> 开发者Token) sent verbatim as the
 * `Authorization` header (no "Bearer " prefix).
 */

export const AUTODL_API_BASE = 'https://api.autodl.com';

export const AUTODL_STATUS = {
  RUNNING: 'running',
  SHUTDOWN: 'shutdown',
};

// Reference tables from the AutoDL docs. Neither list is exposed through an
// API endpoint (confirmed against the live docs), so callers may also pass
// any other gpu_spec_uuid / image_uuid they find in the AutoDL console —
// these are conveniences, not an exhaustive/validated set.
export const GPU_SPEC_REFERENCE = {
  'h800': { label: 'H800-80G', tier: '通用型' },
  'v-48g': { label: '4090-48G', tier: '通用型' },
  'pro6000-p': { label: 'PRO6000-96G', tier: '性能型' },
  'v-32g-p': { label: '4080(S)-32G', tier: '性能型' },
  'v-48g-350w': { label: '3090-48G', tier: '通用型' },
  '5090-p': { label: '5090-32G', tier: '性能型' },
  '4090D': { label: '4090D', tier: '通用型' },
};

export const PUBLIC_IMAGE_REFERENCE = {
  'base-image-12be412037': 'PyTorch cuda11.1-cudnn8-devel-ubuntu18.04-py38-torch1.9.0',
  'base-image-u9r24vthlk': 'PyTorch cuda11.3-cudnn8-devel-ubuntu20.04-py38-torch1.10.0',
  'base-image-l374uiucui': 'PyTorch cuda11.3-cudnn8-devel-ubuntu20.04-py38-torch1.11.0',
  'base-image-l2t43iu6uk': 'PyTorch cuda11.8-cudnn8-devel-ubuntu20.04-py38-torch2.0.0',
  'base-image-0gxqmciyth': 'TensorFlow cuda11.2-cudnn8-devel-ubuntu18.04-py38-tf2.5.0',
  'base-image-uxeklgirir': 'TensorFlow cuda11.2-cudnn8-devel-ubuntu20.04-py38-tf2.9.0',
  'base-image-4bpg0tt88l': 'TensorFlow cuda11.4-py38-tf1.15.5',
  'base-image-mbr2n4urrc': 'Miniconda cuda11.6-cudnn8-devel-ubuntu20.04-py38',
  'base-image-qkkhitpik5': 'Miniconda cuda10.2-cudnn7-devel-ubuntu18.04-py38',
  'base-image-h041hn36yt': 'Miniconda cuda11.1-cudnn8-devel-ubuntu18.04-py38',
  'base-image-7bn8iqhkb5': 'Miniconda cudagl11.3-cudnn8-devel-ubuntu20.04-py38',
  'base-image-k0vep6kyq8': 'Miniconda cuda9.0-cudnn7-devel-ubuntu16.04-py36',
  'base-image-l2843iu23k': 'TensorRT cuda11.8-cudnn8-devel-ubuntu20.04-py38-trt8.5.1',
};

const REGISTRY_FILE = path.join(__dirname, '..', '.autodl-instances.json');

// ── Low-level API client ───────────────────────────────────────────────────

async function autodlRequest(token, method, apiPath, { query, body, timeoutMs = 30000 } = {}) {
  if (!token) {
    throw new Error('AUTODL_TOKEN is not configured (set it in .env or the environment)');
  }

  let url = `${AUTODL_API_BASE}${apiPath}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    url += `?${params.toString()}`;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`AutoDL API request failed (${method} ${apiPath}): ${error.message}`);
  }

  let payload;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`AutoDL API returned non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || (payload.code && payload.code !== 'Success')) {
    const message = payload.msg || payload.code || `HTTP ${response.status}`;
    throw new Error(`AutoDL API error (${method} ${apiPath}): ${message}`);
  }

  return payload.data;
}

export async function createInstance(token, {
  gpuSpecUuid,
  imageUuid,
  gpuAmount = 1,
  expandSystemDiskGb = 0,
  cudaVFrom = 113,
  dataCenterList,
  instanceName,
  startCommand,
} = {}) {
  if (!gpuSpecUuid) throw new Error('gpuSpecUuid is required');
  if (!imageUuid) throw new Error('imageUuid is required');

  const body = {
    req_gpu_amount: gpuAmount,
    expand_system_disk_by_gb: expandSystemDiskGb,
    gpu_spec_uuid: gpuSpecUuid,
    image_uuid: imageUuid,
    cuda_v_from: cudaVFrom,
  };
  if (dataCenterList && dataCenterList.length > 0) body.data_center_list = dataCenterList;
  if (instanceName) body.instance_name = instanceName;
  if (startCommand) body.start_command = startCommand;

  const instanceUuid = await autodlRequest(token, 'POST', '/api/v1/dev/instance/pro/create', { body });
  return instanceUuid;
}

export async function getInstanceStatus(token, instanceUuid) {
  return autodlRequest(token, 'GET', '/api/v1/dev/instance/pro/status', { query: { instance_uuid: instanceUuid } });
}

export async function getInstanceSnapshot(token, instanceUuid) {
  return autodlRequest(token, 'GET', '/api/v1/dev/instance/pro/snapshot', { query: { instance_uuid: instanceUuid } });
}

export async function listInstances(token, { pageIndex = 1, pageSize = 50 } = {}) {
  return autodlRequest(token, 'POST', '/api/v1/dev/instance/pro/list', {
    body: { page_index: pageIndex, page_size: pageSize },
  });
}

export async function powerOnInstance(token, instanceUuid, { startCommand } = {}) {
  const body = { instance_uuid: instanceUuid, payload: 'gpu' };
  if (startCommand) body.start_command = startCommand;
  return autodlRequest(token, 'POST', '/api/v1/dev/instance/pro/power_on', { body });
}

export async function powerOffInstance(token, instanceUuid) {
  return autodlRequest(token, 'POST', '/api/v1/dev/instance/pro/power_off', {
    body: { instance_uuid: instanceUuid },
  });
}

export async function releaseInstance(token, instanceUuid) {
  return autodlRequest(token, 'POST', '/api/v1/dev/instance/pro/release', {
    body: { instance_uuid: instanceUuid },
  });
}

// Poll instance status until it reaches 'running' (or timeout). Returns the
// connection snapshot once running. AutoDL instances take time to schedule +
// boot after create/power_on, so the caller controls the ceiling.
export async function waitUntilRunning(token, instanceUuid, { timeoutMs = 180000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    lastStatus = await getInstanceStatus(token, instanceUuid);
    if (lastStatus === AUTODL_STATUS.RUNNING) {
      return getInstanceSnapshot(token, instanceUuid);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for instance ${instanceUuid} to reach "running" (last status: ${lastStatus})`);
}

// Release requires the instance to already be shut down. Poll after
// power_off until that's reflected, with a shorter ceiling than boot-up
// since shutdown is typically fast.
export async function waitUntilShutdown(token, instanceUuid, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    lastStatus = await getInstanceStatus(token, instanceUuid);
    if (lastStatus === AUTODL_STATUS.SHUTDOWN) return lastStatus;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for instance ${instanceUuid} to shut down (last status: ${lastStatus})`);
}

// AutoDL price fields are denominated in yuan * 1000 (e.g. 100 = 0.1 yuan/hour),
// per the documented convention across their APIs. Converts to plain yuan/hour.
export function paygYuanPerHour(snapshot) {
  const raw = snapshot?.payg_price;
  return typeof raw === 'number' ? raw / 1000 : undefined;
}

// Maps an AutoDL Pro instance snapshot to the server-config shape consumed by
// ConfigLoader/SSHManager (see src/ssh-manager.js connConfig build).
// networkTurbo defaults on because every AutoDL Pro instance ships /etc/network_turbo;
// callers can pass { networkTurbo: false } to opt a server out.
export function buildServerConfigFromSnapshot(name, snapshot, instanceUuid, { networkTurbo = true } = {}) {
  if (!snapshot || !snapshot.proxy_host || !snapshot.ssh_port) {
    throw new Error('Instance snapshot is missing SSH connection info (is it running?)');
  }
  const config = {
    name: name.toLowerCase(),
    host: snapshot.proxy_host,
    port: Number(snapshot.ssh_port),
    user: 'root',
    password: snapshot.root_password,
    description: `AutoDL GPU instance (${instanceUuid})`,
    platform: 'linux',
  };
  if (networkTurbo) config.networkTurbo = true;
  return config;
}

// AutoDL's built-in academic-network accelerator (github.com/githubusercontent.com/
// githubassets.com/huggingface.co). The `[ -f ... ]` guard makes sourcing it a no-op
// wherever /etc/network_turbo doesn't exist, so it's safe even if the flag is set on
// a non-AutoDL host or an instance that has since lost the file.
const NETWORK_TURBO_SOURCE = '[ -f /etc/network_turbo ] && source /etc/network_turbo 2>/dev/null';

// ssh_execute/ssh_execute_sudo/ssh_execute_group each open a brand-new one-shot shell
// per call — there is no persistent process to keep the proxy env vars across calls —
// so the source must be repeated on every command for it to actually take effect.
export function withNetworkTurbo(serverConfig, platform, command) {
  if (platform === 'windows' || !serverConfig?.networkTurbo) return command;
  return `${NETWORK_TURBO_SOURCE}; ${command}`;
}

// ssh_session_start/ssh_session_send share one persistent shell across calls, so the
// source only needs to run once when the session opens. Returns null when the
// server has networkTurbo off or is Windows (nothing to inject).
export function networkTurboInitCommand(serverConfig, platform) {
  if (platform === 'windows' || !serverConfig?.networkTurbo) return null;
  return NETWORK_TURBO_SOURCE;
}

// ── Local registry: maps a local ssh-manager server name -> AutoDL instance ──
// Mirrors the persistence style of server-aliases.js (flat JSON file next to
// the project root).

function loadRegistry(filePath = REGISTRY_FILE) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (error) {
    logger.warn(`Could not load AutoDL instance registry: ${error.message}`);
  }
  return {};
}

function saveRegistry(registry, filePath = REGISTRY_FILE) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
    return true;
  } catch (error) {
    logger.error(`Could not save AutoDL instance registry: ${error.message}`);
    return false;
  }
}

export function recordInstance(serverName, meta, filePath = REGISTRY_FILE) {
  const registry = loadRegistry(filePath);
  registry[serverName.toLowerCase()] = meta;
  return saveRegistry(registry, filePath);
}

export function removeInstanceRecord(serverName, filePath = REGISTRY_FILE) {
  const registry = loadRegistry(filePath);
  delete registry[serverName.toLowerCase()];
  return saveRegistry(registry, filePath);
}

export function getInstanceRecord(serverName, filePath = REGISTRY_FILE) {
  const registry = loadRegistry(filePath);
  return registry[serverName.toLowerCase()] || null;
}

export function listRegistry(filePath = REGISTRY_FILE) {
  const registry = loadRegistry(filePath);
  return Object.entries(registry).map(([serverName, meta]) => ({ serverName, ...meta }));
}

export function deriveServerName(instanceName, instanceUuid) {
  const base = instanceName && instanceName.trim().length > 0
    ? instanceName
    : `autodl-${instanceUuid.slice(-8)}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || `autodl-${instanceUuid.slice(-8)}`;
}
