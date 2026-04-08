import {
  createRouter,
  createRootRoute,
  createRoute,
  createHashHistory,
  redirect,
} from "@tanstack/react-router";
import { RootLayout } from "./App";
import { MainView } from "./views/MainView";
import { SettingsLayout } from "./routes/settings-layout";
import { AppearanceRoute } from "./routes/settings/appearance";
import { IntegrationsRoute } from "./routes/settings/integrations";
import { ProjectSettingsRoute } from "./routes/settings/project";
import { NotificationsRoute } from "./routes/settings/notifications";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MainView,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsLayout,
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/appearance" });
    }
  },
});

const settingsAppearanceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/appearance",
  component: AppearanceRoute,
});

const settingsIntegrationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/integrations",
  component: IntegrationsRoute,
});

const settingsNotificationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/notifications",
  component: NotificationsRoute,
});

export const projectSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/project/$projectId",
  component: ProjectSettingsRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  settingsRoute.addChildren([
    settingsAppearanceRoute,
    settingsIntegrationsRoute,
    settingsNotificationsRoute,
    projectSettingsRoute,
  ]),
]);

const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
