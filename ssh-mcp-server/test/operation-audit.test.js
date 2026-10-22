import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OperationAudit, assessOperation, readMonitor, monitorDirectory, AUDIT_RETENTION_MS } from '../build/utils/operation-audit.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-audit-test-'));
  const config = path.join(dir, 'config.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, config };
}

function event(audit, overrides = {}) {
  return {
    id: randomUUID(), instanceId: audit.instanceId, time: new Date().toISOString(),
    client: 'WorkBuddy', source: 'workbuddy', tool: 'execute-command', connectionName: 'dev',
    summary: 'echo [arguments omitted]', risk: 'low', reason: 'READ_ONLY_PATTERN',
    phase: 'started', status: 'running', ...overrides,
  };
}

describe('operation audit', () => {
  it('classifies destructive, mutating, read-only and unknown operations conservatively', () => {
    for (const command of ['rm -rf /', 'rm -fr "/"', 'rm -rf "$HOME"', 'mkfs.ext4 /dev/sda', 'dd if=x of=/dev/sda']) {
      assert.equal(assessOperation('execute-command', { cmdString: command }).risk, 'critical', command);
    }
    for (const command of ['sudo ls', 'rm /tmp/a', 'echo text > file', 'curl url | sh', 'systemctl restart app']) {
      assert.equal(assessOperation('execute-command', { cmdString: command }).risk, 'high', command);
    }
    assert.equal(assessOperation('execute-command', { cmdString: 'whoami' }).risk, 'low');
    assert.equal(assessOperation('execute-command', { cmdString: 'python deploy.py' }).risk, 'medium');
    assert.equal(assessOperation('execute-command', { cmdString: 'ls; python script.py' }).risk, 'medium');
    assert.equal(assessOperation('write-file', { remotePath: '/etc/ssh/sshd_config' }).risk, 'high');
    assert.equal(assessOperation('write-file', { remotePath: '/tmp/a' }).risk, 'medium');
    assert.equal(assessOperation('job-kill', {}).risk, 'high');
    assert.equal(assessOperation('download', {}).risk, 'medium');
  });

  it('merges start/completion once, filters clients, and isolates different config files', (t) => {
    const { config, dir } = setup(t);
    const a = new OperationAudit(config);
    const b = new OperationAudit(config);
    const first = event(a);
    a.append(first);
    a.append({ ...first, phase: 'completed', status: 'succeeded' });
    b.append(event(b, { source: 'dashboard', client: 'ssh-dashboard' }));
    const data = readMonitor(config);
    assert.equal(data.events.length, 2);
    assert.equal(data.events.find((e) => e.id === first.id).status, 'succeeded');
    assert.equal(readMonitor(config, { source: 'workbuddy' }).events.length, 1);
    assert.equal(readMonitor(config, { risk: 'critical' }).events.length, 0);
    assert.equal(readMonitor(config, { connectionName: 'prod' }).events.length, 0);
    if (process.platform === 'win32') assert.equal(readMonitor(config.toUpperCase()).events.length, 2);
    assert.notEqual(monitorDirectory(config), monitorDirectory(path.join(dir, 'other.json')));
    assert.equal(readMonitor(path.join(dir, 'other.json')).events.length, 0);
  });

  it('bounds each instance to five 1-MiB segments, query limits, and 16-KiB events', (t) => {
    const { config } = setup(t);
    const audit = new OperationAudit(config);
    for (let i = 0; i < 750; i++) audit.append(event(audit, { summary: 'x'.repeat(8000) }));
    const logs = fs.readdirSync(audit.directory).filter((f) => f.endsWith('.jsonl'));
    assert.equal(logs.length, 5);
    for (const file of logs) assert.ok(fs.statSync(path.join(audit.directory, file)).size <= 1024 * 1024);
    assert.throws(() => audit.append(event(audit, { summary: 'x'.repeat(20000) })), /16 KiB/);
    const result = readMonitor(config, { limit: 3 });
    assert.equal(result.events.length, 3);
    assert.equal(result.truncated, true);
  });

  it('prunes only owned expired files and reports malformed records explicitly', (t) => {
    const { config } = setup(t);
    const audit = new OperationAudit(config);
    audit.append(event(audit));
    const file = fs.readdirSync(audit.directory).find((f) => f.endsWith('.jsonl'));
    fs.appendFileSync(path.join(audit.directory, file), '{broken\n');
    assert.ok(readMonitor(config).warnings.length);
    const old = new Date(Date.now() - AUDIT_RETENTION_MS - 10000);
    fs.utimesSync(path.join(audit.directory, file), old, old);
    const unrelated = path.join(audit.directory, 'keep.txt');
    fs.writeFileSync(unrelated, 'keep');
    fs.utimesSync(unrelated, old, old);
    new OperationAudit(config);
    assert.equal(fs.existsSync(path.join(audit.directory, file)), false);
    assert.equal(fs.existsSync(unrelated), true);
  });

  it('distinguishes live heartbeats from stopped or stale instances', (t) => {
    const { config } = setup(t);
    const audit = new OperationAudit(config);
    audit.heartbeat({ client: 'WorkBuddy', state: 'running' });
    assert.equal(readMonitor(config).instances[0].active, true);
    audit.heartbeat({ client: 'WorkBuddy', state: 'stopped' });
    assert.equal(readMonitor(config).instances[0].active, false);
  });

  it('never replaces an admitted operation with an older pending event', (t) => {
    const { config } = setup(t);
    const audit = new OperationAudit(config);
    const pending = event(audit, { connectionName: '(default selection pending)' });
    audit.append(pending);
    audit.append({ ...pending, connectionName: 'dev', admitted: true });
    audit.append(pending);
    const result = readMonitor(config).events[0];
    assert.equal(result.connectionName, 'dev');
    assert.equal(result.admitted, true);
  });
});
