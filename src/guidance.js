import { resources } from './resources.js';
import { allowedFlags } from './arguments.js';
import { VERSION } from './version.js';

export const description =
  'Manage PostHog analytics, dashboards and feature flags for agents.';
export const policies = [
  'Authenticate only with POSTHOG_PERSONAL_API_KEY. Never put credentials in argv or files.',
  'Use --host or POSTHOG_HOST and --project or POSTHOG_PROJECT_ID. The default host is https://us.posthog.com.',
  'Lists default to 25 items. --limit accepts 1 through 100. Counts distinguish returned items from total, which can be null.',
  'TOON is the default output. --json emits JSON. --fields selects safe fields. --full disables content previews, never redaction or row limits.',
  'Query --sql and --file are exclusive. SQL is not rewritten. Use a SQL LIMIT and time range to bound computation. No bulk export or query OFFSET pagination is supported.',
  'Pending queries include a scoped query status command. Failed queries exit 1. Usage errors exit 2. Errors are structured on stdout.',
  'Pagination hints preserve host, project, fields, and output flags. Do not follow raw API next URLs.',
  'Known secret keys and the configured credential are redacted. Arbitrary secrets in analytics business data cannot be detected.',
  'Hook installation is deferred because SDK 0.1.13 does not safely quote executable paths in shell hooks. Use the generated Agent Skill instead.',
  'Complete queries report received response rows and returned display rows, not totals. Complete describes finished execution, not exhaustive results. backend_has_more is the upstream hasMore boolean or null when absent or null. truncated is true if display rows were capped or backend_has_more is true. False truncated with null backend_has_more does not prove backend completeness. These fields apply to synchronous and completed asynchronous results. --full never removes row limits. Narrow SQL and the time range when the backend reports more rows.',
];
export function commands() {
  return [
    'home',
    ...Object.entries(resources).flatMap(([name, spec]) => [
      `${name} list`,
      `${name} view <id>`,
      ...Object.keys(spec.mutations ?? {}).map(
        (verb) => `${name} ${verb}${verb === 'create' ? '' : ' <id>'}`,
      ),
    ]),
    'query --sql <sql> | --file <path>',
    'query status <id>',
    'setup hooks --project-dir <path> --allow-codex-user-config',
    'setup status --project-dir <path>',
  ];
}
export function help(invocation) {
  if (invocation.command === 'home')
    return `posthog-axi - ${description}\nCommands:\n${commands()
      .map((command) => `  ${command}`)
      .join(
        '\n',
      )}\nFlags follow the command. Use <command> --help for scoped help.\n${policies.slice(0, 2).join('\n')}\n`;
  const topic = invocation.topic;
  const spec = resources[invocation.resource];
  if (topic === 'mutation') {
    const operation = spec.mutations[invocation.action];
    const target = `<project>/${invocation.resource}/${invocation.action === 'create' ? 'key:<key>' : '<id>'}`;
    return (
      [
        `posthog-axi ${invocation.resource} ${invocation.action}${invocation.action === 'create' ? '' : ' <id>'}`,
        `Flags: ${allowedFlags(topic, invocation.resource, invocation.action)
          .map((flag) => `--${flag}`)
          .join(' ')}`,
        ...Object.entries(operation.inputs).map(
          ([flag, input]) =>
            `--${flag} <value>: ${input.guidance}${operation.required?.includes(flag) ? ' Required.' : ''}`,
        ),
        ...(operation.confirmations ?? []).map(
          (guard) =>
            `--${guard.flag} '${target}': target-bound impact acknowledgment when the corresponding change is requested.`,
        ),
        operation.guidance,
        ...(operation.defaults
          ? [`Creation defaults: ${JSON.stringify(operation.defaults)}`]
          : []),
        `Permission: ${operation.permission}. Updates and lifecycle actions also read current state and require read access.`,
        'Use --project or POSTHOG_PROJECT_ID and --host or POSTHOG_HOST. Default host is https://us.posthog.com.',
        'Structured files are UTF-8 JSON regular files of at most 65536 bytes, 20 levels and 10000 values. The server validates complete query and targeting semantics.',
        '--dry-run validates and previews locally without credentials or requests. Remote permissions, state, version and approval rules remain unchecked. Confirmations are still required.',
        'Omitted inputs remain unchanged. An empty update is rejected. Empty descriptions clear them.',
        'Never retry a write automatically. Uncertain outcomes require inspection before retrying. Creation is not guaranteed idempotent.',
        'Obtain operator approval before destructive actions. A confirmation flag does not substitute for operator approval.',
        'Example: append --dry-run --project <project> to preview a fully specified command.',
        `Example: posthog-axi ${invocation.resource} ${invocation.action} --help`,
        '--json emits structured JSON; TOON is the default. Credentials come only from POSTHOG_PERSONAL_API_KEY.',
      ].join('\n') + '\n'
    );
  }
  return (
    [
      `posthog-axi ${invocation.command}${invocation.action ? ` ${invocation.action}` : ''}${['view', 'query-status'].includes(topic) ? ' <id>' : ''}`,
      `Flags: ${allowedFlags(topic, invocation.resource)
        .map((flag) => `--${flag}`)
        .join(' ')}`,
      ...(spec
        ? [
            `Safe fields: ${Object.keys(spec.fields).join(',')}`,
            `Default list fields: ${spec.defaults.join(',')}`,
            'View defaults to all safe fields.',
            spec.idGuidance ??
              (invocation.resource === 'events'
                ? 'Event IDs must be UUIDs. Pagination uses --before and --after timestamps, never --offset.'
                : 'IDs must be positive integers. Lists paginate with --offset.'),
          ]
        : []),
      ...(topic === 'query'
        ? [
            policies[4],
            policies[9],
            'Use query status <id> for pending results.',
          ]
        : []),
      ...(topic === 'query-status'
        ? [
            'Pending status includes the next polling command. Complete status includes bounded rows. Failed status exits 1.',
            policies[9],
          ]
        : []),
      ...(topic === 'update'
        ? [
            'Automatic self-update is disabled. Install a reviewed GitHub release explicitly. This package is not published to npm.',
          ]
        : []),
      ...(topic.startsWith('setup')
        ? [
            policies[8],
            'The acknowledgment allows the SDK to enable [features].hooks in your user-level Codex config.toml, even for project setup.',
            'Status is read-only. Installation currently exits 1 without writing files.',
          ]
        : []),
      ...(['list', 'query', 'query-status'].includes(topic)
        ? [
            '--limit <integer> defaults to 25, range 1 through 100. --full does not remove this limit.',
          ]
        : []),
      ...(spec || topic.startsWith('query')
        ? [
            'Response timeout is 10000ms. Response cap is 2097152 bytes. Output cap is 524288 bytes.',
          ]
        : []),
      'Use POSTHOG_PERSONAL_API_KEY for authentication. --json selects JSON; default output is TOON.',
      ...(spec?.scope || topic.startsWith('query')
        ? [
            '--project <positive integer> or POSTHOG_PROJECT_ID is required. --host <origin> overrides POSTHOG_HOST.',
          ]
        : []),
      ...(spec
        ? [
            topic === 'view'
              ? `Examples: posthog-axi ${invocation.resource} view ${invocation.resource === 'events' ? '018f1111-2222-4333-8444-555555555555' : '7'} --project 42 --full`
              : `Examples: posthog-axi ${invocation.resource} list --project 42 --limit 10`,
            `  posthog-axi ${invocation.resource} ${topic === 'view' ? `view ${invocation.resource === 'events' ? '018f1111-2222-4333-8444-555555555555' : '7'}` : 'list'} --project 42 --fields id --json`,
          ]
        : []),
      ...(topic === 'query'
        ? [
            "Examples: posthog-axi query --project 42 --sql 'SELECT 1'",
            '  posthog-axi query --project 42 --file ./query.sql --json',
          ]
        : []),
      ...(topic === 'query-status'
        ? ['Example: posthog-axi query status query-id --project 42 --json']
        : []),
    ].join('\n') + '\n'
  );
}
export function skillText() {
  const run = `npm exec --yes --package='git+https://github.com/ohigs/posthog-axi.git#v${VERSION}' -- posthog-axi`;
  return `---\nname: posthog-axi\ndescription: Manage PostHog insights, dashboards and feature flags, read events and projects, and run HogQL queries with the posthog-axi CLI.\n---\n\n# PostHog AXI\n\nGenerated by scripts/generate-skill.js.\nDo not edit this file manually.\n\nThis community-maintained CLI is not endorsed by PostHog and has no official AXI status.\nRun commands through the pinned GitHub package with npm exec.\nNo globally installed binary is required.\nNode.js 20 or newer, npm, Git, and network access on first installation are required.\nNever fetch posthog-axi from the npm registry.\nAutomatic self-update is disabled.\nRun \`${run}\` to inspect current authentication and project scope.\nUse scoped --help before calling a command.\nUse the same npm exec prefix for every command, including help, pagination, and status hints that display a bare posthog-axi command.\nSet POSTHOG_PROJECT_ID or --project explicitly.\nA scoped personal key can allow project API access while the global projects list returns HTTP 403.\n\n## Commands\n\n${commands()
    .map((command) => `- \`${run} ${command}\``)
    .join(
      '\n',
    )}\n\n## Safety and output\n\n${[...policies, 'Create and update use scalar flags and named query or targeting files. Use scoped --help for supported inputs and exact permission scopes. Creation is not guaranteed idempotent; writes are never retried automatically.', 'Use --dry-run for local credential-free previews. It does not check remote permissions, state, version or policy. Target-bound confirmations remain required.', 'Obtain operator approval before destructive changes. Archive confirmations bind project, resource and ID. Query replacement and membership replacement require their impact confirmations. Flag targeting and activation require their own confirmations, including inactive creation with supplied targeting.', 'Insight archives remove subscriptions and linked alerts and hide tiles. Query changes can also remove alerts. Dashboard archives preserve insights but hide tiles and clear home/primary references. These are not fully reversible operations.', 'Manage dashboard membership through insights --dashboards using the deprecated upstream dashboards field. none clears membership. A missing archived insight or dashboard is not proof of an already-completed archive.', 'Inspect before retrying an uncertain write. Honor server approval and version conflicts and never bypass them through another endpoint.'].join('\n').replaceAll('. ', '.\n')}\n\n## Safe resource fields\n\n${Object.entries(
    resources,
  )
    .map(
      ([name, spec]) =>
        `- ${name} accepts ${Object.keys(spec.fields)
          .map((field) => `\`${field}\``)
          .join(', ')}.`,
    )
    .join('\n')}\n`;
}
