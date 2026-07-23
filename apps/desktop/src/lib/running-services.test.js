import { beforeEach, describe, expect, test } from "bun:test";

const persisted = new Map();
globalThis.localStorage = {
  getItem: (key) => persisted.get(key) ?? null,
  setItem: (key, value) => persisted.set(key, value),
  removeItem: (key) => persisted.delete(key),
  clear: () => persisted.clear(),
  key: (index) => [...persisted.keys()][index] ?? null,
  get length() {
    return persisted.size;
  },
};
globalThis.window = globalThis;

const { useDataStore, useUIStore } = await import("../store.ts");
const { panePtySessionId } = await import("./pane-ids.ts");
const { focusServiceTerminal, runningServiceUrl } = await import("./running-services.ts");

const worktree = {
  path: "/tmp/running-services-worktree",
  branch: "main",
  head_commit: "abc",
  title: null,
};

const service = (sessionId) => ({
  port: 3000,
  address: "*",
  pid: 42,
  processName: "node",
  worktreePath: worktree.path,
  sessionId,
  managed: true,
});

beforeEach(() => {
  useUIStore.setState({ worktreeNavStates: {} });
  useDataStore.setState({
    worktreeDataStates: {},
    generalTerminalPaneSessions: {},
  });
});

describe("focusServiceTerminal", () => {
  test("reconstructs the persisted Agent pane session after an app restart", () => {
    const target = focusServiceTerminal(
      service(panePtySessionId(worktree.path, "tab-agent")),
      [worktree],
    );
    expect(target).toEqual({ kind: "worktree", worktree });
    const nav = useUIStore.getState().getWorktreeNavState(worktree.path);
    expect(nav.activeTab).toBe("terminal");
    expect(nav.activeTerminalsTab).toBe("tab-agent");
  });

  test("finds a service owned by the general terminal", () => {
    const pane = {
      id: "general-group",
      type: "group",
      tabs: [
        {
          id: "general-pane",
          label: "Terminal",
          content: { kind: "terminal", launch: "shell" },
          createdAt: 1,
        },
      ],
      activeTabId: "general-pane",
    };
    useUIStore.setState({ generalTerminalSplitTree: pane });
    useDataStore.setState({
      generalTerminalPaneSessions: { "general-pane": "general-session" },
    });

    expect(focusServiceTerminal(service("general-session"), [worktree])).toEqual({
      kind: "general",
    });
    expect(useUIStore.getState().generalTerminalFocusedPaneId).toBe("general-group");
  });
});

describe("runningServiceUrl", () => {
  test("uses localhost for wildcard listeners and preserves explicit interfaces", () => {
    expect(runningServiceUrl({ ...service(null), address: "*" })).toBe(
      "http://localhost:3000",
    );
    expect(runningServiceUrl({ ...service(null), address: "192.168.1.20" })).toBe(
      "http://192.168.1.20:3000",
    );
    expect(runningServiceUrl({ ...service(null), address: "fe80::1" })).toBe(
      "http://[fe80::1]:3000",
    );
  });
});
