function report(result) {
  window.postMessage({
    type: 'crx-test-result',
    channel: 'storage-session-result',
    payload: result,
  })
}

window.addEventListener('message', async (event) => {
  const message = event.data
  if (message?.type !== 'storage-session-test' || message.extension !== 'secondary') return
  try {
    if (message.action === 'content-get') {
      report({ value: await chrome.storage.session.get(message.keys) })
      return
    }
    chrome.runtime.sendMessage(message, (response) => {
      report(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : response)
    })
  } catch (error) {
    report({ error: error.message })
  }
})
