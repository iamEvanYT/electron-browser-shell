import * as fs from 'node:fs'
import * as path from 'node:path'
import debug from 'debug'
import { app, BrowserWindow, ipcMain, nativeImage, NativeImage } from 'electron'
import { fetch } from './utils'

import {
  ExtensionInstallStatus,
  MV2DeprecationStatus,
  Result,
  WebGlStatus,
} from '../common/constants'
import { installExtension, uninstallExtension } from './installer'
import { ExtensionId, WebStoreState } from './types'

const d = debug('electron-chrome-web-store:api')

const WEBSTORE_URL = 'https://chromewebstore.google.com'

function getExtensionInfo(ext: Electron.Extension) {
  const manifest: chrome.runtime.Manifest = ext.manifest
  return {
    description: manifest.description || '',
    enabled: !manifest.disabled,
    homepageUrl: manifest.homepage_url || '',
    hostPermissions: manifest.host_permissions || [],
    icons: Object.entries(manifest?.icons || {}).map(([size, url]) => ({
      size: parseInt(size),
      url: `chrome://extension-icon/${ext.id}/${size}/0`,
    })),
    id: ext.id,
    installType: 'normal',
    isApp: !!manifest.app,
    mayDisable: true,
    name: manifest.name,
    offlineEnabled: !!manifest.offline_enabled,
    optionsUrl: manifest.options_page
      ? `chrome-extension://${ext.id}/${manifest.options_page}`
      : '',
    permissions: manifest.permissions || [],
    shortName: manifest.short_name || manifest.name,
    type: manifest.app ? 'app' : 'extension',
    updateUrl: manifest.update_url || '',
    version: manifest.version,
  }
}

function getExtensionInstallStatus(
  state: WebStoreState,
  extensionId: ExtensionId,
  manifest?: chrome.runtime.Manifest,
) {
  const customStatus: unknown = state.overrideExtensionInstallStatus?.(state, extensionId, manifest)
  if (typeof customStatus === 'string') {
    return customStatus
  }

  if (manifest && manifest.manifest_version < state.minimumManifestVersion) {
    return ExtensionInstallStatus.DEPRECATED_MANIFEST_VERSION
  }

  if (state.denylist?.has(extensionId)) {
    return ExtensionInstallStatus.BLOCKED_BY_POLICY
  }

  if (state.allowlist && !state.allowlist.has(extensionId)) {
    return ExtensionInstallStatus.BLOCKED_BY_POLICY
  }

  const extensions = state.session.getAllExtensions()
  const extension = extensions.find((ext) => ext.id === extensionId)

  if (!extension) {
    return ExtensionInstallStatus.INSTALLABLE
  }

  if (extension.manifest.disabled) {
    return ExtensionInstallStatus.DISABLED
  }

  return ExtensionInstallStatus.ENABLED
}

interface InstallDetails {
  id: string
  manifest: string
  localizedName: string
  esbAllowlist: boolean
  iconUrl: string
}

