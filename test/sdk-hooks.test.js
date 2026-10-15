import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { installSessionStartHooks, sessionStartHookStatus } from 'axi-sdk-js';

test('disposable-home SDK probe proves shell paths with spaces are unsafe despite installed status', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'posthog-axi-sdk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const homeDir = join(directory, 'home');
  const projectDir = join(directory, 'project');
  const executableDir = join(directory, 'path with spaces');
  await mkdir(homeDir);
  await mkdir(projectDir);
  await mkdir(executableDir);
  const execPath = join(executableDir, 'posthog-axi');
  await writeFile(execPath, '#!/bin/sh\nprintf "fixture home\\n"\n');
  await chmod(execPath, 0o755);
  const errors = [];
  const options = {
    homeDir,
    projectDir,
    scope: 'project',
    marker: 'posthog-axi',
    execPath,
    shouldInstall: () => true,
    onError: (message) => errors.push(message),
  };
  installSessionStartHooks(options);
  assert.deepEqual(errors, []);
  const status = sessionStartHookStatus(options);
  assert.equal(status.claude.installed, true);
  assert.equal(status.codex.installed, true);
  assert.equal(status.codex.userFeatureEnabled, true);
  assert.equal(status.opencode.installed, true);
  const first = await readFile(status.claude.path, 'utf8');
  installSessionStartHooks(options);
  assert.equal(await readFile(status.claude.path, 'utf8'), first);
  const hook = JSON.parse(first).hooks.SessionStart[0].hooks[0];
  assert.equal(hook.command, execPath);
  const child = spawn('sh', ['-c', hook.command], {
    cwd: projectDir,
    env: { PATH: process.env.PATH, HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.resume();
  assert.equal(await new Promise((resolve) => child.on('close', resolve)), 127);
  assert.equal(stdout, '');
  assert.equal(
    await readFile(status.codex.userFeaturePath, 'utf8'),
    '[features]\nhooks = true\n',
  );
});

test('SDK partial failure is observable and preserves malformed unrelated config', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'posthog-axi-sdk-partial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const homeDir = join(directory, 'home');
  const projectDir = join(directory, 'project');
  await mkdir(join(projectDir, '.claude'), { recursive: true });
  await mkdir(homeDir);
  const original = '{malformed existing config';
  await writeFile(join(projectDir, '.claude/settings.json'), original);
  const errors = [];
  const options = {
    marker: 'posthog-axi',
    execPath: join(directory, 'posthog-axi'),
    homeDir,
    projectDir,
    scope: 'project',
    shouldInstall: () => true,
    onError: (message) => errors.push(message),
  };
  installSessionStartHooks(options);
  assert.equal(errors.length, 1);
  const status = sessionStartHookStatus(options);
  assert.deepEqual(
    [
      status.claude.installed,
      status.codex.installed,
      status.opencode.installed,
    ],
    [false, true, true],
  );
  assert.equal(await readFile(status.claude.path, 'utf8'), original);
});
