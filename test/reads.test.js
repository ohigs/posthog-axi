import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/posthog-axi.js', import.meta.url));
const uuid = 'a1111111-1111-4111-8111-111111111111';
const cases = [
  {
    resource: 'persons',
    endpoint: 'persons',
    id: uuid,
    item: {
      id: 17,
      uuid,
      name: 'Fixture person',
      distinct_ids: ['fixture-user'],
      properties: { secret: 'hidden' },
    },
    field: 'distinct_ids',
    expected: ['fixture-user'],
    filter: ['--distinct-id', 'fixture-user'],
    param: 'distinct_id=fixture-user',
  },
  {
    resource: 'cohorts',
    endpoint: 'cohorts',
    id: '18',
    item: {
      id: 18,
      name: 'Fixture cohort',
      count: 0,
      is_calculating: false,
      filters: { properties: { type: 'AND', values: [] } },
    },
    field: 'count',
    expected: 0,
    filter: ['--search', 'Fixture cohort'],
    param: 'search=Fixture+cohort',
  },
  {
    resource: 'annotations',
    endpoint: 'annotations',
    id: '19',
    item: {
      id: 19,
      content: 'Fixture deployment',
      date_marker: '2026-01-01T00:00:00Z',
      scope: 'project',
      dashboard_id: null,
    },
    field: 'content',
    expected: 'Fixture deployment',
    filter: ['--search', 'Fixture deployment'],
    param: 'search=Fixture+deployment',
  },
  {
    resource: 'recordings',
    endpoint: 'session_recordings',
    id: 'legacy-session_1',
    item: {
      id: 'legacy-session_1',
      recording_duration: 12,
      distinct_id: 'fixture-user',
      start_time: '2026-01-01T00:00:00Z',
    },
    field: 'recording_duration',
    expected: 12,
    filter: [],
    param: '',
  },
];
for (const scenario of cases) {
  test(`${scenario.resource} reads use scoped endpoints, bounded pagination and safe projections`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'posthog-axi-reads-'));
    const requests = [];
    const server = createServer((req, res) => {
      requests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url.includes('?')
            ? {
                results: [
                  {
                    ...scenario.item,
                    ...(scenario.resource === 'recordings' &&
                    req.url.includes('offset=1')
                      ? { id: 'legacy-session_2' }
                      : {}),
                    api_token: 'must-not-leak',
                  },
                ],
                ...(scenario.resource === 'recordings' ? {} : { count: 2 }),
                ...(scenario.resource === 'recordings'
                  ? {
                      has_next: !req.url.includes('offset=1'),
                      next_cursor: 'opaque-server-cursor',
                    }
                  : {
                      next: `/api/projects/42/${scenario.endpoint}/?limit=1&offset=1`,
                    }),
              }
            : { ...scenario.item, api_token: 'must-not-leak' },
        ),
      );
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(home, { recursive: true, force: true });
    });
    const host = `http://127.0.0.1:${server.address().port}`;
    const run = async (args) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          POSTHOG_PERSONAL_API_KEY: 'phx_fixture_only',
          POSTHOG_PROJECT_ID: '42',
          POSTHOG_HOST: host,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((done, reject) => {
        child.on('error', reject);
        child.on('close', done);
      });
      assert.equal(stderr, '');
      return { code, stdout, value: JSON.parse(stdout) };
    };
    const detail = await run([
      scenario.resource,
      'view',
      scenario.id,
      '--json',
    ]);
    assert.equal(detail.code, 0, detail.stdout);
    assert.deepEqual(detail.value.item[scenario.field], scenario.expected);
    assert.equal(detail.stdout.includes('must-not-leak'), false);
    assert.equal(detail.stdout.includes('hidden'), false);
    assert.equal(
      requests[0].url,
      `/api/projects/42/${scenario.endpoint}/${scenario.id}/`,
    );
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].auth, 'Bearer phx_fixture_only');
    const list = await run([
      scenario.resource,
      'list',
      '--limit',
      '1',
      '--fields',
      `id,${scenario.field}`,
      ...scenario.filter,
      '--json',
    ]);
    assert.equal(list.code, 0, list.stdout);
    assert.equal(list.value.returned, 1);
    assert.equal(
      list.value.total,
      scenario.resource === 'recordings' ? null : 2,
    );
    assert.deepEqual(list.value.items, [
      { id: scenario.item.id, [scenario.field]: scenario.expected },
    ]);
    assert.match(list.value.next, /--offset '1'/);
    assert.ok(list.value.next.includes(`--host '${host}'`));
    assert.ok(list.value.next.includes("--project '42'"));
    assert.ok(list.value.next.includes(`--fields 'id,${scenario.field}'`));
    assert.ok(list.value.next.endsWith('--json'));
    assert.ok(requests[1].url.includes('limit=1&offset=0'));
    assert.ok(requests[1].url.includes(scenario.param));
    const invalid = await run([
      scenario.resource,
      'view',
      '../unsafe',
      '--json',
    ]);
    assert.equal(invalid.code, 2, invalid.stdout);
    assert.equal(requests.length, 2);
    const mutation = await run([scenario.resource, 'create', '--json']);
    assert.equal(mutation.code, 2, mutation.stdout);
    assert.equal(requests.length, 2);
    if (scenario.resource === 'persons') {
      const alias = await run([
        'persons',
        'view',
        uuid.toUpperCase(),
        '--json',
      ]);
      assert.equal(alias.code, 0, alias.stdout);
      assert.equal(alias.value.item.uuid, uuid);
      const wrong = await run(['persons', 'view', '99', '--json']);
      assert.equal(wrong.code, 1, wrong.stdout);
      assert.equal(wrong.value.error.code, 'INVALID_RESPONSE');
    }
    if (scenario.resource === 'recordings') {
      const nextArgs = list.value.next
        .match(/'[^']*'|\S+/g)
        .slice(1)
        .map((token) => (token.startsWith("'") ? token.slice(1, -1) : token));
      const nextPage = await run(nextArgs);
      assert.equal(nextPage.code, 0, nextPage.stdout);
      assert.deepEqual(nextPage.value.items, [
        { id: 'legacy-session_2', recording_duration: 12 },
      ]);
      assert.equal(nextPage.value.next, null);
      assert.equal(
        requests[2].url,
        '/api/projects/42/session_recordings/?limit=1&offset=1',
      );
      const wrongCase = await run([
        'recordings',
        'view',
        scenario.id.toUpperCase(),
        '--json',
      ]);
      assert.equal(wrongCase.code, 1, wrongCase.stdout);
      assert.equal(wrongCase.value.error.code, 'INVALID_RESPONSE');
    }
  });
}
