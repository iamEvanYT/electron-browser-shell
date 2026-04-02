import { webFrame } from 'electron'
import { injectExtensionAPIs } from './renderer'

let injectInMainWorld = false
const worldIds: number[] = []

// Only load within extension page context
if (process.type === 'service-worker' || location.href.startsWith('chrome-extension://')) {
  injectInMainWorld = true
}

// Probe for extensions isolated world
// Extension worlds start and end values are documented here: https://www.electronjs.org/docs/latest/api/web-frame#webframesetisolatedworldinfoworldid-info
async function scanForExtensionsIsolatedWorlds() {
  // This function must be self-contained - runs in isolated world
  function probeIsolatedWorld() {
    if (globalThis.chrome && chrome.runtime && chrome.runtime.id) {
      return chrome.runtime.id
    }
    return null
  }

  const worlds: { worldId: number; extensionId: string }[] = []
  // let continousFailedTries = 0

  const EXTENSION_WORLD_START = 1 << 20
  const EXTENSION_WORLD_END = 1 << 29
  for (let i = EXTENSION_WORLD_START; i < EXTENSION_WORLD_END; i++) {
    // undefined when script fails to execute
    const extensionId: string | null | undefined = await webFrame.executeJavaScriptInIsolatedWorld(
      i,
      [
        {
          code: `(${probeIsolatedWorld}());`,
        },
      ],
    )

    if (extensionId) {
      console.log('world', i, 'extensionId', extensionId)
      worlds.push({ worldId: i, extensionId })
    } else {
      // I assume this is the last world, because we're scanning in ascending order
      // Could be wrong, if that is the case then correct this logic
      // continousFailedTries++
      // if (continousFailedTries > 100) {
      //   break
      // }
      break
    }
  }

  return worlds
}

async function scanAndInjectExtensionAPIs() {
  // Service workers does not have access to webFrame global, and does not have content scripts.
  if (webFrame) {
    const worlds = await scanForExtensionsIsolatedWorlds()
    worldIds.push(...worlds.map((world) => world.worldId))
  }

  // Inject extension APIs into main world and/or isolated worlds
  const injectInIsolatedWorld = injectExtensionAPIs(injectInMainWorld)
  if (worldIds.length > 0 && injectInIsolatedWorld) {
    worldIds.forEach((worldId) => {
      injectInIsolatedWorld(worldId)
    })
  }
}

// When page first loads, it takes a bit before the extension worlds are actually created.
// setTimeout 1000ms is too long, but not timing out means the APIs will never be injected.
// Weird issue.
scanAndInjectExtensionAPIs()
