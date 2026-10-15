import { WorkbenchExtensionError } from './errors.js'

const PAGE_KINDS = Object.freeze(['failure_map', 'chn_vis'])
const DISPLAY_MODES = Object.freeze(['compact_chat'])

function invalid(message) {
  throw new WorkbenchExtensionError('EMBED_PROTOCOL_UNSUPPORTED', { message })
}

function requiredString(value, label, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    invalid(`${label} 不合法`)
  }
  return value
}

/**
 * Normalize the server-authorized page surface carried by integration/prepare.
 * The browser never gets to choose this object directly: callers must already
 * have passed the server-client bearer check before invoking this function.
 */
export function normalizePageSurface(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('page_surface 必须是对象')
  }
  const allowed = new Set(['surface_id', 'conversation_slot', 'page_kind', 'dataset_id', 'display_mode'])
  if (Object.keys(value).some(key => !allowed.has(key))
    || Object.keys(value).length !== allowed.size) {
    invalid('page_surface 字段不完整或包含未知字段')
  }
  const pageKind = requiredString(value.page_kind, 'page_surface.page_kind', 64)
  if (!PAGE_KINDS.includes(pageKind)) invalid('page_surface.page_kind 不支持')
  const displayMode = requiredString(value.display_mode, 'page_surface.display_mode', 64)
  if (!DISPLAY_MODES.includes(displayMode)) invalid('page_surface.display_mode 不支持')
  return Object.freeze({
    surface_id: requiredString(value.surface_id, 'page_surface.surface_id'),
    conversation_slot: requiredString(value.conversation_slot, 'page_surface.conversation_slot'),
    page_kind: pageKind,
    dataset_id: requiredString(value.dataset_id, 'page_surface.dataset_id'),
    display_mode: displayMode,
  })
}

export function pageSurfaceColumns(surface) {
  if (surface === undefined) return {
    pageSurfaceId: undefined,
    conversationSlot: undefined,
    pageKind: undefined,
    datasetId: undefined,
    displayMode: undefined,
  }
  return {
    pageSurfaceId: surface.surface_id,
    conversationSlot: surface.conversation_slot,
    pageKind: surface.page_kind,
    datasetId: surface.dataset_id,
    displayMode: surface.display_mode,
  }
}

export function pageSurfaceResponse(surface) {
  return surface === undefined ? {} : {
    surface_id: surface.surface_id,
    conversation_slot: surface.conversation_slot,
    surface_kind: 'page_assistant',
    page_kind: surface.page_kind,
    dataset_id: surface.dataset_id,
    display_mode: surface.display_mode,
  }
}

export function pageSurfaceFromBinding(binding) {
  if (binding.pageSurfaceId === undefined) return undefined
  return {
    surface_id: binding.pageSurfaceId,
    conversation_slot: binding.conversationSlot,
    page_kind: binding.pageKind,
    dataset_id: binding.datasetId,
    display_mode: binding.displayMode,
  }
}

