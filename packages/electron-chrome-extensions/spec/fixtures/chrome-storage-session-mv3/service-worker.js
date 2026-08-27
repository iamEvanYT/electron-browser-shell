chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'storage-session-test') return

  ;(async () => {
    switch (message.action) {
      case 'set':
        await chrome.storage.session.set(message.items)
        return null
      case 'get':
        return await chrome.storage.session.get(message.keys)
      case 'getKeys':
        return await chrome.storage.session.getKeys()
      case 'getBytesInUse':
        return await chrome.storage.session.getBytesInUse(message.keys)
      case 'remove':
        await chrome.storage.session.remove(message.keys)
        return null
      case 'clear':
        await chrome.storage.session.clear()
        return null
      case 'grant':
        await chrome.storage.session.setAccessLevel({ accessLevel: message.accessLevel })
        return null
      default:
        throw new Error(`Unknown storage session action: ${message.action}`)
    }
  })().then(
    (value) => sendResponse({ value }),
    (error) => sendResponse({ error: error.message }),
  )

  return true
})
