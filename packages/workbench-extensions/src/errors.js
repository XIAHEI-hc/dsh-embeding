export const ERROR_DEFINITIONS = Object.freeze({
  WORKSPACE_NOT_FOUND: [404, false, 'select_workspace', '指定工作区已不存在'],
  WORKSPACE_DIRECTORY_MISSING: [409, true, 'recheck_workspace', '工作目录不存在或未挂载'],
  WORKSPACE_NOT_DIRECTORY: [422, false, 'select_directory', '所选路径不是目录'],
  WORKSPACE_READ_DENIED: [403, true, 'check_permissions', '无权读取工作目录'],
  WORKSPACE_READ_ONLY: [409, false, 'preview_only', '工作目录仅可读'],
  WORKSPACE_OUTSIDE_ALLOWED_ROOT: [403, false, 'contact_administrator', '此目录未开放给工作台'],
  WORKSPACE_IO_ERROR: [503, true, 'recheck_workspace', '无法检查工作目录'],
  WORKSPACE_SERVICE_UNAVAILABLE: [503, true, 'retry', '工作区服务尚未就绪'],
  SESSION_NOT_FOUND: [404, false, 'new_session', '会话不存在'],
  SESSION_WORKSPACE_MISMATCH: [409, false, 'select_session', '会话不属于指定工作区'],
  EMBED_ORIGIN_DENIED: [403, false, 'check_origin', '父页面来源未获许可'],
  EMBED_CLIENT_UNAUTHORIZED: [401, false, 'check_client_credentials', '嵌入客户端凭据无效'],
  EMBED_SCOPE_DENIED: [403, false, 'check_scope', '请求超出嵌入客户端授权范围'],
  EMBED_TICKET_EXPIRED: [401, true, 'request_ticket', '登录授权已过期'],
  EMBED_TICKET_REPLAYED: [409, false, 'request_ticket', '登录授权已使用'],
  EMBED_TICKET_REVOKED: [401, false, 'request_ticket', '登录授权已撤销'],
  EMBED_AUTH_UNAVAILABLE: [503, true, 'retry', '工作台登录服务暂不可用'],
  EMBED_PROTOCOL_UNSUPPORTED: [400, false, 'upgrade_integration', '嵌入协议版本不受支持'],
  EMBED_CROSS_SITE_UNSUPPORTED: [422, false, 'use_same_site', '当前版本仅支持同站点嵌入'],
  CONFIG_INVALID: [500, false, 'fix_configuration', '工作台嵌入配置无效'],
})

export class WorkbenchExtensionError extends Error {
  constructor(code, options = {}) {
    const definition = ERROR_DEFINITIONS[code]
    if (definition === undefined) throw new TypeError(`unknown extension error code ${code}`)
    super(options.message ?? definition[3], options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'WorkbenchExtensionError'
    this.code = code
    this.status = definition[0]
    this.retryable = definition[1]
    this.action = definition[2]
  }

  envelope(requestId) {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        request_id: requestId,
        action: this.action,
      },
    }
  }
}

export function extensionError(error) {
  return error instanceof WorkbenchExtensionError
    ? error
    : new WorkbenchExtensionError('WORKSPACE_IO_ERROR', { cause: error })
}
