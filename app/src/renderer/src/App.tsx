import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { getAssetUrls } from '@tldraw/assets/selfHosted'  // ✅ this path exists

const assetUrls = getAssetUrls()

export default function App() {
  return (
    // also fixes the scroll issue by making the editor truly fill the window
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw assetUrls={assetUrls} />
    </div>
  )
}
