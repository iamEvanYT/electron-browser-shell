import { StorageArea, type StorageAdapter, type StorageItems } from './index'

/**
 * In-memory session storage. State is kept per-instance (not in a module-level
 * global) so that multiple Electron sessions/profiles loading the same
 * extension each get their own isolated data.
 */

interface SessionState {
  store: StorageItems
}

export type SessionStorageAccessLevel = 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS'

const TRUSTED_CONTEXTS: SessionStorageAccessLevel = 'TRUSTED_CONTEXTS'
const TRUSTED_AND_UNTRUSTED_CONTEXTS: SessionStorageAccessLevel = 'TRUSTED_AND_UNTRUSTED_CONTEXTS'

function createSessionStorageAdapter(state: SessionState): StorageAdapter {
  return async (task) => {
    switch (task.type) {
      case 'clear': {
        const cleared = { ...state.store }
        state.store = {}
        return cleared
      }

      case 'get': {
        if (task.keys === undefined) {
          return { ...state.store }
        }

        const result: StorageItems = {}
        for (const key of task.keys) {
          if (key in state.store) {
            result[key] = state.store[key]
          }
        }
        return result
      }

      case 'remove': {
        const removedValues: StorageItems = {}

        for (const key of task.keys) {
          if (!(key in state.store)) {
            continue
          }

          removedValues[key] = state.store[key]
          delete state.store[key]
        }

        return removedValues
      }

      case 'set': {
        const previousValues: StorageItems = {}

        for (const [key, value] of Object.entries(task.items)) {
          previousValues[key] = state.store[key]
          state.store[key] = value
        }

        return previousValues
      }
    }
  }
}

export class SessionStorageArea extends StorageArea {
  private state: SessionState = { store: {} }
  private accessLevel: SessionStorageAccessLevel = TRUSTED_CONTEXTS

  constructor() {
    // Create adapter with a temporary state, then replace after super()
    const state: SessionState = { store: {} }
    super(createSessionStorageAdapter(state))
    this.state = state
  }

  /** Clear in-memory state (called on extension unload). */
  resetCache() {
    this.state.store = {}
  }

  allowsUntrustedContexts() {
    return this.accessLevel === TRUSTED_AND_UNTRUSTED_CONTEXTS
  }

  async setAccessLevel(accessOptions: { accessLevel: chrome.storage.AccessLevel }) {
    const accessLevel = accessOptions?.accessLevel
    if (accessLevel !== TRUSTED_CONTEXTS && accessLevel !== TRUSTED_AND_UNTRUSTED_CONTEXTS) {
      throw new TypeError(`Invalid storage.session access level: ${String(accessLevel)}`)
    }

    this.accessLevel = accessLevel
  }
}
