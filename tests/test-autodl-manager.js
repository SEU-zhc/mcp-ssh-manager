import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createInstance,
  getInstanceStatus,
  getInstanceSnapshot,
  listInstances,
  powerOnInstance,
  powerOffInstance,
  releaseInstance,
  buildServerConfigFromSnapshot,
  paygYuanPerHour,
  withNetworkTurbo,
  networkTurboInitCommand,
  deriveServerName,
  recordInstance,
  removeInstanceRecord,
  getInstanceRecord,
  listRegistry,
  GPU_SPEC_REFERENCE,
  PUBLIC_IMAGE_REFERENCE
} from '../src/autodl-manager.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

const originalFetch = global.fetch;

function mockFetch(handler) {
  global.fetch = async (url, options) => handler(url, options);
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

async function testCreateInstanceSendsExpectedPayload() {
  let captured = null;
  mockFetch(async (url, options) => {
    captured = { url, options };
    return jsonResponse(200, { code: 'Success', msg: '', data: 'pro-abc123' });
  });

  const instanceUuid = await createInstance('tok', {
    gpuSpecUuid: 'v-48g',
    imageUuid: 'base-image-l2t43iu6uk',
    gpuAmount: 1,
    expandSystemDiskGb: 0,
    cudaVFrom: 113,
    dataCenterList: ['westDC3'],
    instanceName: 'my-box'
  });

  assert.strictEqual(instanceUuid, 'pro-abc123');
  assert.strictEqual(captured.url, 'https://api.autodl.com/api/v1/dev/instance/pro/create');
  assert.strictEqual(captured.options.method, 'POST');
  assert.strictEqual(captured.options.headers.Authorization, 'tok');
  const body = JSON.parse(captured.options.body);
  assert.strictEqual(body.gpu_spec_uuid, 'v-48g');
  assert.strictEqual(body.image_uuid, 'base-image-l2t43iu6uk');
  assert.strictEqual(body.req_gpu_amount, 1);
  assert.strictEqual(body.cuda_v_from, 113);
  assert.deepStrictEqual(body.data_center_list, ['westDC3']);
  assert.strictEqual(body.instance_name, 'my-box');
  ok('createInstance posts the expected AutoDL payload and returns the instance uuid');

  restoreFetch();
}

async function testCreateInstanceValidatesRequiredFields() {
  await assert.rejects(() => createInstance('tok', { imageUuid: 'x' }), /gpuSpecUuid is required/);
  await assert.rejects(() => createInstance('tok', { gpuSpecUuid: 'x' }), /imageUuid is required/);
  ok('createInstance rejects when gpuSpecUuid/imageUuid are missing');
}

async function testMissingTokenRejectsBeforeNetwork() {
  let called = false;
  mockFetch(async () => { called = true; return jsonResponse(200, {}); });
  await assert.rejects(() => getInstanceStatus(undefined, 'pro-x'), /AUTODL_TOKEN is not configured/);
  assert.strictEqual(called, false, 'no network call should happen without a token');
  ok('requests without a token fail fast without hitting the network');
  restoreFetch();
}

async function testApiErrorSurfacesMessage() {
  mockFetch(async () => jsonResponse(200, { code: 'InsufficientBalance', msg: '余额不足' }));
  await assert.rejects(() => getInstanceStatus('tok', 'pro-x'), /余额不足/);
  ok('a non-Success API code surfaces the API msg in the thrown error');
  restoreFetch();
}

async function testHttpErrorSurfacesStatus() {
  mockFetch(async () => jsonResponse(401, { msg: 'bad token' }));
  await assert.rejects(() => getInstanceStatus('tok', 'pro-x'), /bad token/);
  ok('a non-2xx HTTP response surfaces its error message');
  restoreFetch();
}

async function testGetStatusAndSnapshotUseQueryParams() {
  mockFetch(async (url) => {
    assert.ok(url.includes('instance_uuid=pro-abc123'), 'instance_uuid should be a query param');
    if (url.includes('/status')) return jsonResponse(200, { code: 'Success', data: 'running' });
    return jsonResponse(200, {
      code: 'Success',
      data: { proxy_host: '1.2.3.4', ssh_port: 22345, root_password: 'pw123', payg_price: 1.98 }
    });
  });

  const status = await getInstanceStatus('tok', 'pro-abc123');
  assert.strictEqual(status, 'running');
  const snapshot = await getInstanceSnapshot('tok', 'pro-abc123');
  assert.strictEqual(snapshot.proxy_host, '1.2.3.4');
  ok('getInstanceStatus/getInstanceSnapshot send instance_uuid as a query param and parse data');
  restoreFetch();
}

async function testListPowerAndRelease() {
  const calls = [];
  mockFetch(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (url.includes('/list')) {
      return jsonResponse(200, { code: 'Success', data: { list: [], page_index: 1, page_size: 50, result_total: 0 } });
    }
    return jsonResponse(200, { code: 'Success', data: null });
  });

  await listInstances('tok', { pageIndex: 2, pageSize: 10 });
  await powerOnInstance('tok', 'pro-abc123', { startCommand: 'echo hi' });
  await powerOffInstance('tok', 'pro-abc123');
  await releaseInstance('tok', 'pro-abc123');

  assert.strictEqual(calls[0].url, 'https://api.autodl.com/api/v1/dev/instance/pro/list');
  assert.deepStrictEqual(calls[0].body, { page_index: 2, page_size: 10 });

  assert.strictEqual(calls[1].url, 'https://api.autodl.com/api/v1/dev/instance/pro/power_on');
  assert.strictEqual(calls[1].body.payload, 'gpu');
  assert.strictEqual(calls[1].body.start_command, 'echo hi');

  assert.strictEqual(calls[2].url, 'https://api.autodl.com/api/v1/dev/instance/pro/power_off');
  assert.strictEqual(calls[2].body.instance_uuid, 'pro-abc123');

  assert.strictEqual(calls[3].url, 'https://api.autodl.com/api/v1/dev/instance/pro/release');
  assert.strictEqual(calls[3].body.instance_uuid, 'pro-abc123');
  ok('listInstances/powerOnInstance/powerOffInstance/releaseInstance hit the right endpoints with the right bodies');

  restoreFetch();
}

