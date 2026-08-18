import EpicsListView from '@/views/EpicsListView'

function App() {
  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <header className="max-w-4xl mx-auto mb-6 text-left">
        <h1 className="text-2xl font-semibold tracking-tight">Auriga</h1>
        <p className="text-sm text-muted-foreground">
          Read-only operator dashboard over this repo&apos;s .pHive/ state.
        </p>
      </header>
      <EpicsListView />
    </div>
  )
}

export default App
