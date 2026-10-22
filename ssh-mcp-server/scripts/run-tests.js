#!/usr/bin/env node

/**
 * 测试运行器
 * 使用 Node.js 内置的测试框架运行所有测试
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

console.log('🧪 运行测试...\n');

for (const args of [['scripts/build.js'], ['--test', 'test/*.test.js']]) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  if (result.error) {
    console.error('Unable to run tests:', result.error.message);
  }
  if (result.error || result.status !== 0) {
    process.exit(result.status || 1);
  }
}
