const { contextBridge, ipcRenderer } = require("electron")

function readDesktopConfig() {
  const config = ipcRenderer.sendSync("stemstudio:get-desktop-config")
  if (
    config
    && typeof config === "object"
    && typeof config.apiBaseUrl === "string"
    && typeof config.apiToken === "string"
  ) {
    return config
  }
  throw new Error("StemStudio desktop configuration is unavailable.")
}

contextBridge.exposeInMainWorld("stemstudioDesktop", {
  ...readDesktopConfig(),
})