function testBuildServerConfigFromSnapshot() {
  const config = buildServerConfigFromSnapshot('My-Box', {
    proxy_host: '1.2.3.4',
    ssh_port: '22345',
    root_password: 'pw123'
  }, 'pro-abc123');

  assert.strictEqual(config.name, 'my-box', 'server name is lowercased');
  assert.strictEqual(config.host, '1.2.3.4');
  assert.strictEqual(config.port, 22345);
  assert.strictEqual(typeof config.port, 'number', 'ssh_port string is coerced to a number');
  assert.strictEqual(config.user, 'root');
  assert.strictEqual(config.password, 'pw123');
  assert.strictEqual(config.platform, 'linux');
  ok('buildServerConfigFromSnapshot maps AutoDL snapshot fields to the ssh-manager server-config shape');

  assert.throws(
    () => buildServerConfigFromSnapshot('x', { proxy_host: null }, 'pro-x'),
    /missing SSH connection info/
  );
  ok('buildServerConfigFromSnapshot rejects a snapshot without connection info');
}

function testPaygYuanPerHour() {
  // AutoDL price fields are yuan * 1000 (e.g. 1870 = 1.87 yuan/hour).
  assert.strictEqual(paygYuanPerHour({ payg_price: 1870 }), 1.87);
  assert.strictEqual(paygYuanPerHour({ payg_price: 100 }), 0.1);
  assert.strictEqual(paygYuanPerHour({}), undefined);
  assert.strictEqual(paygYuanPerHour(null), undefined);
  ok('paygYuanPerHour converts AutoDL\'s yuan*1000 price field to plain yuan/hour');
}

