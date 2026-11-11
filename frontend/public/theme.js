// Apply the saved appearance (light/dark + accent skin) before first paint to avoid a flash.
// External file on purpose: the backend's CSP forbids inline scripts.
// ThemeContext writes the *effective* values here (user choice → admin default), so signed-out
// pages show the global default and signed-in pages the user's own choice.
;(function () {
  var root = document.documentElement
  function read(key) {
    try {
      return JSON.parse(localStorage.getItem(key))
    } catch {
      return null // storage unavailable or invalid JSON
    }
  }
  var mode = read('sd:theme')
  var dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) root.classList.add('dark')
  var skin = read('sd:skin')
  if (typeof skin !== 'string' || !/^[a-z]{1,20}$/.test(skin)) skin = 'sky'
  root.setAttribute('data-skin', skin)
  // Tab icon in the skin's accent (files from scripts/gen-icons.mjs); the app then keeps it in sync (theme/favicon.ts)
  var icon = document.getElementById('favicon')
  if (icon && skin !== 'sky') icon.setAttribute('href', '/icons/' + skin + '/favicon.svg')
  var lang = read('sd:lang')
  if (lang === 'en' || lang === 'es') root.lang = lang
})()
