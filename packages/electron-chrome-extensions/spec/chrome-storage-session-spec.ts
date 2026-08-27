import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'

import { StorageAPI } from '../src/browser/api/storage'
import type { ExtensionEvent } from '../src/browser/router'
import { ElectronChromeExtensions } from '../'
import { addCrxPreload, createCrxSession } from './crx-helpers'
import { emittedOnce } from './events-helpers'
import { useExtensionBrowser, useServer } from './hooks'

type Handler = (event: ExtensionEvent, ...args: any[]) => any

class TestRouter {
  handlers = new Map<string, Handler>()

  apiHandler() {
    return (name: string, callback: Handler) => this.handlers.set(name, callback)
  }

  sendEvent() {}
}

const extension = (id: string) => ({
  id,
  manifest: { permissions: ['storage'] },
})

const extensionDocument = (id: string): ExtensionEvent => ({
  type: 'frame',
  sender: {} as Electron.WebContents,
  senderFrameUrl: `chrome-extension://${id}/options.html`,
  extension: extension(id) as any,
})

const contentScript = (id: string): ExtensionEvent => ({
  type: 'frame',
  sender: {} as Electron.WebContents,
  senderFrameUrl: 'https://example.test/',
  extension: extension(id) as any,
})

const serviceWorker = (id: string): ExtensionEvent => ({
  type: 'service-worker',
  sender: { scope: `chrome-extension://${id}/` } as Electron.ServiceWorkerMain,
  extension: extension(id) as any,
})

const invoke = async (router: TestRouter, name: string, event: ExtensionEvent, ...args: any[]) => {
  const handler = router.handlers.get(name)
  if (!handler) throw new Error(`Missing handler ${name}`)
  return await handler(event, ...args)
}

const createStorage = () => {
  const router = new TestRouter()
  const session = new EventEmitter() as any
  session.extensions = session
  new StorageAPI({ router, session } as any)
  return { router, session }
}

