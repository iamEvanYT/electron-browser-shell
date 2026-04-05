import { expect } from 'chai'

import { waitForBackgroundPage } from './crx-helpers'
import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.permissions', () => {
  const server = useServer()
  const rpcBrowser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })
  const backgroundBrowser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'chrome-permissions',
  })

  const execInBackground = async (code: string) => {
    const backgroundPage = await waitForBackgroundPage(
      backgroundBrowser.extension,
      backgroundBrowser.session,
    )

    return backgroundPage!.executeJavaScript(code)
  }

  describe('contains()', () => {
    it('treats broader granted hosts as covering specific origins', async () => {
      const result = await rpcBrowser.crx.exec('permissions.contains', {
        origins: ['https://account.proton.me/*', 'https://pass.proton.me/*'],
      })

      expect(result).to.equal(true)
    })

    it('treats scriptable hosts as path-aware', async () => {
      const matches = await execInBackground(`
        new Promise((resolve) => {
          chrome.permissions.contains({ origins: ['https://script.example.com/foo/bar/*'] }, resolve)
        })
      `)
      const doesNotMatch = await execInBackground(`
        new Promise((resolve) => {
          chrome.permissions.contains({ origins: ['https://script.example.com/bar/*'] }, resolve)
        })
      `)

      expect(matches).to.equal(true)
      expect(doesNotMatch).to.equal(false)
    })
  })

  describe('getAll()', () => {
    it('returns host patterns under origins', async () => {
      const result = await rpcBrowser.crx.exec('permissions.getAll')

      expect(result.permissions).to.include.members([
        'contextMenus',
        'nativeMessaging',
        'webRequest',
        'webRequestBlocking',
      ])
      expect(result.permissions).to.not.include('<all_urls>')
      expect(result.origins).to.include('<all_urls>')
    })

    it('includes scriptable origins without exposing them as named permissions', async () => {
      const result = await execInBackground('chrome.permissions.getAll()')

      expect(result.permissions).to.deep.equal(['storage'])
      expect(result.origins).to.deep.equal(['https://script.example.com/foo/*'])
    })
  })

  describe('request()', () => {
    it('rejects undeclared origins', async () => {
      await expect(
        execInBackground(`
          chrome.permissions.request({ origins: ['https://undeclared.example.com/*'] })
        `),
      ).to.be.rejectedWith('Permissions request includes undeclared origin')
    })

    it('grants declared optional origins as normalized host permissions', async () => {
      const granted = await execInBackground(`
        chrome.permissions.request({ origins: ['https://optional.example.com/account/*'] })
      `)
      const result = await execInBackground('chrome.permissions.getAll()')

      expect(granted).to.equal(true)
      expect(result.origins).to.include.members([
        'https://script.example.com/foo/*',
        'https://optional.example.com/*',
      ])
    })
  })
})
