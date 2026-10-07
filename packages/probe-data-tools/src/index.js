import { defineTool } from '@deepseek-ai/dsh-tools'
import { ProbeToolClient } from './client.js'

export const name = 'probe-data-tools'
export const inject = ['tools']

const COMMON_PARAMETERS = {
  limit: { type: 'integer', description: 'Maximum rows to return, from 1 to 100.' },
  offset: { type: 'integer', description: 'Zero-based row offset.' },
}

const TOOLS = Object.freeze([
  ['get_project_overview', 'Read the current EzProber project overview and authorized object counts.', {}],
  ['get_wafer_summary', 'Read wafer summaries in the bound EzProber project.', {
    wafer_id: { type: 'integer', description: 'Optional wafer identifier.' }, ...COMMON_PARAMETERS,
  }],
  ['get_probecard_summary', 'Read probe-card summaries in the bound EzProber project.', {
    probecard_id: { type: 'string', description: 'Optional probe-card UUID.' }, ...COMMON_PARAMETERS,
  }],
  ['get_testing_rules', 'Read testing rules in the bound EzProber project.', {
    rule_id: { type: 'integer', description: 'Optional testing-rule identifier.' }, ...COMMON_PARAMETERS,
  }],
  ['get_site_layout_tasks', 'Read Site layout task status and factual counters for the bound Site project.', {
    task_id: { type: 'string', description: 'Optional Site layout task identifier.' }, ...COMMON_PARAMETERS,
  }],
  ['get_site_layout_candidates', 'Read Site layout candidate summaries for the bound Site project.', {
    task_id: { type: 'string', description: 'Optional owning task identifier.' },
    candidate_id: { type: 'string', description: 'Optional candidate identifier.' }, ...COMMON_PARAMETERS,
  }],
  ['get_site_layout_results', 'Read Site layout result summaries for the bound Site project.', {
    task_id: { type: 'string', description: 'Optional owning task identifier.' },
    result_id: { type: 'integer', description: 'Optional result identifier.' }, ...COMMON_PARAMETERS,
  }],
  ['get_probing_results', 'Read probing result metrics for the bound Probecard project.', {
    result_id: { type: 'integer', description: 'Optional probing result identifier.' }, ...COMMON_PARAMETERS,
  }],
  ['get_export_metadata', 'Read export metadata without returning storage paths or file contents.', {
    export_id: { type: 'string', description: 'Optional export artifact identifier.' }, ...COMMON_PARAMETERS,
  }],
])

function definition(client, [toolName, description, parameters]) {
  return defineTool({
    name: toolName,
    description: `${description} Scope comes only from the server-bound DSH session; never request another project or raw SQL.`,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          response_json: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.response_json }],
    },
    async execute(args, exec) {
      const value = await client.query(toolName, args, exec)
      return { response_json: JSON.stringify(value, null, 2) }
    },
    presentCall: args => ({
      card: 'generic',
      title: `EzProber: ${toolName}`,
      kind: 'other',
      rawInput: args,
    }),
  })
}

export function apply(ctx) {
  if (!['true', '1'].includes(process.env.PROBE_AI_INTEGRATION_ENABLED ?? '')) return
  const client = new ProbeToolClient()
  for (const item of TOOLS) ctx.tools.register(definition(client, item))
  ctx.effect(() => () => client.close(), 'probe-data-tools lifecycle')
}
