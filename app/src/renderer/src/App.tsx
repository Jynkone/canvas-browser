import { useMemo } from 'react';
import { Tldraw } from 'tldraw';
import { getAssetUrls } from '@tldraw/assets/selfHosted';
import { BrowserShapeUtil } from './BrowserShapeUtil';

export default function App() {
  const shapeUtils = useMemo(() => [BrowserShapeUtil], []);
  // electron-vite renderer serves public/ at '/'
  const assetUrls = useMemo(
    () => getAssetUrls({ baseUrl: '/tldraw-assets' }),
    []
  );

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Tldraw
        shapeUtils={shapeUtils}
        assetUrls={assetUrls}  // <- forces icons/fonts from /tldraw-assets/*
        onMount={(editor) => {
          editor.createShape({
            type: 'browser-shape',
            x: 100, y: 100,
            props: { w: 1000, h: 650, url: 'https://example.com', tabId: '' },
          });
        }}
      />
    </div>
  );
}