function testNetworkTurbo() {
  const on = { networkTurbo: true };
  const off = { networkTurbo: false };

  // withNetworkTurbo: one-shot ssh_execute/ssh_execute_sudo/ssh_execute_group calls
  // have no persistent shell, so the source has to be repeated on every command.
  assert.strictEqual(
    withNetworkTurbo(on, 'linux', 'pip install foo'),
    '[ -f /etc/network_turbo ] && source /etc/network_turbo 2>/dev/null; pip install foo'
  );
  assert.strictEqual(withNetworkTurbo(off, 'linux', 'pip install foo'), 'pip install foo', 'no-op when networkTurbo is off');
  assert.strictEqual(withNetworkTurbo(on, 'windows', 'pip install foo'), 'pip install foo', 'no-op on windows');
  assert.strictEqual(withNetworkTurbo(undefined, 'linux', 'pip install foo'), 'pip install foo', 'no-op with no server config');

  // networkTurboInitCommand: ssh_session_start/ssh_session_send share one persistent
  // shell, so this only needs to run once at session open, not per send.
  assert.strictEqual(networkTurboInitCommand(on, 'linux'), '[ -f /etc/network_turbo ] && source /etc/network_turbo 2>/dev/null');
  assert.strictEqual(networkTurboInitCommand(off, 'linux'), null);
  assert.strictEqual(networkTurboInitCommand(on, 'windows'), null);
  ok('withNetworkTurbo repeats the source per one-shot command; networkTurboInitCommand runs it once for persistent sessions');
}

function testDeriveServerName() {
  assert.strictEqual(deriveServerName('My Cool Box!', 'pro-abc123def456'), 'my-cool-box');
  assert.strictEqual(deriveServerName(undefined, 'pro-abc123def456'), 'autodl-23def456');
  assert.strictEqual(deriveServerName('   ', 'pro-abc123def456'), 'autodl-23def456');
  ok('deriveServerName sanitizes a given name or falls back to an autodl-<uuid suffix> name');
}

function testRegistryCrud() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-autodl-registry-'));
  const registryFile = path.join(dir, '.autodl-instances.json');

  assert.strictEqual(getInstanceRecord('gpu-1', registryFile), null);

  recordInstance('GPU-1', { instanceUuid: 'pro-abc123' }, registryFile);
  const record = getInstanceRecord('gpu-1', registryFile);
  assert.strictEqual(record.instanceUuid, 'pro-abc123', 'lookups are case-insensitive');
  ok('recordInstance/getInstanceRecord round-trip through the registry file');

  const listed = listRegistry(registryFile);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].serverName, 'gpu-1');
  assert.strictEqual(listed[0].instanceUuid, 'pro-abc123');
  ok('listRegistry returns every recorded server with its instance uuid');

  removeInstanceRecord('gpu-1', registryFile);
  assert.strictEqual(getInstanceRecord('gpu-1', registryFile), null);
  ok('removeInstanceRecord deletes the entry');

  fs.rmSync(dir, { recursive: true, force: true });
}

function testReferenceTablesAreWellFormed() {
  assert.ok(Object.keys(GPU_SPEC_REFERENCE).length > 0);
  for (const [uuid, info] of Object.entries(GPU_SPEC_REFERENCE)) {
    assert.ok(typeof uuid === 'string' && uuid.length > 0);
    assert.ok(info.label && info.tier, `GPU_SPEC_REFERENCE[${uuid}] should have label + tier`);
  }
  assert.ok(Object.keys(PUBLIC_IMAGE_REFERENCE).length > 0);
  for (const [uuid, description] of Object.entries(PUBLIC_IMAGE_REFERENCE)) {
    assert.ok(uuid.startsWith('base-image-'), `unexpected image uuid shape: ${uuid}`);
    assert.ok(typeof description === 'string' && description.length > 0);
  }
  ok('GPU_SPEC_REFERENCE and PUBLIC_IMAGE_REFERENCE are non-empty and well-formed');
}

async function main() {
  await testCreateInstanceSendsExpectedPayload();
  await testCreateInstanceValidatesRequiredFields();
  await testMissingTokenRejectsBeforeNetwork();
  await testApiErrorSurfacesMessage();
  await testHttpErrorSurfacesStatus();
  await testGetStatusAndSnapshotUseQueryParams();
  await testListPowerAndRelease();
  testBuildServerConfigFromSnapshot();
  testPaygYuanPerHour();
  testNetworkTurbo();
  testDeriveServerName();
  testRegistryCrud();
  testReferenceTablesAreWellFormed();
  console.log(`\n✅ autodl manager tests passed (${passed} checks)`);
}

main().catch((error) => {
  restoreFetch();
  console.error(error);
  process.exit(1);
});
