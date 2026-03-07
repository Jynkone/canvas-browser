{
  "targets": [
    {
      "target_name": "texture_bridge",
      "sources": [ "bridge.cpp" ],

      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],

      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],

      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],

      "conditions": [
        ["OS=='win'", {
          "libraries": [ "d3d11.lib", "dxgi.lib" ]
        }],
        ["OS=='mac'", {
          "libraries": [ "-framework IOSurface", "-framework Metal" ]
        }]
      ]
    }
  ]
}