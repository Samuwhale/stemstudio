import { app, BrowserWindow, ipcMain } from "electron"
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, "..")
const projectRoot = path.resolve(desktopRoot, "..")
const defaultHost = "127.0.0.1"
const defaultPort = 8000
const shutdownGraceMs = 30000
const workerHeartbeatFilename = "worker.heartbeat"
const workerStartupTimeoutMs = 45000
const processes = new Map()
const recentProcessOutput = new Map()
const maxRecentOutputChars = 6000

let mainWindow = null
let quitting = false
let terminating = false
let processShutdownInProgress = false
let expectedProcessExitDepth = 0
const apiToken = crypto.randomBytes(32).toString("hex")
let currentApiBaseUrl = `http://${defaultHost}:${defaultPort}`
let workerHeartbeatReadErrorLogged = false
let workerHeartbeatReadErrorDetail = null

ipcMain.on("stemstudio:get-desktop-config", (event) => {
  event.returnValue = {
    apiBaseUrl: currentApiBaseUrl,
    apiToken,
  }
})

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function loadingHtml(title, message, detail = "") {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>StemStudio</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7faf8; color: #18211d; }
      main { width: min(440px, calc(100vw - 48px)); }
      h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.2; }
      p { margin: 0; color: #516058; line-height: 1.5; }
      pre { margin-top: 18px; white-space: pre-wrap; color: #7a2e22; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
      @media (prefers-color-scheme: dark) {
        body { background: #171a18; color: #eef5ef; }
        p { color: #aeb8b0; }
        pre { color: #f1a092; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${detail ? `<pre>${escapeHtml(detail)}</pre>` : ""}
    </main>
  </body>
</html>`
}

function loadStatusPage(title, message, detail = "") {
  if (!mainWindow) {
    mainWindow = createWindow()
  }
  const html = loadingHtml(title, message, detail)
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function resolveRuntimeRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "runtime")
  }
  return path.join(projectRoot, "desktop", "runtime")
}

function resolveFrontendIndex() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "frontend", "index.html")
  }
  return path.join(projectRoot, "frontend", "dist", "index.html")
}

function processEnv(port) {
  const runtimeRoot = resolveRuntimeRoot()
  const binPath = path.join(runtimeRoot, "bin")
  return {
    ...process.env,
    PATH: `${binPath}${path.delimiter}${process.env.PATH ?? ""}`,
    PYTHONUNBUFFERED: "1",
    STEMSTUDIO_API_HOST: defaultHost,
    STEMSTUDIO_API_PORT: String(port),
    STEMSTUDIO_DESKTOP_RESOURCES_DIR: runtimeRoot,
    STEMSTUDIO_DESKTOP_USER_DATA_DIR: app.getPath("userData"),
    STEMSTUDIO_DESKTOP_API_TOKEN: apiToken,
  }
}

function executablePath(name) {
  return path.join(resolveRuntimeRoot(), name, name)
}

function commandFor(role) {
  const frozenName = role === "api" ? "stemstudio-api" : "stemstudio-worker"
  const frozenPath = executablePath(frozenName)
  if (fs.existsSync(frozenPath)) {
    return { command: frozenPath, args: [], cwd: projectRoot }
  }
  const setupHint = app.isPackaged
    ? "Reinstall StemStudio or rebuild the app package."
    : "Run npm run setup:local from the project root, then reopen StemStudio."
  throw new Error(`Missing desktop runtime executable: ${frozenPath}\n${setupHint}`)
}

function writeLog(role, chunk) {
  const logsDir = app.getPath("logs")
  try {
    fs.mkdirSync(logsDir, { recursive: true })
    fs.appendFile(
      path.join(logsDir, "stemstudio-desktop.log"),
      `[${new Date().toISOString()}] [${role}] ${chunk.toString()}`,
      () => {},
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[stemstudio] could not write desktop log: ${message}`)
  }
}

function outputRoleLabel(role) {
  return role === "api" ? "API" : "Worker"
}

function recordProcessOutput(role, streamName, chunk) {
  const currentOutput = recentProcessOutput.get(role) ?? ""
  const nextOutput = `${currentOutput}[${streamName}] ${chunk.toString()}`
  recentProcessOutput.set(role, nextOutput.slice(-maxRecentOutputChars))
}

function processFailureDetail(role, message) {
  const output = recentProcessOutput.get(role)?.trim()
  if (!output) return message
  return `${message}\n\nRecent ${outputRoleLabel(role)} output:\n${output}`
}

function logDesktopError(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  writeLog("desktop", `${message}\n`)
}

function handleUnexpectedProcessExit(role, code, signal) {
  if (quitting || processShutdownInProgress || expectedProcessExitDepth > 0) return

  const label = role === "api" ? "local API" : "stem worker"
  processShutdownInProgress = true
  loadStatusPage(
    "StemStudio stopped",
    `The ${label} process exited. Restart StemStudio to try again.`,
    processFailureDetail(role, `Exit code: ${code ?? "none"}\nSignal: ${signal ?? "none"}`),
  )
  terminateProcesses({ appIsQuitting: false })
    .catch(logDesktopError)
    .finally(() => {
      processShutdownInProgress = false
    })
}

function startProcess(role, env) {
  const command = commandFor(role)
  recentProcessOutput.delete(role)
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stemstudioStartupError = null

  processes.set(role, child)
  child.stdout.on("data", (chunk) => {
    recordProcessOutput(role, "stdout", chunk)
    writeLog(role, chunk)
  })
  child.stderr.on("data", (chunk) => {
    recordProcessOutput(role, "stderr", chunk)
    writeLog(role, chunk)
  })
  child.on("exit", (code, signal) => {
    processes.delete(role)
    writeLog(role, `exited with code ${code ?? "null"} signal ${signal ?? "null"}\n`)
    handleUnexpectedProcessExit(role, code, signal)
  })
  child.on("error", (error) => {
    child.stemstudioStartupError = error
    processes.delete(role)
    writeLog(role, `${error.stack ?? error.message}\n`)
  })

  return child
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function canUsePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, defaultHost)
  })
}

