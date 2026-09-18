# Mobile Home Screen shortcut

The mobile installation guidance is loaded from `public/install-shortcut.js` and styled by `public/install-shortcut.css`. It uses the existing EN/TH language selector.

On mobile browsers, the dialog becomes eligible eight seconds after page load. It is suppressed when the page is hidden, another dialog is open, a form field has focus, or the app is running in standalone mode. Closing it or choosing Not now suppresses it for seven days on that browser. If browser storage is unavailable, suppression lasts for the current page session.

iPhone and iPad users receive Safari Share / Add to Home Screen instructions. Android users receive browser-menu instructions. If the browser supplies `beforeinstallprompt`, the dialog exposes a native Install button and invokes the prompt only after a user click. The manifest specifies standalone launch with 192px and 512px icons derived from the owner's selected logo. A 180px Apple touch icon is also provided. Native installation availability depends on the browser.

Browsers do not expose a universal installed-app check. Standalone launch is detected, and the current page stops offering installation after `appinstalled`. A normal browser tab can still show guidance even if a shortcut exists elsewhere. Uninstall detection is not claimed.

This feature does not cache account data, credentials, API responses, or trading requests. It does not enable offline order submission. The logo proposals require owner selection before any production icon is replaced.

Verification: `node --test --test-isolation=none test/install-shortcut.test.js` covers suppression, EN/TH guidance, dismissal persistence, and user-triggered native prompts. Physical iOS and Android installation remains a manual acceptance check.
