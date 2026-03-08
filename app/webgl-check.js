// webgl-check.js — npx electron webgl-check.js
const { app, BrowserWindow } = require('electron')

app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('force_high_performance_gpu')

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 800, height: 900,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    })

    // Use a file:// data URL built with string concat — no backticks anywhere
    const script = [
        'var out = document.getElementById("out");',
        'var canvas = document.createElement("canvas");',
        'var gl = canvas.getContext("webgl2") || canvas.getContext("webgl");',
        'if (!gl) { out.textContent = "NO WEBGL"; } else {',
        '  var lines = [];',
        '  lines.push("Renderer: " + gl.getParameter(gl.RENDERER));',
        '  lines.push("Version: " + gl.getParameter(gl.VERSION));',
        '  lines.push("");',
        '  var exts = gl.getSupportedExtensions();',
        '  lines.push("Total extensions: " + exts.length);',
        '  lines.push("");',
        '  lines.push("--- ALL EXTENSIONS ---");',
        '  exts.forEach(function(e){ lines.push(e); });',
        '  out.textContent = lines.join("\\n");',
        '}',
    ].join('\n')

    const html = '<!DOCTYPE html><html><head>'
        + '<style>body{background:#111;color:#eee;font:12px monospace;padding:16px}'
        + 'pre{white-space:pre-wrap;line-height:1.6}</style>'
        + '</head><body>'
        + '<pre id="out">running...</pre>'
        + '<script>' + script + '<\/script>'
        + '</body></html>'

    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
})

app.on('window-all-closed', () => app.quit())