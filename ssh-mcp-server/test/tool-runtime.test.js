import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRuntime } from '../build/core/tool-runtime.js';
import { CommandLineParser } from '../build/cli/command-line-parser.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { readMonitor } from '../build/utils/operation-audit.js';
import { registerAllTools } from '../build/tools/index.js';

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const config = (name) => [{ name, host: '127.0.0.1', port: 22, username: 'test', password: 'never-log-this-password' }];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-runtime-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config('dev')));
  const history = [];
  let current = {};
  const manager = {
    setConfig(configs) { current = configs; history.push(Object.keys(configs)); },
    getAllServerInfos() { return Object.keys(current).map((name) => ({ name })); },
  };
  const runtime = new ToolRuntime(file, manager);
  t.after(() => {
    runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { runtime, file, history };
}

describe('tool runtime', () => {
  it('loads modifications/removals on the next request, including an empty account list', async (t) => {
    const { runtime, file, history } = setup(t);
    await runtime.run('list-servers', {}, async () => text('dev'), undefined, 'WorkBuddy');
    fs.writeFileSync(file, JSON.stringify(config('prod')));
    await runtime.run('list-servers', {}, async () => text('prod'), undefined, 'WorkBuddy');
    fs.writeFileSync(file, '[]');
    await runtime.run('list-servers', {}, async () => text('empty'), undefined, 'WorkBuddy');
    assert.deepEqual(history, [['dev'], ['prod'], []]);
    assert.equal(readMonitor(file).instances[0].client, 'WorkBuddy');
  });

  it('fails closed on invalid updates, retains the prior config, and recovers after repair', async (t) => {
    const { runtime, file, history } = setup(t);
    fs.writeFileSync(file, '{broken');
    let executed = false;
    const result = await runtime.run('execute-command', { cmdString: 'whoami' }, async () => { executed = true; return text('test'); });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /CONFIG_RELOAD_FAILED/);
    assert.equal(executed, false);
    assert.deepEqual(history, [['dev']]);
    fs.writeFileSync(file, JSON.stringify(config('fixed')));
    assert.equal((await runtime.run('list-servers', {}, async () => text('fixed'))).isError, undefined);
    assert.deepEqual(history, [['dev'], ['fixed']]);
  });

  it('preserves parallelism without changes, waits for active work, and loads the latest config', async (t) => {
    const { runtime, file, history } = setup(t);
    let release;
    const blocking = new Promise((resolve) => { release = resolve; });
    const first = runtime.run('execute-command', {}, async () => { await blocking; return text('done'); });
    await tick();
    let parallel = false;
    await runtime.run('list-servers', {}, async () => { parallel = true; return text('parallel'); });
    assert.equal(parallel, true);
    fs.writeFileSync(file, JSON.stringify(config('middle')));
    let changedRan = false;
    const next = runtime.run('list-servers', {}, async () => { changedRan = true; return text('new'); });
    await tick();
    assert.equal(changedRan, false);
    assert.deepEqual(history, [['dev']]);
    fs.writeFileSync(file, JSON.stringify(config('latest')));
    release();
    await Promise.all([first, next]);
    assert.deepEqual(history, [['dev'], ['latest']]);
  });

  it('does not execute cancelled requests after waiting for a configuration change', async (t) => {
    const { runtime, file } = setup(t);
    let release;
    const blocking = new Promise((resolve) => { release = resolve; });
    const first = runtime.run('execute-command', {}, async () => { await blocking; return text('done'); });
    await tick();
    fs.writeFileSync(file, JSON.stringify(config('prod')));
    const controller = new AbortController();
    let executed = false;
    const next = runtime.run('execute-command', {}, async () => { executed = true; return text('never'); }, controller.signal);
    await tick();
    controller.abort();
    release();
    await first;
    const result = await next;
    assert.equal(executed, false);
    assert.match(result.content[0].text, /REQUEST_CANCELLED/);
  });

  it('records exit-code failures while preserving MCP command output semantics and omitting secrets', async (t) => {
    const { runtime, file } = setup(t);
    const result = await runtime.run('execute-command', {
      cmdString: 'echo SECRET_ARGUMENT_123', content: 'SECRET_CONTENT_456', connectionName: 'dev',
    }, async () => text('SECRET_OUTPUT_789\n[exit code] 2'), undefined, 'WorkBuddy');
    assert.equal(result.isError, undefined);
    const data = readMonitor(file);
    assert.equal(data.events[0].status, 'failed');
    assert.equal(data.events[0].exitCode, 2);
    assert.equal(data.events[0].source, 'workbuddy');
    assert.doesNotMatch(JSON.stringify(data), /SECRET_|never-log-this-password/);
  });

  it('does not execute operations if the initial audit write fails', async (t) => {
    const { runtime } = setup(t);
    runtime.audit.append = () => { throw new Error('disk unavailable'); };
    let executed = false;
    const result = await runtime.run('write-file', {}, async () => { executed = true; return text('never'); });
    assert.equal(executed, false);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /AUDIT_OR_RUNTIME_UNAVAILABLE/);
  });

  it('bounds active plus queued calls to 128 and audits overload rejection', async (t) => {
    const { runtime, file } = setup(t);
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const runs = Array.from({ length: 128 }, () => runtime.run('execute-command', {}, async () => {
      await blocked;
      return text('done');
    }));
    await tick();
    let executed = false;
    try {
      const result = await runtime.run('execute-command', { cmdString: 'sudo echo test' }, async () => { executed = true; return text('never'); });
      assert.match(result.content[0].text, /MCP_BUSY/);
      assert.equal(executed, false);
    } finally {
      release();
      await Promise.all(runs);
    }
    const monitor = readMonitor(file, { limit: 200 });
    assert.ok(monitor.events.some((e) => e.failureCode === 'MCP_BUSY'));
    assert.ok(monitor.events.some((e) => e.connectionName === 'dev'));
  });

  it('validates full ports and duplicate names and leaves existing manager config intact on bad regexes', () => {
    for (const port of ['22junk', 22.5, 0, 65536]) {
      assert.throws(() => CommandLineParser.parseConfigContent(JSON.stringify([{ ...config('dev')[0], port }])), /Port/);
    }
    assert.throws(() => CommandLineParser.parseConfigContent(JSON.stringify([...config('dev'), ...config('dev')])), /Duplicate/);
    const manager = SSHConnectionManager.getInstance();
    manager.setConfig(CommandLineParser.parseConfigContent(JSON.stringify(config('old'))));
    assert.throws(() => manager.setConfig({
      bad: { ...config('bad')[0], commandWhitelist: ['['] },
    }));
    assert.equal(manager.getConfig('old').name, 'old');
    manager.disconnect();
  });

  it('routes all ten tools through the same runtime without logging file content or local paths', async () => {
    const tools = {};
    const calls = [];
    const runtime = {
      async run(tool, args, _action, _signal, client) { calls.push({ tool, args, client }); return text('monitored'); },
    };
    registerAllTools({
      server: { getClientVersion: () => ({ name: 'WorkBuddy' }) },
      registerTool(name, _config, callback) { tools[name] = callback; },
    }, runtime);
    assert.equal(Object.keys(tools).length, 10);
    for (const [name, callback] of Object.entries(tools)) {
      const args = { connectionName: 'dev', cmdString: 'echo test', remotePath: '/tmp/a', localPath: 'SECRET_LOCAL_PATH', content: 'SECRET_FILE_CONTENT' };
      await callback(name === 'list-servers' ? {} : args, {});
    }
    assert.equal(calls.length, 10);
    assert.ok(calls.every((c) => c.client === 'WorkBuddy'));
    assert.doesNotMatch(JSON.stringify(calls), /SECRET_LOCAL_PATH|SECRET_FILE_CONTENT/);
  });
});
