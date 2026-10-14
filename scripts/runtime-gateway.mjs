import { createRuntimeGateway } from '@dsh-workbench/runtime-gateway'

const port = Number(process.env.WORKBENCH_GATEWAY_PORT ?? 8765)
const gateway = createRuntimeGateway({
  registryPath: process.env.WORKBENCH_RUNTIME_REGISTRY,
  scopeSecret: process.env.WORKBENCH_SCOPE_COOKIE_SECRET,
  serviceSecret: process.env.WORKBENCH_GATEWAY_SERVICE_SECRET,
  maxScopeAgeMs: Number(process.env.WORKBENCH_SCOPE_MAX_AGE_MS ?? 8 * 60 * 60 * 1000),
})
gateway.server.listen(port, process.env.WORKBENCH_GATEWAY_HOST ?? '127.0.0.1', () => {
  console.log(`DSH scoped runtime gateway listening on ${process.env.WORKBENCH_GATEWAY_HOST ?? '127.0.0.1'}:${port}`)
})
