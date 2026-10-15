import { runAxiCli, sessionStartHookStatus } from 'axi-sdk-js';
import { parseInvocation } from './arguments.js';
import {
  resources,
  decodeItem,
  decodePage,
  resourcePath,
} from './resources.js';
import { request, continuation } from './http.js';
import { decodeQuery } from './query.js';
import { CliError, invalidResponse } from './errors.js';
import { serialize, projectItem, quote } from './output.js';
import { commands, description, help } from './guidance.js';
import { VERSION } from './version.js';
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';

async function execute(invocation) {
  const { kind, resource, project, flags } = invocation;
  if (kind === 'home') {
    const configured = Boolean(process.env.POSTHOG_PERSONAL_API_KEY);
    const snapshot = configured
      ? await execute({
          ...invocation,
          kind: 'list',
          resource: project ? 'insights' : 'projects',
          limit: 3,
          offset: 0,
        })
      : null;
    const executable = resolve(process.argv[1]);
    const home = resolve(homedir());
    const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
    return {
      bin:
        executable === home
          ? '~'
          : executable.startsWith(homePrefix)
            ? `~${sep}${executable.slice(homePrefix.length)}`
            : executable,
      description,
      authentication: configured
        ? 'configured'
        : 'missing POSTHOG_PERSONAL_API_KEY',
      host: invocation.host,
      project: project ?? null,
      snapshot,
      commands: commands().filter((command) =>
        project
          ? command.startsWith('insights') || command.startsWith('query')
          : command.startsWith('projects'),
      ),
      next: `posthog-axi ${project ? 'insights' : 'projects'} list --host ${quote(invocation.host)}${project ? ` --project ${quote(project)}` : ''}`,
    };
  }
  if (kind === 'update')
    throw new CliError(
      'UPDATE_UNAVAILABLE',
      'This private local package cannot self-update. Reinstall from your trusted local checkout.',
    );
  if (kind === 'setup-hooks')
    throw new CliError(
      'HOOKS_DEFERRED',
      'SDK 0.1.13 does not safely quote executable paths in shell hooks. No files were written. Install the generated Agent Skill instead.',
    );
  if (kind === 'setup-status')
    return {
      installation: 'deferred',
      ...sessionStartHookStatus({
        marker: 'posthog-axi',
        scope: 'project',
        projectDir: resolve(flags['project-dir'] ?? '.'),
      }),
    };
  if (kind === 'list' || kind === 'view') {
    const spec = resources[resource];
    const path = resourcePath(spec, project);
    if (kind === 'view')
      return {
        resource,
        item: projectItem(
          decodeItem(
            spec,
            await request(invocation, `${path}${invocation.id}/`),
          ),
          invocation.fields ?? Object.keys(spec.fields),
          flags.full,
        ),
      };
    const params = new URLSearchParams({ limit: String(invocation.limit) });
    if (!spec.pagination) params.set('offset', String(invocation.offset));
    for (const name of spec.pagination ?? [])
      if (flags[name]) params.set(name, flags[name]);
    for (const [flag, name] of Object.entries(spec.filters ?? {}))
      if (flags[flag]) params.set(name, flags[flag]);
    const page = decodePage(
      spec,
      await request(invocation, `${path}?${params}`),
    );
    let next = continuation(
      page.next,
      invocation,
      path,
      page.items.length,
      spec,
    );
    if (page.items.length > invocation.limit) {
      if (
        resource === 'events' ||
        !Number.isSafeInteger(invocation.offset + invocation.limit)
      )
        throw invalidResponse();
      next = new URLSearchParams({
        offset: String(invocation.offset + invocation.limit),
      });
    }
    const items = page.items
      .slice(0, invocation.limit)
      .map((item) =>
        projectItem(item, invocation.fields ?? spec.defaults, flags.full),
      );
    let hint = null;
    if (next) {
      hint = `posthog-axi ${resource} list --host ${quote(invocation.host)}${project ? ` --project ${quote(project)}` : ''} --limit ${invocation.limit}`;
      for (const [name, value] of next) hint += ` --${name} ${quote(value)}`;
      for (const flag of Object.keys(spec.filters ?? {}))
        if (flags[flag]) hint += ` --${flag} ${quote(flags[flag])}`;
      if (invocation.fields)
        hint += ` --fields ${quote(invocation.fields.join(','))}`;
      if (flags.full) hint += ' --full';
      if (flags.json) hint += ' --json';
    }
    return {
      resource,
      items,
      returned: items.length,
      total: page.total,
      next: hint,
      message: items.length
        ? `Returned ${items.length} ${resource}.`
        : invocation.offset || flags.before || flags.after
          ? `No ${resource} on this page.`
          : `No ${resource} in this scope.`,
    };
  }
  const queryPath = `/api/projects/${project}/query/`;
  const data =
    kind === 'query'
      ? await request(invocation, queryPath, {
          query: { kind: 'HogQLQuery', query: invocation.sql },
          name: 'posthog-axi ad-hoc query',
          refresh: 'blocking',
        })
      : await request(invocation, `${queryPath}${invocation.id}/`);
  const outcome = decodeQuery(data, invocation);
  if (outcome.state === 'failed') process.exitCode = 1;
  return outcome;
}

export async function main() {
  let invocation;
  const handler = async () => serialize(await execute(invocation), invocation);
  // Normalize no-args home to avoid the SDK's additional non-JSON home header.
  const argv = process.argv.length === 2 ? ['home'] : process.argv.slice(2);
  await runAxiCli({
    description,
    version: VERSION,
    argv,
    initialize: async () => {
      invocation = await parseInvocation(argv, process.env);
    },
    topLevelHelp: help({ command: 'home' }),
    getCommandHelp: () => help(invocation),
    commands: Object.fromEntries(
      ['home', ...Object.keys(resources), 'query', 'setup', 'update'].map(
        (name) => [name, handler],
      ),
    ),
    home: handler,
    formatError: (error) => {
      const safe =
        error instanceof CliError
          ? {
              error: {
                code: error.code,
                message: error.message,
                ...error.details,
              },
            }
          : {
              error: {
                code: 'INTERNAL_ERROR',
                message: 'Operation failed. No dependency details are exposed.',
              },
            };
      return {
        output:
          serialize(safe, {
            flags: { json: process.argv.includes('--json'), full: true },
          }) + '\n',
        exitCode: error instanceof CliError ? error.exitCode : 1,
      };
    },
  });
}
