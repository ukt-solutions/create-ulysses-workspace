#!/usr/bin/env node
// Unit tests for bash-output-advisory.mjs pattern detection.
// Run: node .claude/hooks/_bash-output-advisory.test.mjs
import { detectNoisyPattern } from './bash-output-advisory.mjs';

let failed = 0;
let passed = 0;

function shouldWarn(command, label) {
  const result = detectNoisyPattern(command);
  if (result) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}\n    command: ${command}\n    expected an advisory, got null`);
  }
}

function shouldNotWarn(command, label) {
  const result = detectNoisyPattern(command);
  if (!result) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}\n    command: ${command}\n    expected null, got: ${result}`);
  }
}

// === Test runners ===
shouldWarn('npm test', 'bare npm test');
shouldWarn('npm run test', 'bare npm run test');
shouldWarn('yarn test', 'bare yarn test');
shouldWarn('pnpm test', 'bare pnpm test');
shouldWarn('bun test', 'bare bun test');
shouldWarn('cargo test', 'bare cargo test');
shouldWarn('npm test --coverage', 'npm test with non-scoping flag');

shouldNotWarn('npm test path/to/file.test.mjs', 'npm test with file path');
shouldNotWarn('npm test src/', 'npm test with directory');
shouldNotWarn('npm test -- --grep auth', 'npm test with -- args');
shouldNotWarn('npm test myFile.test.js', 'npm test with bare filename');
shouldNotWarn('npm test | grep FAIL', 'npm test piped to grep');
shouldNotWarn('npm test | head -50', 'npm test piped to head');
shouldNotWarn('cargo test auth_module', 'cargo test with module filter');

// === grep -r ===
shouldWarn('grep -r "pattern" .', 'bare grep -r');
shouldWarn('grep --recursive "pattern" src/', 'grep --recursive long form');
shouldWarn('grep -rn "TODO" .', 'grep -rn (recursive + line numbers)');

shouldNotWarn('grep -r --include="*.js" pattern .', 'grep -r with --include');
shouldNotWarn('grep -r pattern . --exclude="*.log"', 'grep -r with --exclude');
shouldNotWarn('grep "pattern" file.txt', 'non-recursive grep');

// === find on broad anchors ===
shouldWarn('find /', 'find on root');
shouldWarn('find ~', 'find on home tilde');
shouldWarn('find $HOME', 'find on $HOME');

shouldNotWarn('find / -name "*.log"', 'find / with -name');
shouldNotWarn('find ~ -path "*node_modules*" -prune', 'find ~ with -path');
shouldNotWarn('find . -type f', 'find on cwd');
shouldNotWarn('find ./src -name "*.ts"', 'find on relative subdir');

// === cat on log-shaped files ===
shouldWarn('cat server.log', 'cat .log file');
shouldWarn('cat events.jsonl', 'cat .jsonl file');
shouldWarn('cat trace.ndjson', 'cat .ndjson file');
shouldWarn('cat path/to/big.log', 'cat .log in subdir');

shouldNotWarn('cat package.json', 'cat package.json');
shouldNotWarn('cat README.md', 'cat README');
shouldNotWarn('cat src/index.ts', 'cat source file');
shouldNotWarn('cat server.log | tail -50', 'cat .log piped to tail');

// === redirected output (always allowed) ===
shouldNotWarn('npm test > /tmp/test-output.txt', 'npm test redirected to file');
shouldNotWarn('grep -r foo . > out.txt', 'grep -r redirected to file');
shouldNotWarn('find / 2>&1 | tee /tmp/find.txt', 'find piped to tee');

// === unrelated commands ===
shouldNotWarn('git status', 'git status');
shouldNotWarn('ls -la', 'ls');
shouldNotWarn('echo hello', 'echo');
shouldNotWarn('node --version', 'node version');

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
