import ReactDOM from 'react-dom/client'
import App from './App'
import 'tldraw/tldraw.css'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Renderer bootstrap failed: missing <div id="root"></div> in index.html')
}

ReactDOM.createRoot(rootEl).render(<App />)
