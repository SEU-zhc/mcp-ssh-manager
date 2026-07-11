// Regression test for issue #49: handlers must read the camelCase field names
// that ConfigLoader actually produces (sudoPassword, defaultDir, keyPath, ...).
// Before v3.0.0 the inline .env parser produced snake_case fields
// (sudo_password, default_dir, keypath); the ConfigLoader refactor switched to
// camelCase but several handlers kept reading the old names, silently breaking
// SUDO_PASSWORD, DEFAULT_DIR and ssh_sync key auth. This test locks both the
// loader's output shape and the absence of stale snake_case access in handlers.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConfigLoader } from '../src/config-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'src');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

// Field names the loader must expose on resolved server configs.
const EXPECTED_CAMEL_FIELDS = {
  keyPath: '~/.ssh/fieldcheck_key',
  defaultDir: '/opt/fieldcheck',
  sudoPassword: 'sudo-secret',
  proxyJump: 'bastion',
  proxyCommand: 'ncat --proxy 127.0.0.1:1080 %h %p'
};

// Stale names that must NOT exist on resolved server configs (pre-v3.0.0 shape).
const FORBIDDEN_SNAKE_FIELDS = [
  'sudo_password', 'default_dir', 'key_path', 'keypath',
  'proxy_jump', 'proxy_command', 'audit_log'
];

function assertServerShape(server, source) {
  assert.ok(server, `server loaded from ${source}`);
  assert.strictEqual(server.host, '203.0.113.10');
  assert.strictEqual(server.user, 'demo');
  assert.strictEqual(server.password, 'pw-secret');
  assert.strictEqual(server.port, 2222);
  assert.strictEqual(server.passphrase, 'key-passphrase');
  assert.strictEqual(server.platform, 'linux');
  for (const [field, expected] of Object.entries(EXPECTED_CAMEL_FIELDS)) {
    assert.strictEqual(server[field], expected, `${source}: ${field} must be "${expected}", got ${JSON.stringify(server[field])}`);
  }
  for (const field of FORBIDDEN_SNAKE_FIELDS) {
    assert.ok(!(field in server), `${source}: stale field "${field}" must not exist on resolved config`);
  }
}

async function testEnvFieldNames() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mgr-fieldnames-'));
  const envPath = path.join(dir, 'test.env');
  fs.writeFileSync(envPath, [
    'SSH_SERVER_FIELDCHECK_ENV_HOST=203.0.113.10',
    'SSH_SERVER_FIELDCHECK_ENV_USER=demo',
    'SSH_SERVER_FIELDCHECK_ENV_PASSWORD=pw-secret',
    'SSH_SERVER_FIELDCHECK_ENV_KEYPATH=~/.ssh/fieldcheck_key',
    'SSH_SERVER_FIELDCHECK_ENV_PASSPHRASE=key-passphrase',
    'SSH_SERVER_FIELDCHECK_ENV_PORT=2222',
    'SSH_SERVER_FIELDCHECK_ENV_DEFAULT_DIR=/opt/fieldcheck',
    'SSH_SERVER_FIELDCHECK_ENV_SUDO_PASSWORD=sudo-secret',
    'SSH_SERVER_FIELDCHECK_ENV_PLATFORM=linux',
    'SSH_SERVER_FIELDCHECK_ENV_PROXYJUMP=bastion',
    'SSH_SERVER_FIELDCHECK_ENV_PROXYCOMMAND=ncat --proxy 127.0.0.1:1080 %h %p',
    ''
  ].join('\n'));

  try {
    const loader = new ConfigLoader();
    const servers = await loader.load({ envPath, tomlPath: path.join(dir, 'absent.toml') });
    assertServerShape(servers.get('fieldcheck_env'), '.env');
    ok('.env loader exposes camelCase fields only (sudoPassword, defaultDir, keyPath, proxy*)');
  } finally {
    // loadEnvConfig may populate process.env; scrub our test keys so they
    // cannot leak into other tests through loadEnvironmentVariables().
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SSH_SERVER_FIELDCHECK_ENV_')) delete process.env[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testTomlFieldNames() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mgr-fieldnames-'));
  const tomlPath = path.join(dir, 'ssh-config.toml');
  fs.writeFileSync(tomlPath, [
    '[ssh_servers.fieldcheck_toml]',
    'host = "203.0.113.10"',
    'user = "demo"',
    'password = "pw-secret"',
    'key_path = "~/.ssh/fieldcheck_key"',
    'passphrase = "key-passphrase"',
    'port = 2222',
    'default_dir = "/opt/fieldcheck"',
    'sudo_password = "sudo-secret"',
    'platform = "linux"',
    'proxy_jump = "bastion"',
    'proxy_command = "ncat --proxy 127.0.0.1:1080 %h %p"',
    ''
  ].join('\n'));

  try {
    const loader = new ConfigLoader();
    const servers = await loader.load({ envPath: path.join(dir, 'absent.env'), tomlPath });
    assertServerShape(servers.get('fieldcheck_toml'), 'TOML');
    ok('TOML loader maps snake_case source keys to camelCase fields only');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Static guard: no handler may access the stale snake_case/lowercase names on a
// config object. config-loader.js legitimately references them (it parses TOML
// source keys and serializes back); ssh-manager.js keeps an intentional
// `keyPath || keypath` fallback for configs supplied by external callers.
function testNoStaleAccessInSource() {
  const excluded = new Set(['config-loader.js', 'ssh-manager.js']);
  const staleAccess = /\.(sudo_password|default_dir|keypath)\b/;
  const offenders = [];

  for (const file of fs.readdirSync(SRC_DIR)) {
    if (!file.endsWith('.js') || excluded.has(file)) continue;
    const lines = fs.readFileSync(path.join(SRC_DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (staleAccess.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepStrictEqual(offenders, [], `stale snake_case config access found:\n${offenders.join('\n')}`);
  ok('no handler reads stale .sudo_password / .default_dir / .keypath fields');
}

async function main() {
  await testEnvFieldNames();
  await testTomlFieldNames();
  testNoStaleAccessInSource();
  console.log(`\n✅ config field name tests passed (${passed} checks)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
