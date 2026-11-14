import { Component, type ReactNode } from 'react'

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <main className="fatal-error" role="alert">
          <h1>Horizon could not display this page.</h1>
          <p>Please reload the workspace to try again.</p>
          <button className="button button-primary" onClick={() => window.location.reload()}>
            Reload Horizon
          </button>
        </main>
      )
    return this.props.children
  }
}
