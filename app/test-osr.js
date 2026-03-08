const { app, BrowserWindow, sharedTexture } = require('electron')

// The self-contained WebGL2 Renderer HTML
const MAIN_HTML = `<!DOCTYPE html><html><head><style>
* { margin:0; padding:0; box-sizing:border-box }
body { background:#111; overflow:hidden; width:100vw; height:100vh; }
canvas { display:block; width:100%; height:100%; cursor: grab; }
canvas:active { cursor: grabbing; }
#ui { position:absolute; top:10px; left:10px; color:#4ade80; font:14px monospace; pointer-events:none; text-shadow: 0 2px 4px rgba(0,0,0,0.8); z-index: 10; }
</style></head><body>
<div id="ui">Booting WebGL Engine...</div>
<canvas id="c"></canvas>
<script>
const { sharedTexture } = require('electron')
const canvas = document.getElementById('c')
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })
const ui = document.getElementById('ui')

// --- WEBGL SHADER SETUP ---
const vsSource = \`
  attribute vec2 a_position;
  uniform vec2 u_resolution;
  uniform vec2 u_tabSize;
  uniform vec2 u_offset;
  uniform float u_zoom;
  varying vec2 v_texCoord;

  void main() {
    // Scale quad to tab dimensions, apply zoom, add pan offset
    vec2 pixelPos = (a_position * u_tabSize * u_zoom) + u_offset;
    
    // Convert to WebGL clip space (-1.0 to +1.0)
    vec2 clipSpace = (pixelPos / u_resolution) * 2.0 - 1.0;
    
    // Flip Y (WebGL is bottom-up, DOM is top-down)
    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1.0);
    
    // Pass coordinate to Fragment Shader
    v_texCoord = vec2(a_position.x, a_position.y);
  }
\`;

const fsSource = \`
  precision mediump float;
  uniform sampler2D u_image;
  varying vec2 v_texCoord;
  void main() {
    gl_FragColor = texture2D(u_image, v_texCoord);
  }
\`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
  }
  return shader;
}

const program = gl.createProgram();
gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vsSource));
gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fsSource));
gl.linkProgram(program);

// --- GEOMETRY SETUP ---
const positionBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  0, 0,  1, 0,  0, 1,
  0, 1,  1, 0,  1, 1
]), gl.STATIC_DRAW);

const positionLoc = gl.getAttribLocation(program, 'a_position');
gl.enableVertexAttribArray(positionLoc);
gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

// --- TEXTURE SETUP ---
const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

// --- INFINITE CANVAS CAMERA ---
let camera = { x: 100, y: 100, zoom: 0.8 };
let tabSize = { w: 1280, h: 720 };
let isDragging = false, lastMouse = { x: 0, y: 0 };
let frameCount = 0, lastTime = Date.now(), fps = 0;

window.addEventListener('mousedown', e => { isDragging = true; lastMouse = { x: e.clientX, y: e.clientY }; });
window.addEventListener('mouseup', () => isDragging = false);
window.addEventListener('mousemove', e => {
  if (!isDragging) return;
  camera.x += (e.clientX - lastMouse.x);
  camera.y += (e.clientY - lastMouse.y);
  lastMouse = { x: e.clientX, y: e.clientY };
});
window.addEventListener('wheel', e => {
  const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
  camera.zoom *= zoomFactor;
});

// --- PURE GPU TEXTURE RECEIVER ---
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
  try {
    const frame = importedSharedTexture.getVideoFrame();
    
    tabSize.w = frame.displayWidth;
    tabSize.h = frame.displayHeight;

    // Direct GPU-to-GPU pointer swap. No CPU readback.
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

    frame.close();
    importedSharedTexture.release();

    frameCount++;
    const now = Date.now();
    if (now - lastTime >= 1000) {
      fps = frameCount; frameCount = 0; lastTime = now;
      ui.textContent = \`YouTube Tab | \${tabSize.w}x\${tabSize.h} | \${fps} FPS | Pure GPU\`;
    }
  } catch (e) {
    console.error('Texture Receiver Error:', e);
  }
});

// --- RENDER LOOP ---
function draw() {
  requestAnimationFrame(draw);

  if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.clearColor(0.05, 0.05, 0.05, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(program);

  gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), gl.canvas.width, gl.canvas.height);
  gl.uniform2f(gl.getUniformLocation(program, 'u_tabSize'), tabSize.w, tabSize.h);
  gl.uniform2f(gl.getUniformLocation(program, 'u_offset'), camera.x, camera.y);
  gl.uniform1f(gl.getUniformLocation(program, 'u_zoom'), camera.zoom);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
draw();
</script>
</body></html>`

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400, height: 820,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(MAIN_HTML))

  const log = m => console.log('[OSR]', m)

  win.webContents.once('did-finish-load', () => {
    // Spawn the hidden YouTube OSR Window
    const osr = new BrowserWindow({
      show: false,
      width: 1280, height: 720,
      webPreferences: {
        offscreen: { useSharedTexture: true },
        backgroundThrottling: false,
        sandbox: false,
      }
    })

    osr.webContents.startPainting()
    osr.webContents.setFrameRate(60)

    osr.webContents.on('paint', async (e) => {
      const texture = e.texture
      if (!texture) return

      // Map D3D11 to SharedImage Mailbox
      const imported = sharedTexture.importSharedTexture({
        textureInfo: texture.textureInfo,
        allReferencesReleased: () => {
          texture.release() // Unlocks the GPU pool slot safely
        }
      })

      // Send to Renderer
      await sharedTexture.sendSharedTexture({
        frame: win.webContents.mainFrame,
        importedSharedTexture: imported
      })

      imported.release()
    })

    log('Loading YouTube...')
    osr.webContents.loadURL('https://www.youtube.com')
      .catch(e => log('loadURL error: ' + e.message))

    osr.webContents.on('did-finish-load', () => log('Page loaded ✅'))
    osr.webContents.on('render-process-gone', (_e, d) => log('❌ crashed: ' + d.reason))
  })
})

app.on('window-all-closed', () => app.quit())