async function findPort(startPort) {
  for (let port = startPort; port < startPort + 30; port += 1) {
    if (await canUsePort(port)) return port
  }
  throw new Error(`No available local API port found from ${startPort} to ${startPort + 29}.`)
}

function checkHealth(apiBaseUrl) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (healthy) => {
      if (settled) return
      settled = true
      resolve(healthy)
    }

    const request = http.get(`${apiBaseUrl}/api/health`, (response) => {
      response.resume()
      finish(response.statusCode === 200)
    })
    request.setTimeout(1000, () => {
      request.destroy()
      finish(false)
    })
    request.on("error", () => finish(false))
  })
}

async function waitForApi(apiBaseUrl, apiProcess) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (apiProcess.stemstudioStartupError) {
      throw new Error(`API process could not start: ${apiProcess.stemstudioStartupError.message}`)
    }
    if (apiProcess.exitCode !== null || apiProcess.signalCode !== null) {
      throw new Error(
        processFailureDetail(
          "api",
          `API process exited before it became ready with code ${apiProcess.exitCode ?? "none"} `
          + `and signal ${apiProcess.signalCode ?? "none"}.`,
        ),
      )
    }
    if (await checkHealth(apiBaseUrl)) return
    await delay(400)
  }
  throw new Error(processFailureDetail("api", "Timed out waiting for the local API to start."))
}

function workerHeartbeatPath() {
  return path.join(app.getPath("userData"), "tmp", workerHeartbeatFilename)
}

function resetWorkerHeartbeat() {
  try {
    fs.rmSync(workerHeartbeatPath(), { force: true })
    workerHeartbeatReadErrorLogged = false
    workerHeartbeatReadErrorDetail = null
  } catch (error) {
    workerHeartbeatReadErrorDetail = error instanceof Error ? error.message : String(error)
    logDesktopError(error)
  }
}

function hasFreshWorkerHeartbeat(startedAt) {
  try {
    const fresh = fs.statSync(workerHeartbeatPath()).mtimeMs >= startedAt
    if (fresh) {
      workerHeartbeatReadErrorLogged = false
      workerHeartbeatReadErrorDetail = null
    }
    return fresh
  } catch (error) {
    if (error?.code === "ENOENT") return false
    workerHeartbeatReadErrorDetail = error instanceof Error ? error.message : String(error)
    if (!workerHeartbeatReadErrorLogged) {
      logDesktopError(error)
      workerHeartbeatReadErrorLogged = true
    }
    return false
  }
}

