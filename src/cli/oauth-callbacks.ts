import { isCancel, log, note, text } from '@clack/prompts'

import type { OAuthCallbacks } from '@/init/oauth-login'

// Shared between `typeclaw init` (src/cli/init.ts) and `typeclaw provider
// add/set` (src/cli/provider.ts). Both call into the same OAuth runner, so
// they need to render the same UX: a note() box with the URL + cross-device
// guidance, a `text()` prompt for the post-callback manual fallback, and a
// concurrent `onManualCodeInput` prompt for users whose browser is on a
// different host than the CLI. See src/init/oauth-login.ts for the contract
// on each callback and why onManualCodeInput is required for cross-device.
export function buildOAuthCallbacks(providerName: string): OAuthCallbacks {
  return {
    onAuth: (url, instructions) => {
      // Don't put the URL inside note(): clack wraps long lines with the box
      // border `│` on each wrapped segment, which corrupts the URL when the
      // user copy-pastes it. Keep instructional text in the box, but print
      // the URL itself as a bare console.log line that any terminal will
      // hyperlink intact.
      const preamble = [
        `Open this URL in your browser to sign in to ${providerName}.`,
        '',
        'If your browser shows "this site can\'t be reached" after you sign in,',
        'copy the full address from the top of the browser and paste it below.',
      ]
      if (instructions) preamble.push('', instructions)
      note(preamble.join('\n'), 'Browser login')
      console.log(url)
      console.log('')
    },
    onProgress: (message) => {
      log.info(message)
    },
    onPrompt: async (message, placeholder) => {
      const value = await text({ message, ...(placeholder !== undefined ? { placeholder } : {}) })
      if (isCancel(value)) return null
      return value
    },
    onManualCodeInput: async () => {
      const value = await text({
        message:
          'If your browser shows "this site can\'t be reached" after you sign in, copy the full address from the top of the browser and paste it here:',
        placeholder: 'http://localhost:1455/auth/callback?code=...&state=...',
      })
      if (isCancel(value)) throw new Error('Login cancelled by user')
      return value
    },
  }
}
