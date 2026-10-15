import { resources } from './resources.js';
import { allowedFlags } from './arguments.js';

export const description = 'Read-only PostHog analytics for agents.';
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
    ...Object.keys(resources).flatMap((name) => [
      `${name} list`,
      `${name} view <id>`,
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
            invocation.resource === 'events'
              ? 'Event IDs must be UUIDs. Pagination uses --before and --after timestamps, never --offset.'
              : 'IDs must be positive integers. Lists paginate with --offset.',
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
            'Self-update is disabled for this private local package. Reinstall from your trusted local checkout.',
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
  return `---\nname: posthog-axi\ndescription: Read PostHog projects, insights, dashboards, flags, events, and HogQL query results with the posthog-axi CLI.\n---\n\n# PostHog AXI\n\nGenerated by scripts/generate-skill.js.\nDo not edit this file manually.\n\nInstall from your trusted local checkout with npm install -g /path/to/posthog-axi or npm link before using this skill.\nThis private release is not available from the npm registry.\nRun posthog-axi to inspect current authentication and project scope.\nUse scoped --help before calling a command.\n\n## Commands\n\n${commands()
    .map((command) => `- \`posthog-axi ${command}\``)
    .join(
      '\n',
    )}\n\n## Safety and output\n\n${policies.join('\n').replaceAll('. ', '.\n')}\n\n## Safe resource fields\n\n${Object.entries(
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
