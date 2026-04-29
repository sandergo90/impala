import * as Sentry from "@sentry/react";
import { tanstackRouterBrowserTracingIntegration } from "@sentry/react";
import type { router as Router } from "../router";

const DSN = import.meta.env.VITE_SENTRY_DSN;
const RELEASE = `impala@${import.meta.env.VITE_APP_VERSION}`;
const ENVIRONMENT = import.meta.env.DEV ? "dev" : "production";

let initialised = false;

export function initSentry(router: typeof Router) {
  if (initialised) return;
  if (!DSN) return;
  initialised = true;

  Sentry.init({
    dsn: DSN,
    release: RELEASE,
    environment: ENVIRONMENT,
    sendDefaultPii: false,
    integrations: [
      tanstackRouterBrowserTracingIntegration(router),
      Sentry.consoleLoggingIntegration({ levels: ["info", "warn", "error"] }),
    ],
    tracesSampleRate: import.meta.env.DEV ? 1.0 : 0.1,
    _experiments: { enableLogs: true },
  });

  Sentry.setTag("runtime", "react-frontend");
}

export const SentryErrorBoundary = Sentry.ErrorBoundary;
