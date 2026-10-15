import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resources, validProject, validQueryId } from './resources.js';
import { usage } from './errors.js';

export const commonFlags = ['help', 'json', 'host', 'project'];
export const commandFlags = {
  home: [],
  list: ['limit', 'offset', 'fields', 'full'],
  view: ['fields', 'full'],
  query: ['sql', 'file', 'limit', 'full'],
  'query-status': ['limit', 'full'],
  'setup-hooks': ['project-dir', 'allow-codex-user-config'],
  'setup-status': ['project-dir'],
  update: [],
};
const booleans = new Set(['help', 'json', 'full', 'allow-codex-user-config']);

export function allowedFlags(kind, resource) {
  return [
    ...commonFlags,
    ...commandFlags[kind],
    ...(kind === 'list'
      ? [
          ...(resources[resource].pagination ?? []),
          ...Object.keys(resources[resource].filters ?? {}),
        ]
      : []),
  ].filter((flag) => !(resource === 'events' && flag === 'offset'));
}

export function parseHost(raw) {
  let host;
  try {
    host = new URL(raw);
  } catch {
    throw usage('Invalid --host. Use an HTTPS origin.');
  }
  if (
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    host.pathname !== '/' ||
    !(
      host.protocol === 'https:' ||
      (host.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname))
    )
  ) {
    throw usage(
      'Invalid --host. Use HTTPS or loopback HTTP without credentials, path, query, or fragment.',
    );
  }
  return host.origin;
}
function integer(raw, name, minimum, maximum) {
  if (
    !/^[0-9]+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < minimum ||
    Number(raw) > maximum
  ) {
    throw usage(
      `--${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return Number(raw);
}

export async function parseInvocation(argv, env) {
  if (argv[0]?.startsWith('-') && !(argv.length === 1 && argv[0] === '--help'))
    throw usage('Flags must follow a command. Use home --json or --help.');
  const positionals = [];
  const flags = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith('--') || token.includes('='))
      throw usage('Use documented --flags followed by separate values.');
    const name = token.slice(2);
    if (
      ![
        ...commonFlags,
        ...Object.values(commandFlags).flat(),
        ...Object.values(resources).flatMap((spec) => [
          ...(spec.pagination ?? []),
          ...Object.keys(spec.filters ?? {}),
        ]),
      ].includes(name)
    ) {
      unknown.push(name);
      continue;
    }
    if (Object.hasOwn(flags, name)) throw usage(`Duplicate --${name}.`);
    if (booleans.has(name)) flags[name] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--'))
        throw usage(`Missing value for --${name}.`);
      flags[name] = argv[++i];
    }
  }
  const [command = 'home', action, id] = positionals;
  let kind = command;
  let resource;
  if (Object.hasOwn(resources, command)) {
    resource = command;
    if (!action && flags.help) kind = 'list';
    else if (!['list', 'view'].includes(action))
      throw usage('Expected list or view.');
    else kind = action;
  } else if (command === 'query') {
    kind = action === 'status' ? 'query-status' : 'query';
  } else if (command === 'setup') {
    if (!['hooks', 'status'].includes(action)) {
      if (flags.help && !action) kind = 'setup-status';
      else throw usage('Expected setup hooks or setup status.');
    } else kind = `setup-${action}`;
  } else if (!['home', 'update'].includes(command))
    throw usage('Unknown command or unexpected argument. Run --help.');
  const allowed = allowedFlags(kind, resource);
  const invalid = Object.keys(flags).find((name) => !allowed.includes(name));
  if (unknown.length || invalid) {
    const name = unknown[0] ?? invalid;
    const scope = [command, action].filter(Boolean).join(' ');
    throw usage(
      `${unknown.length ? 'Unknown' : 'Invalid'} flag --${name} for ${scope}. Valid flags: ${allowed.map((flag) => `--${flag}`).join(' ')}.`,
    );
  }
  if (resource) {
    if (positionals.length > (kind === 'view' ? 3 : 2))
      throw usage('Unexpected positional argument.');
    if (kind === 'view' && (!id ? !flags.help : !resources[resource].id(id)))
      throw usage('Invalid resource ID.');
  } else if (kind === 'query-status') {
    if ((!id ? !flags.help : !validQueryId(id)) || positionals.length > 3)
      throw usage('Invalid query status ID.');
  } else if (kind === 'query') {
    if (positionals.length > 1) throw usage('Unexpected query argument.');
  } else if (command === 'setup') {
    if (positionals.length > 2) throw usage('Unexpected setup argument.');
  } else if (positionals.length > 1)
    throw usage('Unknown command or unexpected argument. Run --help.');
  for (const name of Object.keys(resources[resource]?.filters ?? {}))
    if (
      flags[name] !== undefined &&
      (!flags[name] ||
        flags[name].length > 256 ||
        [...flags[name]].some((char) => char.codePointAt(0) < 32))
    )
      throw usage(`Invalid --${name} filter.`);
  for (const name of ['before', 'after'])
    if (
      flags[name] !== undefined &&
      (flags[name].length > 128 ||
        !/^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$/.test(flags[name]) ||
        !Number.isFinite(Date.parse(flags[name])))
    )
      throw usage(`Invalid --${name} timestamp.`);
  const host = parseHost(
    flags.host ?? env.POSTHOG_HOST ?? 'https://us.posthog.com',
  );
  const project = flags.project ?? env.POSTHOG_PROJECT_ID;
  if (project !== undefined && !validProject(project))
    throw usage('Invalid project ID.');
  const limit = integer(flags.limit ?? '25', 'limit', 1, 100);
  const offset = integer(
    flags.offset ?? '0',
    'offset',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  let fields;
  if (flags.fields !== undefined) {
    fields = flags.fields.split(',');
    if (
      new Set(fields).size !== fields.length ||
      fields.some((field) => !Object.hasOwn(resources[resource].fields, field))
    )
      throw usage('Invalid --fields. Run scoped --help for safe fields.');
  }
  if (flags.sql !== undefined && flags.file !== undefined)
    throw usage('--sql and --file are mutually exclusive.');
  let sql = flags.sql;
  if (flags.file !== undefined) {
    let handle;
    try {
      handle = await open(
        flags.file,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536)
        throw usage('SQL file must be a regular file of at most 65536 bytes.');
      const buffer = Buffer.alloc(65537);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          size,
          buffer.length - size,
          size,
        );
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > 65536) throw usage('SQL file exceeds 65536 bytes.');
      sql = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, size),
      );
    } catch (error) {
      if (error.code === 'VALIDATION_ERROR') throw error;
      throw usage('Cannot read SQL file.');
    } finally {
      await handle?.close();
    }
  }
  if (sql !== undefined && (!sql.trim() || Buffer.byteLength(sql) > 65536))
    throw usage('SQL must contain 1 through 65536 bytes.');
  if (!flags.help && kind === 'query' && sql === undefined)
    throw usage('Provide exactly one of --sql or --file.');
  if (
    !flags.help &&
    (resources[resource]?.scope || ['query', 'query-status'].includes(kind)) &&
    !project
  )
    throw usage('Set --project or POSTHOG_PROJECT_ID.');
  if (
    !flags.help &&
    kind === 'setup-hooks' &&
    !flags['allow-codex-user-config']
  )
    throw usage(
      'Setup requires --allow-codex-user-config. It enables hooks in the Codex user config.toml.',
    );
  return {
    kind: flags.help ? 'help' : kind,
    topic: kind,
    command,
    resource,
    action,
    id,
    flags,
    host,
    project,
    limit,
    offset,
    fields,
    sql,
  };
}
