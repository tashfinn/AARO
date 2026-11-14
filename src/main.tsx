import { Component, StrictMode, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './mobile-navigation.css'

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; error: string }> {
  state = { failed: false, error: '' }
  static getDerivedStateFromError(error: unknown) { return { failed: true, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) } }
  componentDidCatch(error: Error) { console.error('AARO storefront render failed:', error) }
  render() {
    if (this.state.failed) return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f7f8f5', color: '#193d37', fontFamily: 'DM Sans, sans-serif', textAlign: 'center' }}><div style={{ maxWidth: 680 }}><h1 style={{ fontSize: 26 }}>The store could not load</h1><p style={{ fontSize: 16 }}>A rendering error occurred. The details below identify the failure.</p><code style={{ display: 'block', margin: '18px 0', padding: 14, borderRadius: 6, background: '#e9eee9', color: '#8a2d25', fontSize: 14, textAlign: 'left', overflowWrap: 'anywhere' }}>{this.state.error}</code><button onClick={() => window.location.reload()} style={{ padding: '12px 20px', border: 0, borderRadius: 6, background: '#f3a13e', color: '#14251f', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>Reload store</button></div></main>
    return this.props.children
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>
)
