import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import 'tldraw/tldraw.css'

// ⚠️ Remove StrictMode to avoid double-running effects in dev
ReactDOM.createRoot(document.getElementById('root')!).render(
  // <React.StrictMode>
    <App />
  // </React.StrictMode>
)
