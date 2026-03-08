
const { app } = require('electron')

app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('enable-features', 'NativeGpuMemoryBuffers,D3D11SharedImages,SharedImageVideo,UseSkiaRenderer')
app.commandLine.appendSwitch('use-cmd-decoder', 'passthrough')

app.whenReady().then(async () => {
    const info = await app.getGPUInfo('complete')

    console.log('\n=== GPU DEVICES ===')
    console.log(JSON.stringify(info.gpuDevice, null, 2))

    console.log('\n=== DRIVER ===')
    console.log('vendorId:', info.gpuDevice?.[0]?.vendorId)
    console.log('deviceId:', info.gpuDevice?.[0]?.deviceId)
    console.log('driverVersion:', info.gpuDevice?.[0]?.driverVersion)
    console.log('active:', info.gpuDevice?.[0]?.active)

    console.log('\n=== AUX ATTRIBUTES ===')
    console.log(JSON.stringify(info.auxAttributes, null, 2))

    console.log('\n=== FEATURE STATUS ===')
    console.log(JSON.stringify(app.getGPUFeatureStatus(), null, 2))

    app.quit()
})