import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  readdir,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = join(root, 'bin/posthog-axi.js');
const key = 'phx_fixture_secret';
async function environment(t, responder = () => ({ results: [], next: null })) {
  const directory = await mkdtemp(join(tmpdir(), 'posthog-axi-'));
  const home = join(directory, 'home');
  await mkdir(home);
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body,
    });
    const response = await responder(req, requests.length);
    if (response === null) return;
    res.writeHead(response.status ?? 200, {
      'Content-Type': 'application/json',
      ...response.headers,
    });
    res.end(response.raw ?? JSON.stringify(response.data ?? response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function run(args = [], env = {}, executable = bin) {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        POSTHOG_HOST: host,
        POSTHOG_PROJECT_ID: '42',
        POSTHOG_PERSONAL_API_KEY: key,
        ...env,
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
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(stderr, '');
    return {
      code,
      stdout,
      value: stdout.trim().startsWith('{') ? JSON.parse(stdout) : undefined,
    };
  }
  return { run, requests, host, directory, home };
}
test('review nullable synchronous query status is absent, but status commands stay strict', async (t) => {
  const e = await environment(t, () => ({
    columns: ['1'],
    results: [[1]],
    query_status: null,
  }));
  const sync = await e.run(['query', '--sql', 'SELECT 1', '--json']);
  assert.equal(sync.code, 0, sync.stdout);
  assert.deepEqual(sync.value, {
    state: 'complete',
    columns: ['1'],
    rows: [[1]],
    returned: 1,
    received: 1,
    backend_has_more: null,
    truncated: false,
    message: 'Query completed.',
  });
  const status = await e.run(['query', 'status', 'q', '--json']);
  assert.equal(status.code, 1);
  assert.equal(status.value.error.code, 'INVALID_RESPONSE');
});

for (const status of [null, {}, [], { id: 'q', complete: 'true' }]) {
  test(`review rejects malformed non-null query status ${JSON.stringify(status)}`, async (t) => {
    const e = await environment(t, () => ({
      columns: ['x'],
      results: [[1]],
      query_status: status,
    }));
    const result = await e.run(['query', 'status', 'q', '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.value.error.code, 'INVALID_RESPONSE');
    if (status !== null) {
      const sync = await e.run(['query', '--sql', 'SELECT 1', '--json']);
      assert.equal(sync.code, 1);
      assert.equal(sync.value.error.code, 'INVALID_RESPONSE');
    }
  });
}

for (const asynchronous of [false, true]) {
  for (const [
    name,
    hasMore,
    rowCount,
    cap,
    expectedMore,
    truncated,
    message,
  ] of [
    [
      'more',
      true,
      1,
      1,
      true,
      true,
      'PostHog reports more rows. Narrow the SQL and time range to obtain a complete result.',
    ],
    ['no more', false, 1, 1, false, false, 'Query completed.'],
    ['unknown', undefined, 1, 1, null, false, 'Query completed.'],
    ['null', null, 1, 1, null, false, 'Query completed.'],
    [
      'display capped',
      false,
      2,
      1,
      false,
      true,
      'Displayed rows are capped. Use a SQL LIMIT and time range to bound computation.',
    ],
    [
      'both capped',
      true,
      2,
      1,
      true,
      true,
      'PostHog reports more rows. Narrow the SQL and time range to obtain a complete result.',
    ],
    [
      'empty partial',
      true,
      0,
      1,
      true,
      true,
      'PostHog reports more rows. Narrow the SQL and time range to obtain a complete result.',
    ],
  ]) {
    test(`review query completeness ${asynchronous ? 'async' : 'sync'} ${name}`, async (t) => {
      const results = Array.from({ length: rowCount }, () => ['$pageview']);
      const data = {
        columns: ['event'],
        results,
        hasMore,
        limit: 1,
        offset: 0,
      };
      const e = await environment(t, () =>
        asynchronous
          ? { query_status: { id: 'q', complete: true, results: data } }
          : data,
      );
      const args = asynchronous
        ? ['query', 'status', 'q']
        : ['query', '--sql', 'SELECT event FROM events'];
      const result = await e.run([
        ...args,
        '--limit',
        String(cap),
        '--full',
        '--json',
      ]);
      assert.equal(result.code, 0, result.stdout);
      assert.deepEqual(result.value, {
        state: 'complete',
        columns: ['event'],
        rows: results.slice(0, cap),
        returned: Math.min(rowCount, cap),
        received: rowCount,
        backend_has_more: expectedMore,
        truncated,
        message,
      });
      assert.equal(e.requests.length, 1);
    });
  }
  test(`review query rejects invalid hasMore ${asynchronous ? 'async' : 'sync'}`, async (t) => {
    const e = await environment(t, () => {
      const data = { columns: ['x'], results: [[1]], hasMore: 'true' };
      return asynchronous
        ? { query_status: { id: 'q', complete: true, results: data } }
        : data;
    });
    const args = asynchronous
      ? ['query', 'status', 'q']
      : ['query', '--sql', 'SELECT 1'];
    const result = await e.run([...args, '--json']);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.value.error.code, 'INVALID_RESPONSE');
  });
}

for (const [args, expected] of [
  [
    ['flags', 'view', '--bogus'],
    'Unknown flag --bogus for flags view. Valid flags: --help --json --host --project --fields --full.',
  ],
  [
    ['flags', 'view', '7', '--stat', 'active', 'extra'],
    'Unknown flag --stat for flags view. Valid flags: --help --json --host --project --fields --full.',
  ],
  [
    ['insights', 'list', '--stat', 'active'],
    'Unknown flag --stat for insights list. Valid flags: --help --json --host --project --limit --offset --fields --full.',
  ],
  [
    ['flags', 'view', '7', '--limit', '1'],
    'Invalid flag --limit for flags view. Valid flags: --help --json --host --project --fields --full.',
  ],
  [
    ['events', 'list', '--offset', '1'],
    'Invalid flag --offset for events list. Valid flags: --help --json --host --project --limit --fields --full --before --after --event --distinct-id.',
  ],
  [
    ['query', 'status', 'q', '--sql', 'SELECT 1'],
    'Invalid flag --sql for query status. Valid flags: --help --json --host --project --limit --full.',
  ],
  [
    ['setup', 'status', '--bogus'],
    'Unknown flag --bogus for setup status. Valid flags: --help --json --host --project --project-dir.',
  ],
]) {
  test(`review scoped flag advice ${args.join(' ')}`, async (t) => {
    const e = await environment(t);
    for (const suffix of [[], ['--help']]) {
      const result = await e.run([...args, ...suffix, '--json'], {
        POSTHOG_PERSONAL_API_KEY: '',
      });
      assert.equal(result.code, 2);
      assert.deepEqual(result.value, {
        error: { code: 'VALIDATION_ERROR', message: expected },
      });
    }
    assert.deepEqual(e.requests, []);
  });
}

for (const [status, advice] of [
  [400, 'Check command inputs and SQL, then use scoped --help.'],
  [
    401,
    'Set POSTHOG_PERSONAL_API_KEY to a valid personal API key for this host.',
  ],
  [
    403,
    'Check personal API key read permissions and the selected project scope.',
  ],
  [404, 'Check the resource ID, --project, and --host.'],
  [
    503,
    'PostHog is temporarily unavailable. Retry later; query POSTs are not retried automatically.',
  ],
]) {
  test(`review safe HTTP ${status} remediation`, async (t) => {
    const e = await environment(t, () => ({
      status,
      raw: `upstream-private ${key}`,
    }));
    const result = await e.run(['projects', 'list', '--json']);
    assert.equal(result.code, 1);
    assert.deepEqual(result.value, {
      error: {
        code: 'HTTP_ERROR',
        message: `PostHog returned HTTP ${status}. ${advice}`,
        status,
      },
    });
    assert.equal(result.stdout.includes('upstream-private'), false);
    assert.equal(result.stdout.includes(key), false);
    assert.equal(e.requests.length, 1);
  });
}

test('review home collapses only a home path boundary', async (t) => {
  const e = await environment(t);
  for (const [home, expected] of [
    [resolve(root), '~/bin/posthog-axi.js'],
    [bin, '~'],
    [resolve(root).slice(0, -1), bin],
    [e.home, bin],
  ]) {
    const result = await e.run(['home', '--json'], {
      HOME: home,
      USERPROFILE: home,
      POSTHOG_PERSONAL_API_KEY: '',
    });
    assert.equal(result.code, 0);
    assert.equal(result.value.bin, expected);
  }
  assert.deepEqual(e.requests, []);
});

const uuid = '018f1111-2222-4333-8444-555555555555';
const examples = [
  [
    'projects',
    'projects',
    '7',
    { id: 7, name: 'Demo', timezone: 'UTC', api_token: 'hidden' },
    { id: 7, name: 'Demo', timezone: 'UTC' },
    { id: 7, name: 'Demo', timezone: 'UTC', created_at: null },
  ],
  [
    'insights',
    'insights',
    '7',
    { id: 7, name: 'Revenue', short_id: 'abc' },
    { id: 7, name: 'Revenue', short_id: 'abc' },
    {
      id: 7,
      name: 'Revenue',
      derived_name: null,
      description: null,
      short_id: 'abc',
      last_refresh: null,
      filters: null,
      query: null,
      tags: null,
      favorited: null,
      dashboard_tiles: null,
    },
  ],
  [
    'dashboards',
    'dashboards',
    '7',
    { id: 7, name: 'Growth', pinned: true },
    { id: 7, name: 'Growth', pinned: true },
    {
      id: 7,
      name: 'Growth',
      description: null,
      pinned: true,
      tags: null,
      tiles: null,
    },
  ],
  [
    'flags',
    'feature_flags',
    '7',
    { id: 7, key: 'launch', name: 'Launch', active: true },
    { id: 7, key: 'launch', name: 'Launch', active: true },
    {
      id: 7,
      key: 'launch',
      name: 'Launch',
      active: true,
      filters: null,
      archived: null,
      version: null,
    },
  ],
  [
    'events',
    'events',
    uuid,
    {
      id: uuid,
      event: '$pageview',
      timestamp: '2026-01-01T00:00:00Z',
      distinct_id: 'person',
    },
    {
      id: uuid,
      event: '$pageview',
      timestamp: '2026-01-01T00:00:00Z',
      distinct_id: 'person',
    },
    {
      id: uuid,
      event: '$pageview',
      timestamp: '2026-01-01T00:00:00Z',
      distinct_id: 'person',
      properties: null,
    },
  ],
];
for (const [resource, endpoint, id, item, summary, detail] of examples) {
  test(`${resource} list and view use safe fields and exact API contracts`, async (t) => {
    const e = await environment(t, (req) =>
      req.url.includes('?') ? { results: [item], count: 9, next: null } : item,
    );
    const list = await e.run([resource, 'list', '--json']);
    assert.equal(list.code, 0);
    assert.deepEqual(list.value, {
      resource,
      items: [summary],
      returned: 1,
      total: 9,
      next: null,
      message: `Returned 1 ${resource}.`,
    });
    const view = await e.run([resource, 'view', id, '--json', '--full']);
    assert.equal(view.code, 0);
    assert.deepEqual(view.value, { resource, item: detail });
    const path =
      resource === 'projects'
        ? '/api/projects/'
        : `/api/projects/42/${endpoint}/`;
    assert.deepEqual(e.requests, [
      {
        method: 'GET',
        url: `${path}?limit=25${resource === 'events' ? '' : '&offset=0'}`,
        authorization: `Bearer ${key}`,
        body: '',
      },
      {
        method: 'GET',
        url: `${path}${id}/`,
        authorization: `Bearer ${key}`,
        body: '',
      },
    ]);
  });
}

test('version aliases, help, and home never send requests or need authentication', async (t) => {
  const e = await environment(t);
  for (const flag of ['--version', '-v', '-V'])
    assert.deepEqual(
      await e.run([flag], {
        POSTHOG_PERSONAL_API_KEY: '',
        POSTHOG_HOST: 'invalid',
      }),
      { code: 0, stdout: '0.2.0\n', value: undefined },
    );
  for (const args of [
    ['--help'],
    ['home', '--help'],
    ...examples.flatMap(([name]) => [
      [name, '--help'],
      [name, 'list', '--help'],
      [name, 'view', '--help'],
    ]),
    ['query', '--help'],
    ['query', 'status', '--help'],
    ['setup', '--help'],
    ['setup', 'hooks', '--help'],
    ['setup', 'status', '--help'],
  ]) {
    const result = await e.run(args, { POSTHOG_PERSONAL_API_KEY: '' });
    assert.equal(result.code, 0, args.join(' '));
    assert.match(result.stdout, /posthog-axi/);
  }
  const home = await e.run(['home', '--json'], {
    POSTHOG_PERSONAL_API_KEY: '',
  });
  assert.equal(home.code, 0);
  assert.equal(home.value.authentication, 'missing POSTHOG_PERSONAL_API_KEY');
  assert.equal(home.value.bin, bin);
  assert.equal(home.value.project, '42');
  assert.equal(
    decode((await e.run([], { POSTHOG_PERSONAL_API_KEY: '' })).stdout).host,
    e.host,
  );
  assert.deepEqual(e.requests, []);
});

test('strict preflight rejects invalid usage before auth, even with help', async (t) => {
  const e = await environment(t);
  const cases = [
    ['nonsense'],
    ['nonsense', '--help'],
    ['flags', 'list', '--bogus', '--help'],
    ['flags', 'list', '--limit'],
    ['flags', 'list', '--limit', '1', '--limit', '2'],
    ['flags', 'list', 'extra'],
    ['flags', 'view', '../7'],
    ['events', 'view', '7'],
    ['flags', 'list', '--fields', 'api_token'],
    ['flags', 'list', '--fields', 'id,id'],
    ['flags', 'view', '7', '--limit', '3'],
    ['flags', 'list', '--limit', '101'],
    ['query', '--sql', 'select 1', '--file', 'missing'],
    ['query'],
    ['query', '--sql', ' '],
    ['query', '--file', 'missing'],
    ['query', 'status', '../escape'],
    ['home', 'extra'],
    ['flags', 'list', '--host', 'http://example.com'],
    ['home', '--host', 'https://user:pass@example.com'],
    ['home', '--host', 'https://example.com/api/'],
    ['home', '--host', 'https://example.com?key=value'],
    ['home', '--project', '0'],
    ['flags', 'list', '--limit', '-1'],
    ['flags', 'list', '--full', '--full'],
    ['flags', 'list', '--before', '2026-01-01T00:00:00Z'],
    ['flags', 'list', '--help', '--project', 'abc'],
  ];
  for (const args of cases) {
    const result = await e.run([...args, '--json'], {
      POSTHOG_PERSONAL_API_KEY: '',
    });
    assert.equal(result.code, 2, `${args.join(' ')}\n${result.stdout}`);
    assert.equal(result.value.error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(e.requests, []);
});

test('TOON default output is exact and fields are selected', async (t) => {
  const e = await environment(t, () => ({
    results: [{ id: 7, name: 'One' }],
    next: null,
  }));
  const result = await e.run(['projects', 'list', '--fields', 'id,name']);
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    'resource: projects\nitems[1]{id,name}:\n  7,One\nreturned: 1\ntotal: null\nnext: null\nmessage: Returned 1 projects.\n',
  );
  assert.equal(e.requests.length, 1);
});

test('pagination preserves scope and options and reports honest counts', async (t) => {
  const e = await environment(t, (req) =>
    req.url.includes('offset=2')
      ? { results: [], count: 3, next: null }
      : {
          results: [
            { id: 1, name: 'A' },
            { id: 2, name: 'B' },
          ],
          count: 3,
          next: '/api/projects/42/insights/?limit=2&offset=2',
        },
  );
  const result = await e.run([
    'insights',
    'list',
    '--limit',
    '2',
    '--fields',
    'id,name',
    '--full',
    '--json',
  ]);
  assert.deepEqual(result.value, {
    resource: 'insights',
    items: [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ],
    returned: 2,
    total: 3,
    next: `posthog-axi insights list --host '${e.host}' --project '42' --limit 2 --offset '2' --fields 'id,name' --full --json`,
    message: 'Returned 2 insights.',
  });
  const later = await e.run(['insights', 'list', '--offset', '2', '--json']);
  assert.deepEqual(later.value, {
    resource: 'insights',
    items: [],
    returned: 0,
    total: 3,
    next: null,
    message: 'No insights on this page.',
  });
  assert.deepEqual(
    e.requests.map((r) => r.url),
    [
      '/api/projects/42/insights/?limit=2&offset=0',
      '/api/projects/42/insights/?limit=25&offset=2',
    ],
  );
});

test('unknown totals and empty scopes are distinct from zero totals', async (t) => {
  const e = await environment(t, (_req, n) => ({
    results: [],
    next: null,
    ...(n === 2 ? { count: 0 } : {}),
  }));
  assert.deepEqual((await e.run(['projects', 'list', '--json'])).value, {
    resource: 'projects',
    items: [],
    returned: 0,
    total: null,
    next: null,
    message: 'No projects in this scope.',
  });
  assert.equal((await e.run(['projects', 'list', '--json'])).value.total, 0);
  assert.equal(e.requests.length, 2);
});

test('content previews preserve size and full never reveals known secrets', async (t) => {
  const description = 'x'.repeat(400);
  const e = await environment(t, () => ({
    id: 7,
    name: `name ${key}`,
    description,
    filters: {
      api_token: 'private',
      nested: { password: 'private', value: key },
    },
  }));
  const preview = await e.run(['insights', 'view', '7', '--json']);
  assert.equal(preview.code, 0);
  assert.deepEqual(preview.value.item.description, {
    preview: 'x'.repeat(300),
    characters: 400,
    hint: 'Use --full for untruncated content.',
  });
  const full = await e.run(['insights', 'view', '7', '--json', '--full']);
  assert.equal(full.value.item.description, description);
  assert.equal(full.value.item.name, 'name [REDACTED]');
  assert.deepEqual(full.value.item.filters, {
    api_token: '[REDACTED]',
    nested: { password: '[REDACTED]', value: '[REDACTED]' },
  });
  assert.equal(full.stdout.includes(key), false);
  assert.equal(e.requests.length, 2);
});

test('query inline and file send exact payloads and bound rows without rewriting SQL', async (t) => {
  const e = await environment(t, () => ({
    columns: ['count', 'count'],
    results: [
      [1, 2],
      [3, 4],
    ],
  }));
  const sql = 'SELECT 1, 2';
  await writeFile(join(e.directory, 'query.sql'), sql);
  for (const input of [
    ['--sql', sql],
    ['--file', join(e.directory, 'query.sql')],
  ]) {
    const result = await e.run(['query', ...input, '--limit', '1', '--json']);
    assert.equal(result.code, 0);
    assert.deepEqual(result.value, {
      state: 'complete',
      columns: ['count', 'count'],
      rows: [[1, 2]],
      returned: 1,
      received: 2,
      backend_has_more: null,
      truncated: true,
      message:
        'Displayed rows are capped. Use a SQL LIMIT and time range to bound computation.',
    });
  }
  assert.deepEqual(
    e.requests,
    [1, 2].map(() => ({
      method: 'POST',
      url: '/api/projects/42/query/',
      authorization: `Bearer ${key}`,
      body: JSON.stringify({
        query: { kind: 'HogQLQuery', query: sql },
        name: 'posthog-axi ad-hoc query',
        refresh: 'blocking',
      }),
    })),
  );
});

test('actual nested query status distinguishes pending, complete, failed, and zero', async (t) => {
  const payloads = [
    {
      status: 202,
      data: {
        query_status: {
          id: 'query-1',
          complete: false,
          error: false,
          results: null,
          team_id: 42,
        },
      },
    },
    {
      status: 202,
      data: {
        query_status: {
          id: 'query-1',
          complete: null,
          error: null,
          results: null,
        },
      },
    },
    {
      query_status: {
        id: 'query-1',
        complete: true,
        error: false,
        results: { columns: ['x'], results: [[7]] },
      },
    },
    {
      status: 400,
      data: {
        query_status: {
          id: 'query-1',
          complete: false,
          error: true,
          error_message: key,
        },
      },
    },
    { columns: ['x'], results: [] },
  ];
  const e = await environment(t, (_req, n) => payloads[n - 1]);
  const pending = {
    state: 'pending',
    id: 'query-1',
    next: `posthog-axi query status 'query-1' --host '${e.host}' --project '42' --limit 25 --json`,
  };
  const pendingPost = await e.run(['query', '--sql', 'SELECT 1', '--json']);
  assert.equal(pendingPost.code, 0);
  assert.deepEqual(pendingPost.value, pending);
  const pendingStatus = await e.run(['query', 'status', 'query-1', '--json']);
  assert.equal(pendingStatus.code, 0);
  assert.deepEqual(pendingStatus.value, pending);
  const complete = await e.run(['query', 'status', 'query-1', '--json']);
  assert.equal(complete.code, 0);
  assert.deepEqual(complete.value, {
    state: 'complete',
    columns: ['x'],
    rows: [[7]],
    returned: 1,
    received: 1,
    backend_has_more: null,
    truncated: false,
    message: 'Query completed.',
  });
  const failed = await e.run(['query', 'status', 'query-1', '--json']);
  assert.equal(failed.code, 1);
  assert.deepEqual(failed.value, {
    state: 'failed',
    id: 'query-1',
    message: 'PostHog query failed. Inspect the query in PostHog.',
  });
  assert.equal(failed.stdout.includes(key), false);
  assert.deepEqual(
    (await e.run(['query', '--sql', 'SELECT 1 WHERE false', '--json'])).value,
    {
      state: 'complete',
      columns: ['x'],
      rows: [],
      returned: 0,
      received: 0,
      backend_has_more: null,
      truncated: false,
      message: 'Query completed with zero rows.',
    },
  );
  assert.deepEqual(
    e.requests.map((r) => [r.method, r.url]),
    [
      ['POST', '/api/projects/42/query/'],
      ['GET', '/api/projects/42/query/query-1/'],
      ['GET', '/api/projects/42/query/query-1/'],
      ['GET', '/api/projects/42/query/query-1/'],
      ['POST', '/api/projects/42/query/'],
    ],
  );
});

test('malformed envelopes and query outcomes fail instead of inventing success', async (t) => {
  const bad = [
    [],
    {},
    { results: [], count: '3' },
    { results: [{ name: 'missing ID' }] },
    { results: [], next: 7 },
  ];
  const e = await environment(t, (_req, n) =>
    n <= bad.length
      ? { data: bad[n - 1] }
      : { data: { query_status: { id: 'q', complete: true, results: [] } } },
  );
  for (let n = 0; n < bad.length; n++) {
    const result = await e.run(['projects', 'list', '--json']);
    assert.equal(result.code, 1);
    assert.deepEqual(result.value, {
      error: {
        code: 'INVALID_RESPONSE',
        message: 'PostHog returned an invalid response.',
      },
    });
  }
  assert.equal(
    (await e.run(['query', 'status', 'q', '--json'])).value.error.code,
    'INVALID_RESPONSE',
  );
  assert.equal(e.requests.length, 6);
});

test('HTTP failures are structured, redacted, and never retried', async (t) => {
  const e = await environment(t, (_req, n) => ({
    status: n === 1 ? 429 : 503,
    headers: { 'Retry-After': '999999' },
    data: { detail: key },
  }));
  const rate = await e.run(['query', '--sql', 'SELECT 1', '--json']);
  assert.equal(rate.code, 1);
  assert.deepEqual(rate.value, {
    error: {
      code: 'HTTP_ERROR',
      message: 'PostHog returned HTTP 429.',
      status: 429,
      retry: 'Retry after 86400 seconds.',
    },
  });
  const unavailable = await e.run(['projects', 'list', '--json']);
  assert.equal(unavailable.code, 1);
  assert.deepEqual(unavailable.value, {
    error: {
      code: 'HTTP_ERROR',
      message:
        'PostHog returned HTTP 503. PostHog is temporarily unavailable. Retry later; query POSTs are not retried automatically.',
      status: 503,
    },
  });
  assert.equal(e.requests.length, 2);
});

test('hostile pagination and redirects never forward credentials', async (t) => {
  let hostileRequests = 0;
  const hostile = createServer((_req, res) => {
    hostileRequests++;
    res.end('{}');
  });
  await new Promise((resolve) => hostile.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => hostile.close(resolve)));
  const target = `http://127.0.0.1:${hostile.address().port}`;
  const e = await environment(t, (_req, n) =>
    n === 1
      ? { results: [{ id: 1 }], next: `${target}/api/projects/?offset=25` }
      : { status: 302, headers: { Location: `${target}/` }, data: {} },
  );
  for (const code of ['UNSAFE_PAGINATION', 'REDIRECT_REFUSED']) {
    const result = await e.run(['projects', 'list', '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.value.error.code, code);
  }
  assert.equal(e.requests.length, 2);
  assert.equal(hostileRequests, 0);
});

test('request timeout and response byte limits are enforced', async (t) => {
  const e = await environment(t, (_req, n) =>
    n === 1 ? null : { raw: 'x'.repeat(2097153) },
  );
  const timeout = await e.run(['projects', 'list', '--json']);
  assert.equal(timeout.code, 1);
  assert.deepEqual(timeout.value, {
    error: {
      code: 'TIMEOUT',
      message: 'PostHog request timed out after 10000ms.',
    },
  });
  const large = await e.run(['projects', 'list', '--json']);
  assert.equal(large.code, 1);
  assert.deepEqual(large.value, {
    error: {
      code: 'RESPONSE_TOO_LARGE',
      message: 'PostHog response exceeds 2097152 bytes. Narrow the request.',
    },
  });
  assert.equal(e.requests.length, 2);
});

test('setup is honestly deferred and status performs no writes', async (t) => {
  const e = await environment(t);
  const status = await e.run([
    'setup',
    'status',
    '--project-dir',
    e.directory,
    '--json',
  ]);
  assert.equal(status.code, 0);
  assert.equal(status.value.installation, 'deferred');
  assert.equal(status.value.claude.installed, false);
  assert.deepEqual(await readdir(e.home), []);
  const setup = await e.run([
    'setup',
    'hooks',
    '--project-dir',
    e.directory,
    '--allow-codex-user-config',
    '--json',
  ]);
  assert.equal(setup.code, 1);
  assert.deepEqual(setup.value, {
    error: {
      code: 'HOOKS_DEFERRED',
      message:
        'SDK 0.1.13 does not safely quote executable paths in shell hooks. No files were written. Install the generated Agent Skill instead.',
    },
  });
  assert.deepEqual(await readdir(e.home), []);
  assert.deepEqual(e.requests, []);
});

test('self-update is shadowed and cannot invoke npm', async (t) => {
  const e = await environment(t);
  const result = await e.run(['update', '--json']);
  assert.equal(result.code, 1);
  assert.deepEqual(result.value, {
    error: {
      code: 'UPDATE_UNAVAILABLE',
      message:
        'This private local package cannot self-update. Reinstall from your trusted local checkout.',
    },
  });
  assert.deepEqual(e.requests, []);
});

test('package can be packed and installed outside checkout', async (t) => {
  const e = await environment(t);
  async function npm(args, cwd) {
    const child = spawn('npm', args, {
      cwd,
      env: { ...process.env, HOME: e.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    assert.equal(
      await new Promise((resolve) => child.on('close', resolve)),
      0,
      errors,
    );
    return output;
  }
  const packed = JSON.parse(
    await npm(['pack', '--json', '--pack-destination', e.directory], root),
  )[0];
  assert.equal(
    packed.files.some((file) =>
      /(?:node_modules|\.audit|test\/|\.env)/.test(file.path),
    ),
    false,
  );
  assert.equal(
    packed.files.some((file) => file.path === 'skills/posthog-axi/SKILL.md'),
    true,
  );
  await writeFile(join(e.directory, 'package.json'), '{"private":true}');
  await npm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(e.directory, packed.filename),
    ],
    e.directory,
  );
  const executable = join(
    e.directory,
    'node_modules/posthog-axi/bin/posthog-axi.js',
  );
  const installedCli = join(e.directory, 'node_modules/posthog-axi/src/cli.js');
  await rename(installedCli, `${installedCli}.disabled`);
  for (const alias of ['--version', '-v', '-V'])
    assert.equal((await e.run([alias], {}, executable)).stdout, '0.2.0\n');
  await rename(`${installedCli}.disabled`, installedCli);
  const linked = spawn(
    join(e.directory, 'node_modules/.bin/posthog-axi'),
    ['--version'],
    {
      cwd: e.directory,
      env: { ...process.env, HOME: e.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let version = '',
    errors = '';
  linked.stdout.on('data', (chunk) => {
    version += chunk;
  });
  linked.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  assert.equal(await new Promise((resolve) => linked.on('close', resolve)), 0);
  assert.equal(version, '0.2.0\n');
  assert.equal(errors, '');
  const list = await e.run(['projects', 'list', '--json'], {}, executable);
  assert.equal(list.code, 0);
  assert.deepEqual(list.value, {
    resource: 'projects',
    items: [],
    returned: 0,
    total: null,
    next: null,
    message: 'No projects in this scope.',
  });
  const metadata = JSON.parse(
    await readFile(
      join(e.directory, 'node_modules/posthog-axi/package.json'),
      'utf8',
    ),
  );
  assert.equal(metadata.private, true);
  assert.equal(metadata.license, 'UNLICENSED');
  assert.equal(e.requests.length, 1);
});
