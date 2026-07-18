import assert from 'assert';
import {
  withStdinDetached,
  buildBackgroundCommand,
  parseBackgroundPid,
  defaultBackgroundLogFile
} from '../src/exec-helpers.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

function testWithStdinDetached() {
  assert.strictEqual(
    withStdinDetached('nohup python train.py > log 2>&1 &'),
    'exec 0</dev/null; nohup python train.py > log 2>&1 &'
  );
  assert.strictEqual(
    withStdinDetached('echo hi', { rawCommand: true }),
    'echo hi',
    'rawCommand opts out of the detach prefix entirely'
  );
  assert.strictEqual(
    withStdinDetached('echo hi'),
    'exec 0</dev/null; echo hi',
    'applies even to plain foreground commands (harmless — nothing feeds stdin through this path)'
  );
  ok('withStdinDetached prefixes exec 0</dev/null so backgrounded children can never hold the exec channel open, unless rawCommand opts out');
}

function testBuildBackgroundCommand() {
  const cmd = buildBackgroundCommand('cd /root && python train.py', '/tmp/job.log');
  assert.strictEqual(
    cmd,
    "nohup sh -c 'cd /root && python train.py' > '/tmp/job.log' 2>&1 < /dev/null & echo $!"
  );
  ok('buildBackgroundCommand wraps the command with nohup/redirects/echo $! for a detached launch');
}

function testBuildBackgroundCommandEscapesSingleQuotes() {
  const cmd = buildBackgroundCommand("echo 'hello world'", "/tmp/it's a log.log");
  // Every embedded single quote must be closed-escaped-reopened so the
  // remote shell still sees one literal token, not a broken/injected string.
  assert.strictEqual(
    cmd,
    "nohup sh -c 'echo '\\''hello world'\\''' > '/tmp/it'\\''s a log.log' 2>&1 < /dev/null & echo $!"
  );
  ok('buildBackgroundCommand safely escapes single quotes in both the command and the log file path');
}

function testParseBackgroundPid() {
  assert.strictEqual(parseBackgroundPid('12345\n'), 12345);
  assert.strictEqual(parseBackgroundPid('  6789  '), 6789);
  assert.strictEqual(parseBackgroundPid(''), null, 'empty output (failed launch) parses to null, not NaN/0');
  assert.strictEqual(parseBackgroundPid('sh: nohup: not found'), null, 'non-numeric stderr-ish output parses to null');
  assert.strictEqual(parseBackgroundPid(undefined), null);
  ok('parseBackgroundPid extracts a numeric pid or null when the background launch itself failed');
}

function testDefaultBackgroundLogFile() {
  const a = defaultBackgroundLogFile();
  const b = defaultBackgroundLogFile();
  assert.ok(a.startsWith('/tmp/mcp-ssh-manager-bg-'));
  assert.ok(a.endsWith('.log'));
  assert.notStrictEqual(a, b, 'two calls should not collide on the same path');
  ok('defaultBackgroundLogFile generates a unique /tmp path when the caller supplies none');
}

function main() {
  testWithStdinDetached();
  testBuildBackgroundCommand();
  testBuildBackgroundCommandEscapesSingleQuotes();
  testParseBackgroundPid();
  testDefaultBackgroundLogFile();
  console.log(`\n✅ exec-helpers tests passed (${passed} checks)`);
}

main();
