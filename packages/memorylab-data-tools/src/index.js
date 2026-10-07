import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryLabToolClient } from './client.js'

export const name = 'memorylab-data-tools'
export const inject = ['tools']

const TOOLS = Object.freeze([
  ['memorylab_list_datasets', 'List CHN analysis datasets visible to the bound Memory Lab user.', {
    limit: { type: 'integer', description: 'Maximum datasets to return, from 1 to 100.' },
  }],
  ['memorylab_get_import_job', 'Read the current state and error details of a Memory Lab CSV import job.', {
    job_id: { type: 'string', description: 'Import job UUID.', required: true },
  }],
  ['memorylab_get_dataset', 'Read schema, row counts, filter fields, and source facts for a Memory Lab CHN dataset.', {
    dataset_id: { type: 'string', description: 'Dataset UUID.', required: true },
  }],
  ['memorylab_analyze_dataset', 'Compute a factual CHN overview for a Memory Lab dataset using its production analysis backend.', {
    dataset_id: { type: 'string', description: 'Dataset UUID.', required: true },
    filters: {
      type: 'object',
      additionalProperties: true,
      description: 'Optional exact-value filters accepted by the CHN analysis API.',
    },
  }],
  ['memorylab_open_analysis', 'Return the exact Memory Lab analysis page for a completed dataset. Present its URL as a clickable link.', {
    dataset_id: { type: 'string', description: 'Completed dataset UUID.', required: true },
  }],
])

function definition(client, [toolName, description, parameters]) {
  return defineTool({
    name: toolName,
    description: `${description} Identity and data scope come only from the server-bound DSH session.`,
    parameters,
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { response_json: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.response_json }],
    },
    async execute(args, exec) {
      const value = toolName === 'memorylab_open_analysis'
        ? await client.query(toolName, { ...args, analysis_url: client.analysisUrl(args.dataset_id) }, exec)
        : await client.query(toolName, args, exec)
      return { response_json: JSON.stringify(value, null, 2) }
    },
    presentCall: args => ({ card: 'generic', title: `Memory Lab: ${toolName}`, kind: 'other', rawInput: args }),
  })
}

function uploadDefinition(client) {
  return defineTool({
    name: 'memorylab_upload_chn_csv',
    description: 'Upload one CSV attached to this DSH conversation into the real Memory Lab CHN import pipeline. Use the read-only attachment path shown in the user message; do not copy or rewrite the file first.',
    parameters: {
      file_path: { type: 'string', description: 'Absolute read-only process path of the attached CSV.', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { response_json: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.response_json }],
    },
    async execute(args, exec) {
      return { response_json: JSON.stringify(await client.upload(args.file_path, exec), null, 2) }
    },
    presentCall: args => ({ card: 'generic', title: 'Memory Lab: upload CHN CSV', kind: 'other', rawInput: args }),
  })
}

export function apply(ctx) {
  if (!['true', '1'].includes(process.env.MEMORYLAB_AI_INTEGRATION_ENABLED ?? '')) return
  const client = new MemoryLabToolClient()
  ctx.tools.register(uploadDefinition(client))
  for (const item of TOOLS) ctx.tools.register(definition(client, item))
  ctx.effect(() => () => client.close(), 'memorylab-data-tools lifecycle')
}
