#include <napi.h>
#include <d3d11_1.h>
#include <windows.h>

ID3D11Device1* g_pd3dDevice = nullptr;
ID3D11DeviceContext1* g_pImmediateContext = nullptr;

void InitD3D() {
    ID3D11Device* baseDevice = nullptr;
    ID3D11DeviceContext* baseContext = nullptr;
    D3D_FEATURE_LEVEL featureLevel;

    HRESULT hr = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
        nullptr, 0, D3D11_SDK_VERSION, &baseDevice,
        &featureLevel, &baseContext
    );

    if (SUCCEEDED(hr)) {
        baseDevice->QueryInterface(__uuidof(ID3D11Device1), (void**)&g_pd3dDevice);
        baseContext->QueryInterface(__uuidof(ID3D11DeviceContext1), (void**)&g_pImmediateContext);
        baseDevice->Release();
        baseContext->Release();
    }
}

Napi::Value DecodeHandle(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected Buffer handle").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> handleBuf = info[0].As<Napi::Buffer<uint8_t>>();
    HANDLE sharedHandle = *reinterpret_cast<HANDLE*>(handleBuf.Data());

    if (!g_pd3dDevice) InitD3D();
    if (!g_pd3dDevice || !g_pImmediateContext) return env.Null();

    // 1. Open the Secret Handle
    ID3D11Texture2D* pSharedTex = nullptr;
    HRESULT hr = g_pd3dDevice->OpenSharedResource1(sharedHandle, __uuidof(ID3D11Texture2D), (void**)&pSharedTex);
    if (FAILED(hr) || !pSharedTex) return env.Null();

    D3D11_TEXTURE2D_DESC desc;
    pSharedTex->GetDesc(&desc);

    // 2. Create a "Staging" Texture (This allows the CPU to read the GPU memory)
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;

    ID3D11Texture2D* pStagingTex = nullptr;
    hr = g_pd3dDevice->CreateTexture2D(&desc, nullptr, &pStagingTex);
    if (FAILED(hr)) { pSharedTex->Release(); return env.Null(); }

    // 3. Copy the live video frame into our readable staging area
    g_pImmediateContext->CopyResource(pStagingTex, pSharedTex);

    D3D11_MAPPED_SUBRESOURCE mapped;
    hr = g_pImmediateContext->Map(pStagingTex, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) {
        pStagingTex->Release(); pSharedTex->Release();
        return env.Null();
    }

    // 4. Extract the pixels and convert BGRA to RGBA for the Web Canvas
    uint32_t width = desc.Width;
    uint32_t height = desc.Height;
    size_t totalBytes = width * height * 4;
    uint8_t* rawPixels = new uint8_t[totalBytes];

    const uint8_t* srcData = reinterpret_cast<const uint8_t*>(mapped.pData);
    for (uint32_t y = 0; y < height; ++y) {
        const uint8_t* srcRow = srcData + (y * mapped.RowPitch);
        uint8_t* destRow = rawPixels + (y * width * 4);

        for (uint32_t x = 0; x < width; ++x) {
            destRow[x * 4 + 0] = srcRow[x * 4 + 2]; // Red
            destRow[x * 4 + 1] = srcRow[x * 4 + 1]; // Green
            destRow[x * 4 + 2] = srcRow[x * 4 + 0]; // Blue
            destRow[x * 4 + 3] = srcRow[x * 4 + 3]; // Alpha
        }
    }

    g_pImmediateContext->Unmap(pStagingTex, 0);
    pStagingTex->Release();
    pSharedTex->Release();

    // 5. Send the pixel data back to JavaScript
    Napi::Object result = Napi::Object::New(env);
    result.Set("width", width);
    result.Set("height", height);

    Napi::Buffer<uint8_t> jsBuffer = Napi::Buffer<uint8_t>::New(
        env, rawPixels, totalBytes,
        [](Napi::Env /*env*/, uint8_t* data) { delete[] data; } // Clean up memory automatically
    );
    result.Set("buffer", jsBuffer);

    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("decodeHandle", Napi::Function::New(env, DecodeHandle));
    return exports;
}

NODE_API_MODULE(texture_bridge, Init)