async function beginInstall(
  { sender, senderFrame }: Electron.IpcMainInvokeEvent,
  state: WebStoreState,
  details: InstallDetails,
) {
  const extensionId = details.id

  try {
    if (state.installing.has(extensionId)) {
      return { result: Result.INSTALL_IN_PROGRESS }
    }

    let manifest: chrome.runtime.Manifest
    try {
      manifest = JSON.parse(details.manifest)
    } catch {
      return { result: Result.MANIFEST_ERROR }
    }

    const installStatus = getExtensionInstallStatus(state, extensionId, manifest)
    switch (installStatus) {
      case ExtensionInstallStatus.INSTALLABLE:
        break // good to go
      case ExtensionInstallStatus.BLOCKED_BY_POLICY:
        return { result: Result.BLOCKED_BY_POLICY }
      default: {
        d('unable to install extension %s with status "%s"', extensionId, installStatus)
        return { result: Result.UNKNOWN_ERROR }
      }
    }

    let iconUrl: URL
    try {
      iconUrl = new URL(details.iconUrl)
    } catch {
      return { result: Result.INVALID_ICON_URL }
    }

    let icon: NativeImage
    try {
      const response = await fetch(iconUrl.href)
      const imageBuffer = Buffer.from(await response.arrayBuffer())
      icon = nativeImage.createFromBuffer(imageBuffer)
    } catch {
      return { result: Result.ICON_ERROR }
    }

    const browserWindow = BrowserWindow.fromWebContents(sender)
    if (!senderFrame || senderFrame.isDestroyed()) {
      return { result: Result.UNKNOWN_ERROR }
    }

    if (state.beforeInstall) {
      const result: unknown = await state.beforeInstall({
        id: extensionId,
        localizedName: details.localizedName,
        manifest,
        icon,
        frame: senderFrame,
        browserWindow: browserWindow || undefined,
      })

      if (typeof result !== 'object' || typeof (result as any).action !== 'string') {
        return { result: Result.UNKNOWN_ERROR }
      } else if ((result as any).action !== 'allow') {
        return { result: Result.USER_CANCELLED }
      }
    }

    state.installing.add(extensionId)
    await installExtension(extensionId, state)

    if (state.afterInstall) {
      // Doesn't need to await, just a callback
      state.afterInstall({
        id: extensionId,
        localizedName: details.localizedName,
        manifest,
        icon,
        frame: senderFrame,
        browserWindow: browserWindow || undefined,
      })
    }

    return { result: Result.SUCCESS }
  } catch (error) {
    console.error('Extension installation failed:', error)
    return {
      result: Result.INSTALL_ERROR,
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    state.installing.delete(extensionId)
  }
}

export function registerWebStoreApi(webStoreState: WebStoreState) {
  /** Handle IPCs from the Chrome Web Store. */
  const handle = (
    channel: string,
    handle: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any,
  ) => {
    ipcMain.handle(channel, async function handleWebStoreIpc(event, ...args) {
      d('received %s', channel)

      const senderOrigin = event.senderFrame?.origin
      if (!senderOrigin || !senderOrigin.startsWith(WEBSTORE_URL)) {
        d('ignoring webstore request from %s', senderOrigin)
        return
      }

      const result = await handle(event, ...args)
      d('%s result', channel, result)
      return result
    })
  }

  handle('chromeWebstore.beginInstall', async (event, details: InstallDetails) => {
    const { senderFrame } = event

    d('beginInstall', details)

    const result = await beginInstall(event, webStoreState, details)

    if (result.result === Result.SUCCESS) {
      queueMicrotask(() => {
        const ext = webStoreState.session.getExtension(details.id)
        if (ext && senderFrame && !senderFrame.isDestroyed()) {
          try {
            senderFrame.send('chrome.management.onInstalled', getExtensionInfo(ext))
          } catch (error) {
            console.error(error)
          }
        }
      })
    }

    return result
  })

  handle('chromeWebstore.completeInstall', async (event, id) => {
    // TODO: Implement completion of extension installation
    return Result.SUCCESS
  })

  handle('chromeWebstore.enableAppLauncher', async (event, enable) => {
    // TODO: Implement app launcher enable/disable
    return true
  })

  handle('chromeWebstore.getBrowserLogin', async () => {
    // TODO: Implement getting browser login
    return ''
  })
  handle('chromeWebstore.getExtensionStatus', async (_event, id, manifestJson) => {
    const manifest = JSON.parse(manifestJson)
    return getExtensionInstallStatus(webStoreState, id, manifest)
  })

  handle('chromeWebstore.getFullChromeVersion', async () => {
    return {
      version_number: process.versions.chrome,
      app_name: app.getName(),
    }
  })

  handle('chromeWebstore.getIsLauncherEnabled', async () => {
    // TODO: Implement checking if launcher is enabled
    return true
  })

  handle('chromeWebstore.getMV2DeprecationStatus', async () => {
    return webStoreState.minimumManifestVersion > 2
      ? MV2DeprecationStatus.SOFT_DISABLE
      : MV2DeprecationStatus.INACTIVE
  })

  handle('chromeWebstore.getReferrerChain', async () => {
    // TODO: Implement getting referrer chain
    return 'EgIIAA=='
  })

  handle('chromeWebstore.getStoreLogin', async () => {
    // TODO: Implement getting store login
    return ''
  })

  handle('chromeWebstore.getWebGLStatus', async () => {
    await app.getGPUInfo('basic')
    const features = app.getGPUFeatureStatus()
    return features.webgl.startsWith('enabled')
      ? WebGlStatus.WEBGL_ALLOWED
      : WebGlStatus.WEBGL_BLOCKED
  })

  handle('chromeWebstore.install', async (event, id, silentInstall) => {
    // TODO: Implement extension installation
    return Result.SUCCESS
  })

  handle('chromeWebstore.isInIncognitoMode', async () => {
    // TODO: Implement incognito mode check
    return false
  })

  handle('chromeWebstore.isPendingCustodianApproval', async (event, id) => {
    // TODO: Implement custodian approval check
    return false
  })

  handle('chromeWebstore.setStoreLogin', async (event, login) => {
    // TODO: Implement setting store login
    return true
  })

  handle('chrome.runtime.getManifest', async () => {
    // TODO: Implement getting extension manifest
    return {}
  })

  handle('chrome.management.getAll', async (event) => {
    const extensions = webStoreState.session.getAllExtensions()
    return extensions.map(getExtensionInfo)
  })

  handle('chrome.management.setEnabled', async (event, id, enabled) => {
    // TODO: Implement enabling/disabling extension
    if (webStoreState.customSetExtensionEnabled) {
      await webStoreState.customSetExtensionEnabled(webStoreState, id, enabled)
    }
    return true
  })

  handle(
    'chrome.management.uninstall',
    async (event, id, options: { showConfirmDialog: boolean }) => {
      if (options?.showConfirmDialog) {
        // TODO: confirmation dialog
      }

      try {
        await uninstallExtension(id, webStoreState)

        queueMicrotask(() => {
          event.sender.send('chrome.management.onUninstalled', id)
        })

        if (webStoreState.afterUninstall) {
          queueMicrotask(() => {
            webStoreState.afterUninstall?.({ id })
          })
        }

        return Result.SUCCESS
      } catch (error) {
        console.error(error)
        return Result.UNKNOWN_ERROR
      }
    },
  )
}
