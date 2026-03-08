// gpu-diag.js — run with: npx electron gpu-diag.js
const { app } = require('electron')
app.commandLine.appendSwitch('use-angle', 'd3d11')
app.whenReady().then(() => {
    const info = app.getGPUInfo('complete')
    info.then(i => {
        console.log(JSON.stringify(i.auxAttributes, null, 2))
        app.quit()
    })
})