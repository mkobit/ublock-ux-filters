import { createServer } from "node:net";
import type { BrowserSession } from "./session.ts";

export const NAVIGATION_TIMEOUT_MS = 30_000;
export const WAIT_FOR_TIMEOUT_MS = 10_000;
export const MAX_RETRIES = 2;
export const RETRY_BACKOFF_MS = [1000, 3000] as const;

export const VIEWPORT_WIDTH = 1440;
export const VIEWPORT_HEIGHT = 900;

export type ErrorKind =
  | "UBO_LOAD_ERROR"
  | "BOT_CHALLENGE"
  | "HTTP_ERROR"
  | "NAVIGATION_TIMEOUT"
  | "SELECTOR_TIMEOUT";

export interface PhaseTimingsMs {
  canaryMs?: number;
  navigateMs: number;
  waitMs?: number;
}

export interface CaptureError {
  kind: ErrorKind;
  message: string;
  finalUrl: string;
  httpStatus: number | null;
  retryCount: number;
  phaseTimingsMs: PhaseTimingsMs;
  failureScreenshotPath?: string;
}

export class CaptureFailureError extends Error {
  readonly captureError: CaptureError;

  constructor(captureError: CaptureError) {
    super(captureError.message);
    this.name = "CaptureFailureError";
    this.captureError = captureError;
  }
}

const BOT_CHALLENGE_PATTERN = /captcha|verify you are human|access denied|attention required/i;

export interface ClassificationInput {
  httpStatus: number | null;
  title?: string;
  bodyText?: string;
  timedOutPhase?: "navigation" | "selector";
  message?: string;
}

export function classifyNavigationFailure(
  input: ClassificationInput,
): { kind: ErrorKind; message: string } | null {
  if (input.timedOutPhase === "navigation") {
    return {
      kind: "NAVIGATION_TIMEOUT",
      message: input.message ?? "Navigation timed out",
    };
  }

  if (input.timedOutPhase === "selector") {
    return {
      kind: "SELECTOR_TIMEOUT",
      message: input.message ?? "Selector wait timed out",
    };
  }

  const { httpStatus, title = "", bodyText = "" } = input;
  if (httpStatus === 403 || httpStatus === 429 || httpStatus === 503) {
    return {
      kind: "BOT_CHALLENGE",
      message: input.message ?? `Bot challenge detected (HTTP ${httpStatus})`,
    };
  }

  if (BOT_CHALLENGE_PATTERN.test(title) || BOT_CHALLENGE_PATTERN.test(bodyText)) {
    return {
      kind: "BOT_CHALLENGE",
      message: input.message ?? "Bot challenge detected in page content",
    };
  }

  if (httpStatus !== null && httpStatus >= 400) {
    return {
      kind: "HTTP_ERROR",
      message: input.message ?? `HTTP error ${httpStatus}`,
    };
  }

  return null;
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate ephemeral port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForGeckodriverReady(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/status`);
      if (response.ok) {
        return;
      }
    } catch {
      // Geckodriver is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`geckodriver did not become ready within ${timeoutMs}ms`);
}

interface WebDriverResponse<T> {
  value: T;
}

interface WebDriverErrorValue {
  error?: string;
  message?: string;
}

export interface WebDriverLaunchOptions {
  geckodriverBin: string;
  session: BrowserSession;
  headless?: boolean;
}

export class WebDriverClient {
  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly process: Bun.Subprocess;
  private closed = false;

  private constructor(baseUrl: string, sessionId: string, proc: Bun.Subprocess) {
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;
    this.process = proc;
  }

  static async launch(options: WebDriverLaunchOptions): Promise<WebDriverClient> {
    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const headless = options.headless ?? true;

    const proc = Bun.spawn([options.geckodriverBin, "--host", "127.0.0.1", "--port", String(port)], {
      env: options.session.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    options.session.trackChild(proc);

    try {
      await waitForGeckodriverReady(baseUrl);

      const firefoxArgs = headless
        ? ["-headless", "--no-remote", "-profile", options.session.profileDir]
        : ["--no-remote", "-profile", options.session.profileDir];

      const sessionResponse = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capabilities: {
            alwaysMatch: {
              browserName: "firefox",
              "moz:firefoxOptions": {
                binary: options.session.firefoxBin,
                args: firefoxArgs,
              },
            },
          },
        }),
      });

      const sessionJson = (await sessionResponse.json()) as WebDriverResponse<
        { sessionId?: string } & WebDriverErrorValue
      >;
      if (!sessionResponse.ok || !sessionJson.value.sessionId) {
        throw new Error(
          `Failed to create WebDriver session: ${sessionJson.value.message ?? sessionResponse.statusText}`,
        );
      }

      const client = new WebDriverClient(baseUrl, sessionJson.value.sessionId, proc);
      await client.setTimeouts(NAVIGATION_TIMEOUT_MS);
      await client.setViewportSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
      return client;
    } catch (error) {
      proc.kill("SIGTERM");
      throw error;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/session/${this.sessionId}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json()) as WebDriverResponse<T & WebDriverErrorValue>;
    if (!response.ok) {
      const errName = json.value?.error ?? "webdriver error";
      const errMsg = json.value?.message ?? response.statusText;
      throw new Error(`${errName}: ${errMsg}`);
    }
    return json.value;
  }

  async setTimeouts(pageLoadMs: number): Promise<void> {
    await this.request("POST", "/timeouts", { pageLoad: pageLoadMs });
  }

  async setViewportSize(targetWidth: number, targetHeight: number): Promise<void> {
    await this.request("POST", "/window/rect", { width: targetWidth, height: targetHeight });
    const chromeDelta = await this.executeScript<{ dw: number; dh: number }>(
      "return { dw: window.outerWidth - window.innerWidth, dh: window.outerHeight - window.innerHeight };",
    );
    if (chromeDelta.dw !== 0 || chromeDelta.dh !== 0) {
      await this.request("POST", "/window/rect", {
        width: targetWidth + chromeDelta.dw,
        height: targetHeight + chromeDelta.dh,
      });
    }
  }

  async navigate(url: string): Promise<void> {
    await this.request("POST", "/url", { url });
  }

  async getCurrentUrl(): Promise<string> {
    return await this.request<string>("GET", "/url");
  }

  async getTitle(): Promise<string> {
    return await this.request<string>("GET", "/title");
  }

  async executeScript<T>(script: string, args: unknown[] = []): Promise<T> {
    return await this.request<T>("POST", "/execute/sync", { script, args });
  }

  async getHttpStatus(): Promise<number | null> {
    return await this.executeScript<number | null>(
      'const nav = performance.getEntriesByType("navigation")[0]; return nav && typeof nav.responseStatus === "number" ? nav.responseStatus : null;',
    );
  }

  async waitForSelector(selector: string, timeoutMs = WAIT_FOR_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const found = await this.executeScript<boolean>(
        "return document.querySelector(arguments[0]) !== null;",
        [selector],
      );
      if (found) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Selector ${selector} not found within ${timeoutMs}ms`);
      }
      await Bun.sleep(250);
    }
  }

  async takeScreenshot(): Promise<Uint8Array> {
    const base64 = await this.request<string>("GET", "/screenshot");
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.request("DELETE", "");
    } catch {
      // Ignore errors when session has already closed.
    }
    try {
      this.process.kill("SIGTERM");
    } catch {
      // Ignore if geckodriver already exited.
    }
  }
}
