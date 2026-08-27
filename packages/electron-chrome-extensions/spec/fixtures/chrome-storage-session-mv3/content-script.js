function report(result) {
  window.postMessage({
    type: 'crx-test-result',
    channel: 'storage-session-result',
    payload: result,
  })
}

window.addEventListener('message', async (event) => {
  const message = event.data
  if (message?.type !== 'storage-session-test') return
  if (message.extension && message.extension !== 'primary') return

  try {
    if (message.action === 'self-grant') {
      await chrome.storage.session.setAccessLevel({ accessLevel: message.accessLevel })
      report({ value: null })
      return
    }

    if (message.action === 'content-get') {
      report({ value: await chrome.storage.session.get(message.keys) })
      return
    }

    if (message.action === 'content-set') {
      await chrome.storage.session.set(message.items)
      report({ value: null })
      return
    }

    if (message.action === 'content-remove') {
      await chrome.storage.session.remove(message.keys)
      report({ value: null })
      return
    }

    if (message.action === 'content-clear') {
      await chrome.storage.session.clear()
      report({ value: null })
      return
    }

    if (message.action === 'content-getKeys') {
      report({ value: await chrome.storage.session.getKeys() })
      return
    }

    if (message.action === 'content-getBytesInUse') {
      report({ value: await chrome.storage.session.getBytesInUse(message.keys) })
      return
    }

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        report({ error: chrome.runtime.lastError.message })
      } else {
        report(response)
      }
    })
  } catch (error) {
    report({ error: error.message })
  }
})
