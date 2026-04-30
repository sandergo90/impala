import * as Sentry from "@sentry/react";
import type { router as Router } from "../router";

const DSN = import.meta.env.VITE_SENTRY_DSN;
const RELEASE = `impala@${import.meta.env.VITE_APP_VERSION}`;
const ENVIRONMENT = import.meta.env.DEV ? "dev" : "production";

let initialised = false;

export function initSentry(router: typeof Router) {
  if (initialised) return;
  if (!DSN) {
    console.info("[sentry] disabled: VITE_SENTRY_DSN not set at build time");
    return;
  }
  initialised = true;

  Sentry.init({
    dsn: DSN,
    release: RELEASE,
    environment: ENVIRONMENT,
    sendDefaultPii: false,
    integrations: [
      Sentry.tanstackRouterBrowserTracingIntegration(router),
      Sentry.consoleLoggingIntegration({ levels: ["info", "warn", "error"] }),
    ],
    tracesSampleRate: import.meta.env.DEV ? 1.0 : 0.1,
    enableLogs: true,
  });

  Sentry.setTag("runtime", "react-frontend");
  console.info(`[sentry] enabled (release=${RELEASE}, env=${ENVIRONMENT})`);
}

export const SentryErrorBoundary = Sentry.ErrorBoundary;