async function waitForWorker(workerProcess, startedAt) {
  const deadline = Date.now() + workerStartupTimeoutMs
  while (Date.now() < deadline) {
    if (workerProcess.stemstudioStartupError) {
      throw new Error(`Worker process could not start: ${workerProcess.stemstudioStartupError.message}`)
    }
    if (workerProcess.exitCode !== null || workerProcess.signalCode !== null) {
      throw new Error(
        processFailureDetail(
          "worker",
          `Worker process exited before it became ready with code ${workerProcess.exitCode ?? "none"} `
          + `and signal ${workerProcess.signalCode ?? "none"}.`,
        ),
      )
    }
    if (hasFreshWorkerHeartbeat(startedAt)) return
    await delay(200)
  }
  if (workerHeartbeatReadErrorDetail) {
    throw new Error(processFailureDetail(
      "worker",
      `Timed out waiting for the local worker to start.\nCould not read worker heartbeat: ${workerHeartbeatReadErrorDetail}`,
    ))
  }
  throw new Error(processFailureDetail("worker", "Timed out waiting for the local worker to start."))
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f7faf8",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.once("ready-to-show", () => window.show())
  window.on("closed", () => {
    mainWindow = null
  })
  return window
}

async function loadRenderer() {
  if (!mainWindow) return
  const frontendIndex = resolveFrontendIndex()
  if (!fs.existsSync(frontendIndex)) {
    throw new Error(`Missing built frontend: ${frontendIndex}`)
  }
  await mainWindow.loadFile(frontendIndex)
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (typeof child.pid !== "number") return
  const killTarget = process.platform === "win32" ? child.pid : -child.pid
  const sendSignal = (signal) => {
    try {
      process.kill(killTarget, signal)
      return true
    } catch (error) {
      if (error?.code === "ESRCH") return false
      throw error
    }
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        sendSignal("SIGKILL")
      }
    }, shutdownGraceMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    if (!sendSignal("SIGTERM")) {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function terminateProcesses({ appIsQuitting = true, expectedExit = false } = {}) {
  if (appIsQuitting) {
    quitting = true
  }
  if (expectedExit) {
    expectedProcessExitDepth += 1
  }
  try {
    await Promise.all(Array.from(processes.values(), terminateChild))
  } finally {
    if (expectedExit) {
      expectedProcessExitDepth = Math.max(0, expectedProcessExitDepth - 1)
    }
  }
}

async function boot() {
  const port = await findPort(defaultPort)
  const apiBaseUrl = `http://${defaultHost}:${port}`
  currentApiBaseUrl = apiBaseUrl
  mainWindow = createWindow()
  loadStatusPage("Starting StemStudio", "Preparing the local audio workspace.")

  const env = processEnv(port)
  const apiProcess = startProcess("api", env)

  await waitForApi(apiBaseUrl, apiProcess)
  resetWorkerHeartbeat()
  const workerStartedAt = Date.now()
  const workerProcess = startProcess("worker", env)
  await waitForWorker(workerProcess, workerStartedAt)
  await loadRenderer()
}

async function handleBootFailure(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  const recovery = app.isPackaged
    ? "Reinstall StemStudio or rebuild the package, then reopen the app."
    : "Run npm run setup:local from the project root, then reopen the app."
  if (processes.size > 0) {
    await terminateProcesses({ appIsQuitting: false, expectedExit: true })
  }
  loadStatusPage("StemStudio could not start", recovery, message)
}

app.whenReady().then(() => {
  boot().catch(handleBootFailure)
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    boot().catch(handleBootFailure)
  }
})

app.on("window-all-closed", () => {
  app.quit()
})

app.on("before-quit", (event) => {
  if (terminating || processes.size === 0) return
  event.preventDefault()
  terminating = true
  terminateProcesses({ appIsQuitting: true }).finally(() => app.quit())
})
