import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { registerStorageAreaHandlers } from './lib/storage-area'
import { SessionStorageArea } from './lib/storage-area/session'

/**
 * Main-process implementation of chrome.storage.session and chrome.storage.local.
 *
 * Both storage areas are backed by the main process so that:
 * - Data is shared between all extension contexts (background, content scripts, popup)
 * - onChanged events are reliably broadcast to all contexts including MV3 service workers
 *
 * chrome.storage.session: in-memory, cleared when the extension is unloaded or the browser quits
 * chrome.storage.local: persisted to disk as JSON, survives browser restarts
 */
export class StorageAPI {
  private sessionAreas = new Map<string, SessionStorageArea>()

  constructor(private ctx: ExtensionContext) {
    registerStorageAreaHandlers('session', this.ctx.router, this.getSessionArea, {
      canAccess: (event, area) =>
        this.isTrustedSessionContext(event) ||
        (area as SessionStorageArea).allowsUntrustedContexts(),
      canSetAccessLevel: (event) => this.isTrustedSessionContext(event),
    })

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      const sessionArea = this.sessionAreas.get(extension.id)
      if (sessionArea) {
        sessionArea.resetCache()
        this.sessionAreas.delete(extension.id)
      }
    })
  }

  private getSessionArea = ({ extension }: ExtensionEvent) => {
    let area = this.sessionAreas.get(extension.id)
    if (!area) {
      area = new SessionStorageArea()
      this.sessionAreas.set(extension.id, area)
    }
    return area
  }

  /**
   * Chrome's trusted storage.session contexts are extension documents and
   * extension service workers. Content scripts execute in a page frame, even
   * though their chrome.runtime.id identifies an extension, so that ID must
   * never be used as the authorization proof.
   *
   * The access level deliberately shares SessionStorageArea's in-memory
   * lifetime. Chrome has an internal preferences layer with longer-lived
   * policy, but this package has no equivalent safe owner; grants therefore
   * reset on extension unload and Electron session/browser teardown.
   */
  private isTrustedSessionContext(event: ExtensionEvent) {
    if (event.type === 'service-worker') {
      return event.sender.scope?.startsWith(`chrome-extension://${event.extension.id}/`) === true
    }

    return event.senderFrameUrl?.startsWith(`chrome-extension://${event.extension.id}/`) === true
  }
}
