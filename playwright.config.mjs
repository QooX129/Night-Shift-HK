import { defineConfig, devices } from "@playwright/test";
const python = process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:8765",
    trace: { mode: "retain-on-failure", screenshots: false },
    // Headless Chromium otherwise uses SwiftShader instead of the Windows GPU.
    launchOptions: { args: process.platform === "win32" ? ["--use-angle=d3d11"] : [] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command: `"${python}" -m uvicorn app:app --host 127.0.0.1 --port 8765`,
    url: "http://127.0.0.1:8765/api/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
