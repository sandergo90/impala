import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const host = "127.0.0.1";
const previewPort = 4179;
const previewUrl = `http://${host}:${previewPort}/`;
const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const waitFor = async (probe, timeoutMs, description) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
};

const stop = async (process) => {
  if (process.exitCode !== null) return;

  process.kill("SIGTERM");
  await Promise.race([
    once(process, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
};

const profilePath = await mkdtemp(path.join(tmpdir(), "impala-bundle-check-"));
const preview = spawn(
  "bunx",
  ["vite", "preview", "--host", host, "--port", String(previewPort)],
  { cwd: path.resolve(import.meta.dirname, ".."), stdio: "ignore" },
);

let chrome;

try {
  await waitFor(
    async () => (await fetch(previewUrl)).ok,
    10_000,
    "the Vite preview server",
  );

  chrome = spawn(
    chromePath,
    [
      "--headless",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profilePath}`,
      "--remote-debugging-port=0",
      previewUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let chromeOutput = "";
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    chromeOutput += chunk;
  });

  const debuggerUrl = await waitFor(() => {
    const match = chromeOutput.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    return match?.[1];
  }, 10_000, "Chrome DevTools");

  const debuggerPort = new URL(debuggerUrl).port;
  const page = await waitFor(async () => {
    const targets = await (
      await fetch(`http://${host}:${debuggerPort}/json/list`)
    ).json();
    return targets.find(
      (target) => target.type === "page" && target.url === previewUrl,
    );
  }, 10_000, "the Impala page target");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const exceptions = [];
  let requestId = 0;
  const pending = new Map();

  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails);
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++requestId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  const rootMounted = await waitFor(async () => {
    const response = await send("Runtime.evaluate", {
      expression: "document.getElementById('root')?.childElementCount ?? 0",
      returnByValue: true,
    });
    return response.result.result.value > 0;
  }, 5_000, "the production bundle to mount into #root").catch(() => false);

  socket.close();

  if (!rootMounted) {
    const details = exceptions
      .map(
        ({ exception, text, url, lineNumber, columnNumber }) =>
          exception?.description ??
          `${text} at ${url}:${lineNumber + 1}:${columnNumber + 1}`,
      )
      .join("\n");
    throw new Error(
      `Production bundle did not mount into #root${details ? `:\n${details}` : ""}`,
    );
  }

  console.log("Production bundle mounted into #root");
} finally {
  await stop(preview);
  if (chrome) await stop(chrome);
  await rm(profilePath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
