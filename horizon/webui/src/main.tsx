import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App, type AppExperience } from './app/App'
import './styles.css'
import './features/portfolio/portfolio.css'

const root = createRoot(document.getElementById('root')!)
function render(experience?: AppExperience) {
  root.render(
    <StrictMode>
      <BrowserRouter>
        <App experience={experience} />
      </BrowserRouter>
    </StrictMode>,
  )
}

// Both conditions are replaced at build time. Production cannot import the demo chunk.
if (
  import.meta.env.DEV &&
  __HORIZON_DEMO_BUILD_ALLOWED__ &&
  import.meta.env.VITE_HORIZON_DEMO === 'true'
) {
  import('./demo/browser')
    .then(async ({ startDemoExperience }) => render(await startDemoExperience()))
    .catch(() => {
      // Never fall back to live requests when interception is unavailable.
      root.render(
        <main className="startup-error">
          <h1>Demo environment unavailable</h1>
          <p>
            No data requests were enabled. Use the local demo server in a browser supporting service
            workers, then reload.
          </p>
        </main>,
      )
    })
} else {
  render()
}
