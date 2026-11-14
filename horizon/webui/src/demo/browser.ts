import { setupWorker } from 'msw/browser'
import { createDemoHandlers } from './handlers'
import { createDemoExperience } from './experience'
import { DEMO_PREFIX, demoAllowed } from './policy'

export async function startDemoExperience() {
  if (
    !demoAllowed(
      __HORIZON_DEMO_BUILD_ALLOWED__,
      import.meta.env.DEV,
      import.meta.env.VITE_HORIZON_DEMO,
      window.location.hostname,
    )
  )
    throw new Error('Demo mode is restricted to explicit local development.')
  const worker = setupWorker(...createDemoHandlers(window.location.origin))
  await worker.start({
    quiet: true,
    serviceWorker: { url: `${DEMO_PREFIX}mockServiceWorker.js`, options: { scope: '/' } },
    onUnhandledRequest: 'error',
  })
  let active = true
  const stop = () => {
    active = false
    worker.stop()
  }
  window.addEventListener('pagehide', stop, { once: true })
  import.meta.hot?.dispose(stop)
  return createDemoExperience(() => active)
}