describe('chrome.storage.session access level', () => {
  const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  it('defaults to trusted contexts, grants every operation over the shared area, and reverts', async () => {
    const { router } = createStorage()
    const trusted = extensionDocument(extensionId)
    const untrusted = contentScript(extensionId)

    await invoke(router, 'storage.session.set', trusted, { token: 'one', count: 2 })
    await expect(invoke(router, 'storage.session.get', untrusted)).to.be.rejectedWith(
      'Access to storage is not allowed from this context.',
    )
    await expect(
      invoke(router, 'storage.session.setAccessLevel', untrusted, {
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      }),
    ).to.be.rejectedWith('Context cannot set the storage access level')

    await invoke(router, 'storage.session.setAccessLevel', trusted, {
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    })
    expect(await invoke(router, 'storage.session.get', untrusted, 'token')).to.deep.equal({
      token: 'one',
    })
    await invoke(router, 'storage.session.set', untrusted, { fromContent: true })
    expect(await invoke(router, 'storage.session.getKeys', untrusted)).to.have.members([
      'token',
      'count',
      'fromContent',
    ])
    expect(await invoke(router, 'storage.session.getBytesInUse', untrusted, 'token')).to.equal(10)
    expect(await invoke(router, 'storage.session.get', trusted, 'fromContent')).to.deep.equal({
      fromContent: true,
    })

    await invoke(router, 'storage.session.setAccessLevel', trusted, {
      accessLevel: 'TRUSTED_CONTEXTS',
    })
    await expect(invoke(router, 'storage.session.clear', untrusted)).to.be.rejectedWith(
      'Access to storage is not allowed from this context.',
    )
  })

  it('rejects invalid access levels without changing the existing grant', async () => {
    const { router } = createStorage()
    const trusted = extensionDocument(extensionId)
    const untrusted = contentScript(extensionId)

    await invoke(router, 'storage.session.setAccessLevel', trusted, {
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    })
    await expect(
      invoke(router, 'storage.session.setAccessLevel', trusted, { accessLevel: 'EVERYONE' }),
    ).to.be.rejectedWith('Invalid storage.session access level')
    expect(await invoke(router, 'storage.session.get', untrusted)).to.deep.equal({})
  })

  it('keeps grants and data scoped to an extension and Electron session', async () => {
    const first = createStorage()
    const second = createStorage()
    const otherId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    await invoke(first.router, 'storage.session.set', extensionDocument(extensionId), { value: 1 })
    await invoke(first.router, 'storage.session.setAccessLevel', extensionDocument(extensionId), {
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    })

    expect(
      await invoke(first.router, 'storage.session.get', contentScript(extensionId)),
    ).to.deep.equal({
      value: 1,
    })
    await expect(
      invoke(first.router, 'storage.session.get', contentScript(otherId)),
    ).to.be.rejectedWith('Access to storage is not allowed from this context.')
    expect(
      await invoke(first.router, 'storage.session.get', extensionDocument(otherId)),
    ).to.deep.equal({})
    await expect(
      invoke(second.router, 'storage.session.get', contentScript(extensionId)),
    ).to.be.rejectedWith('Access to storage is not allowed from this context.')
    expect(
      await invoke(second.router, 'storage.session.get', extensionDocument(extensionId)),
    ).to.deep.equal({})
  })

  it('accepts extension documents and service workers but rejects a mismatched extension frame', async () => {
    const { router } = createStorage()
    const trusted = extensionDocument(extensionId)

    await invoke(router, 'storage.session.set', trusted, { workerCanRead: true })
    expect(await invoke(router, 'storage.session.get', serviceWorker(extensionId))).to.deep.equal({
      workerCanRead: true,
    })

    await expect(
      invoke(router, 'storage.session.get', {
        ...serviceWorker(extensionId),
        sender: {
          scope: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/',
        } as Electron.ServiceWorkerMain,
      } as ExtensionEvent),
    ).to.be.rejectedWith('Access to storage is not allowed from this context.')

    const mismatchedFrame = {
      ...extensionDocument(extensionId),
      senderFrameUrl: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/options.html',
    }
    await expect(invoke(router, 'storage.session.get', mismatchedFrame)).to.be.rejectedWith(
      'Access to storage is not allowed from this context.',
    )
  })

  it('retains session data and its grant when the service-worker sender is replaced', async () => {
    const { router } = createStorage()
    const firstWorker = serviceWorker(extensionId)

    await invoke(router, 'storage.session.set', firstWorker, { workerLifetime: 'shared' })
    await invoke(router, 'storage.session.setAccessLevel', firstWorker, {
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    })

    const restartedWorker = serviceWorker(extensionId)
    expect(await invoke(router, 'storage.session.get', restartedWorker)).to.deep.equal({
      workerLifetime: 'shared',
    })
    expect(await invoke(router, 'storage.session.get', contentScript(extensionId))).to.deep.equal({
      workerLifetime: 'shared',
    })
  })

  it('clears access and data when the extension is unloaded', async () => {
    const { router, session } = createStorage()
    const trusted = extensionDocument(extensionId)
    const untrusted = contentScript(extensionId)

    await invoke(router, 'storage.session.set', trusted, { ephemeral: true })
    await invoke(router, 'storage.session.setAccessLevel', trusted, {
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    })
    session.emit('extension-unloaded', {}, extension(extensionId))

    await expect(invoke(router, 'storage.session.get', untrusted)).to.be.rejectedWith(
      'Access to storage is not allowed from this context.',
    )
    expect(await invoke(router, 'storage.session.get', trusted)).to.deep.equal({})
  })
})

