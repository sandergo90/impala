import { Sidebar } from "./components/Sidebar";
import { CommitPanel } from "./components/CommitPanel";
import { DiffView } from "./components/DiffView";

function App() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <CommitPanel />
      <DiffView />
    </div>
  );
}

export default App;
