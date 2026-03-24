function App() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <div className="w-56 border-r p-4">Sidebar</div>
      <div className="w-64 border-r p-4">Commits</div>
      <div className="flex-1 p-4">Diff View</div>
    </div>
  );
}

export default App;
