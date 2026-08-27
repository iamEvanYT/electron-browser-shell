import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { injectBrowserAction } from '../../src/browser-action'

// This should go without saying, but you should never do this in a production
// app. These bindings are purely for testing convenience.
const apiName = 'electronTest'
const api = {
  sendIpc(channel: string, ...args: any[]) {
    return ipcRenderer.send(channel, ...args)
  },
  invokeIpc(channel: string, ...args: any[]) {
    return ipcRenderer.invoke(channel, ...args)
  },
  supportsExtensionIsolatedWorldInjection:
    !!webFrame && 'getIsolatedWorlds' in webFrame && 'executeJavaScriptInIsolatedWorld' in webFrame,
}

window.addEventListener('message', (event) => {
  const report = event.data
  if (event.source !== window || report?.type !== 'crx-test-result') return
  ipcRenderer.send(report.channel, report.payload)
})

try {
  contextBridge.exposeInMainWorld(apiName, api)
} catch {
  window[apiName] = api
}

// Inject in all test pages.
injectBrowserAction()
