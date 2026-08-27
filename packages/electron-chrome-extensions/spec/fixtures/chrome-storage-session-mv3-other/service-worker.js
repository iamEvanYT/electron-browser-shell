chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'storage-session-test') return
  ;(async () => {
    if (message.action === 'grant') {
      await chrome.storage.session.setAccessLevel({ accessLevel: message.accessLevel })
      return null
    }
    if (message.action === 'get') return await chrome.storage.session.get(message.keys)
    throw new Error(`Unknown storage session action: ${message.action}`)
  })().then(
    (value) => sendResponse({ value }),
    (error) => sendResponse({ error: error.message }),
  )
  return true
})
