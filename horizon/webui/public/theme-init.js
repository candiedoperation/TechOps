/* Runs synchronously before the app/styles to prevent a light/dark flash.
 * Keep the key and accepted values aligned with src/theme/appearance.ts.
 * This stores appearance only, never identity or credentials.
 */
;(function () {
  var preference = 'dark'
  try {
    var stored = localStorage.getItem('horizon-ui-theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') preference = stored
    else if (stored != null) preference = 'system'
  } catch (_) {
    /* Storage may be blocked; System still works. */
  }
  var dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  var resolved = preference === 'system' ? (dark ? 'dark' : 'light') : preference
  document.documentElement.dataset.theme = resolved
  document.documentElement.classList.add(resolved)
  document.documentElement.style.colorScheme = resolved
})()
