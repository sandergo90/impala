import {
  createRouter,
  createRootRoute,
  createRoute,
  createHashHistory,
} from "@tanstack/react-router";
import { RootLayout } from "./App";
import { MainView } from "./views/MainView";
import { SettingsLayout } from "./views/SettingsLayout";

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
});

const routeTree = rootRoute.addChildren([indexRoute, settingsRoute]);

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
