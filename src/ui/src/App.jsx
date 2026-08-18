import { useState } from 'react'
import { cn } from '@/lib/utils'
import EpicsListView from '@/views/EpicsListView'
import StoryDetailView from '@/views/StoryDetailView'
import ActivityView from '@/views/ActivityView'

// Plain state-based navigation between the three top-level views (EpicsList,
// StoryDetail, Activity) — no client-side routing library. Per this story's
// design decision, a routing library is optional complexity a 3-view
// read-only v1 dashboard doesn't need; this still satisfies the acceptance
// criterion of navigating without a full page reload. StoryDetailView is
// reached only by drilling down from EpicsListView (epic -> its stories ->
// a story), not from the top nav, matching the story's flow.
function NavButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-sm px-2 py-1 rounded-md transition-colors',
        active
          ? 'font-semibold text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function App() {
  // { name: 'epics' } | { name: 'story', epicId, storyId } | { name: 'activity' }
  const [route, setRoute] = useState({ name: 'epics' })

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <header className="max-w-4xl mx-auto mb-6 text-left">
        <h1 className="text-2xl font-semibold tracking-tight">Auriga</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Read-only operator dashboard over this repo&apos;s .pHive/ state.
        </p>
        <nav className="flex gap-2 -ml-2">
          <NavButton active={route.name === 'epics'} onClick={() => setRoute({ name: 'epics' })}>
            Epics
          </NavButton>
          <NavButton active={route.name === 'activity'} onClick={() => setRoute({ name: 'activity' })}>
            Activity
          </NavButton>
        </nav>
      </header>

      {route.name === 'epics' && (
        <EpicsListView
          initialEpicId={route.epicId}
          onSelectStory={(epicId, storyId) => setRoute({ name: 'story', epicId, storyId })}
        />
      )}

      {route.name === 'story' && (
        <StoryDetailView
          epicId={route.epicId}
          storyId={route.storyId}
          // Back returns to THIS epic's drilled-in story list, not the
          // top-level epics list — carrying epicId forward is what lets
          // EpicsListView re-initialize its drill-down state instead of
          // resetting to the top level (see EpicsListView's initialEpicId).
          onBack={() => setRoute({ name: 'epics', epicId: route.epicId })}
        />
      )}

      {route.name === 'activity' && <ActivityView />}
    </div>
  )
}

export default App