describe('chrome.storage.session MV3 content script runtime access', () => {
  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'chrome-storage-session-mv3',
  })

  const postToContentScript = async (message: Record<string, any>) => {
    const result = emittedOnce(ipcMain, 'storage-session-result')
    await browser.webContents.executeJavaScript(
      `window.postMessage(${JSON.stringify({ type: 'storage-session-test', ...message })})`,
    )
    const [, payload] = await result
    return payload
  }

  const openExtensionDocument = async () => {
    const extensionDocument = new BrowserWindow({
      show: false,
      webPreferences: {
        session: browser.session,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    await extensionDocument.loadURL(`${browser.extension.url}extension-page.html`)
    return extensionDocument
  }

  const postToExtensionDocument = async (
    extensionDocument: BrowserWindow,
    message: Record<string, any>,
  ) => {
    const result = emittedOnce(ipcMain, 'storage-session-document-result')
    await extensionDocument.webContents.executeJavaScript(
      `window.postMessage(${JSON.stringify({ type: 'storage-session-document-test', ...message })})`,
    )
    const [, payload] = await result
    return payload
  }

  const requireIsolatedWorldInjection = async (test: Mocha.Context) => {
    const supportsInjection = await browser.webContents.executeJavaScript(
      'electronTest.supportsExtensionIsolatedWorldInjection',
    )
    if (!supportsInjection) test.skip()
  }

  const expectRuntimeError = (result: { error?: string }, expectedMessage: string) => {
    expect(result.error).to.include(expectedMessage)
  }

  it('does not expose the production extension IPC bridge in the normal page main world', async () => {
    expect(await browser.webContents.executeJavaScript('typeof globalThis.electron')).to.equal(
      'undefined',
    )
    expect(
      await browser.webContents.executeJavaScript('typeof globalThis.chrome?.storage?.session'),
    ).to.equal('undefined')
    // electronTest is a deliberately test-only preload bridge. It is never
    // present in the package's production preload.
    expect(await browser.webContents.executeJavaScript('typeof globalThis.electronTest')).to.equal(
      'object',
    )
  })

  it('denies content scripts by default, shares every operation after a trusted document grant, and reverts', async function () {
    await requireIsolatedWorldInjection(this)
    const extensionDocument = await openExtensionDocument()
    try {
      expectRuntimeError(
        await postToContentScript({ action: 'content-get' }),
        'Access to storage is not allowed from this context.',
      )
      expectRuntimeError(
        await postToContentScript({
          action: 'self-grant',
          accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
        }),
        'Context cannot set the storage access level',
      )

      expect(
        await postToExtensionDocument(extensionDocument, {
          action: 'set',
          items: { shared: 'value' },
        }),
      ).to.deep.equal({
        value: null,
      })
      expect(
        await postToExtensionDocument(extensionDocument, {
          action: 'setAccessLevel',
          accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
        }),
      ).to.deep.equal({ value: null })
      expect(await postToContentScript({ action: 'content-get', keys: 'shared' })).to.deep.equal({
        value: { shared: 'value' },
      })
      expect(await postToContentScript({ action: 'content-getKeys' })).to.deep.equal({
        value: ['shared'],
      })
      expect(
        await postToContentScript({ action: 'content-getBytesInUse', keys: 'shared' }),
      ).to.deep.equal({
        value: 13,
      })

      expect(
        await postToContentScript({ action: 'content-set', items: { fromContent: true } }),
      ).to.deep.equal({
        value: null,
      })
      expect(await postToContentScript({ action: 'get', keys: 'fromContent' })).to.deep.equal({
        value: { fromContent: true },
      })
      expect(
        await postToContentScript({ action: 'getBytesInUse', keys: 'fromContent' }),
      ).to.deep.equal({
        value: 15,
      })
      expect(await postToContentScript({ action: 'content-remove', keys: 'shared' })).to.deep.equal(
        {
          value: null,
        },
      )
      expect(await postToContentScript({ action: 'get', keys: 'shared' })).to.deep.equal({
        value: {},
      })
      expect(await postToContentScript({ action: 'content-clear' })).to.deep.equal({ value: null })
      expect(await postToContentScript({ action: 'get' })).to.deep.equal({ value: {} })

      expectRuntimeError(
        await postToExtensionDocument(extensionDocument, {
          action: 'setAccessLevel',
          accessLevel: 'INVALID',
        }),
        'Invalid storage.session access level: INVALID',
      )
      expectRuntimeError(
        await postToContentScript({ action: 'self-grant', accessLevel: 'TRUSTED_CONTEXTS' }),
        'Context cannot set the storage access level',
      )
      expect(
        await postToExtensionDocument(extensionDocument, {
          action: 'setAccessLevel',
          accessLevel: 'TRUSTED_CONTEXTS',
        }),
      ).to.deep.equal({ value: null })
      expectRuntimeError(
        await postToContentScript({ action: 'content-get' }),
        'Access to storage is not allowed from this context.',
      )
    } finally {
      extensionDocument.destroy()
    }
  })

  it('keeps a grant isolated from a second extension in the same Electron session', async function () {
    await requireIsolatedWorldInjection(this)
    const extensionDocument = await openExtensionDocument()
    try {
      await postToExtensionDocument(extensionDocument, {
        action: 'set',
        items: { primaryOnly: true },
      })
      await postToExtensionDocument(extensionDocument, {
        action: 'setAccessLevel',
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      })
      await browser.session.loadExtension(
        path.join(__dirname, 'fixtures', 'chrome-storage-session-mv3-other'),
      )
      await browser.webContents.loadURL(server.getUrl())

      expectRuntimeError(
        await postToContentScript({ extension: 'secondary', action: 'content-get' }),
        'Access to storage is not allowed from this context.',
      )
      expect(await postToContentScript({ extension: 'secondary', action: 'get' })).to.deep.equal({
        value: {},
      })
    } finally {
      extensionDocument.destroy()
    }
  })

  it('keeps a grant isolated from the same extension in another Electron session', async function () {
    await requireIsolatedWorldInjection(this)
    const extensionDocument = await openExtensionDocument()
    const secondSession = createCrxSession().session
    const secondWindow = new BrowserWindow({
      show: false,
      webPreferences: { session: secondSession, nodeIntegration: false, contextIsolation: true },
    })
    try {
      await postToExtensionDocument(extensionDocument, {
        action: 'set',
        items: { primaryOnly: true },
      })
      await postToExtensionDocument(extensionDocument, {
        action: 'setAccessLevel',
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      })
      addCrxPreload(secondSession)
      new ElectronChromeExtensions({
        license: 'internal-license-do-not-use' as any,
        session: secondSession,
      })
      await secondSession.loadExtension(
        path.join(__dirname, 'fixtures', 'chrome-storage-session-mv3'),
      )
      await secondWindow.loadURL(server.getUrl())

      const result = emittedOnce(ipcMain, 'storage-session-result')
      await secondWindow.webContents.executeJavaScript(
        `window.postMessage(${JSON.stringify({ type: 'storage-session-test', action: 'content-get' })})`,
      )
      const [, payload] = await result
      expectRuntimeError(payload, 'Access to storage is not allowed from this context.')
      const workerResult = emittedOnce(ipcMain, 'storage-session-result')
      await secondWindow.webContents.executeJavaScript(
        `window.postMessage(${JSON.stringify({ type: 'storage-session-test', action: 'get' })})`,
      )
      const [, workerPayload] = await workerResult
      expect(workerPayload).to.deep.equal({ value: {} })
    } finally {
      extensionDocument.destroy()
      secondWindow.destroy()
    }
  })

  it('resets session data and its grant after extension unload', async function () {
    await requireIsolatedWorldInjection(this)
    const extensionDocument = await openExtensionDocument()
    try {
      await postToExtensionDocument(extensionDocument, {
        action: 'set',
        items: { transient: true },
      })
      await postToExtensionDocument(extensionDocument, {
        action: 'setAccessLevel',
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      })
      await browser.session.removeExtension(browser.extension.id)
      const reloaded = await browser.session.loadExtension(
        path.join(__dirname, 'fixtures', 'chrome-storage-session-mv3'),
      )
      await extensionDocument.loadURL(`${reloaded.url}extension-page.html`)

      expect(await postToExtensionDocument(extensionDocument, { action: 'get' })).to.deep.equal({
        value: {},
      })
      await browser.webContents.loadURL(server.getUrl())
      expectRuntimeError(
        await postToContentScript({ action: 'content-get' }),
        'Access to storage is not allowed from this context.',
      )
    } finally {
      if (!extensionDocument.isDestroyed()) extensionDocument.destroy()
    }
  })
})
