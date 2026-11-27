import { CaptureFailureError } from "./webdriver.ts";

export const CANARY_RULE =
  "127.0.0.1##.ubouf-canary:style(background-color: rgb(255, 0, 128) !important)";

export const CANARY_EXPECTED_COLOR = "rgb(255, 0, 128)";
export const CANARY_POLL_INTERVAL_MS = 500;
export const CANARY_TIMEOUT_MS = 10_000;

export interface CanaryDriver {
  navigate: (url: string) => Promise<void>;
  executeScript: <T>(script: string) => Promise<T>;
}

const CANARY_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ubouf canary</title></head>
<body>
<div class="ubouf-canary" style="width:16px;height:16px;background-color:rgb(0,0,0)"></div>
</body>
</html>`;

export interface CanaryServer {
  url: string;
  stop: () => void;
}

export function startCanaryServer(): CanaryServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/canary") {
        return new Response(CANARY_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/canary`,
    stop: () => {
      server.stop(true);
    },
  };
}

export interface VerifyCanaryOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function verifyCanary(
  driver: CanaryDriver,
  options: VerifyCanaryOptions = {},
): Promise<{ canaryMs: number; observedColor: string | null }> {
  const timeoutMs = options.timeoutMs ?? CANARY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? CANARY_POLL_INTERVAL_MS;
  const server = startCanaryServer();
  const startedAt = Date.now();

  try {
    await driver.navigate(server.url);
    const deadline = startedAt + timeoutMs;
    let observedColor: string | null = null;

    while (true) {
      observedColor = await driver.executeScript<string | null>(
        'const el = document.querySelector(".ubouf-canary"); return el ? getComputedStyle(el).backgroundColor : null;',
      );

      if (observedColor === CANARY_EXPECTED_COLOR) {
        return {
          canaryMs: Date.now() - startedAt,
          observedColor,
        };
      }

      if (Date.now() >= deadline) {
        break;
      }

      await Bun.sleep(pollIntervalMs);
    }

    throw new CaptureFailureError({
      kind: "UBO_LOAD_ERROR",
      message: `uBlock Origin canary rule did not apply within ${timeoutMs}ms (observed: ${String(observedColor)})`,
      finalUrl: server.url,
      httpStatus: 200,
      retryCount: 0,
      phaseTimingsMs: {
        canaryMs: Date.now() - startedAt,
        navigateMs: Date.now() - startedAt,
      },
    });
  } finally {
    server.stop();
  }
}
