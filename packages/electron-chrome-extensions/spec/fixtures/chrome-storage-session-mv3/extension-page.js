function report(result) {
  electronTest.sendIpc('storage-session-document-result', result)
}

window.addEventListener('message', async (event) => {
  const message = event.data
  if (message?.type !== 'storage-session-document-test') return

  try {
    switch (message.action) {
      case 'set':
        await chrome.storage.session.set(message.items)
        report({ value: null })
        break
      case 'get':
        report({ value: await chrome.storage.session.get(message.keys) })
        break
      case 'setAccessLevel':
        await chrome.storage.session.setAccessLevel({ accessLevel: message.accessLevel })
        report({ value: null })
        break
      default:
        throw new Error(`Unknown extension document action: ${message.action}`)
    }
  } catch (error) {
    report({ error: error.message })
  }
})
