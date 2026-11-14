import { Component, StrictMode, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './mobile-navigation.css'

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { console.error('AARO storefront render failed:', error) }
  render() {
    if (this.state.failed) return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f7f8f5', color: '#193d37', fontFamily: 'DM Sans, sans-serif', textAlign: 'center' }}><div><h1 style={{ fontSize: 26 }}>The store could not load</h1><p style={{ fontSize: 16 }}>Please reload the page. The saved storefront data has been checked and can recover automatically.</p><button onClick={() => window.location.reload()} style={{ padding: '12px 20px', border: 0, borderRadius: 6, background: '#f3a13e', color: '#14251f', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>Reload store</button></div></main>
    return this.props.children
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>
)
