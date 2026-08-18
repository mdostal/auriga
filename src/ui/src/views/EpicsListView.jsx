import { useEffect, useState } from 'react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import StatusBadge from '@/components/StatusBadge'

/**
 * Fetches GET /api/epics (src/server/index.mjs, backed by
 * src/server/lib/read.mjs's listEpics()) and renders the real epics found
 * under this repo's .pHive/epics/ — no fixture/mock data. Plain
 * fetch-on-mount + React state, no client-state library (per this story's
 * design decision — v1 is read-only with a handful of simple views).
 *
 * Clicking an epic row drills into that epic's real stories (GET
 * /api/epics/:id, backed by getEpic()) in place — no separate top-level
 * "epic detail" view/route, per p3-story-detail-and-activity-views.yaml's
 * files_to_modify (only StoryDetailView/ActivityView/App are top-level
 * views). Clicking a story row calls onSelectStory(epicId, storyId), which
 * App.jsx wires to navigating to StoryDetailView.
 */
export default function EpicsListView({ onSelectStory }) {
  const [epics, setEpics] = useState(null)
  const [error, setError] = useState(null)

  const [selectedEpicId, setSelectedEpicId] = useState(null)
  const [epicDetail, setEpicDetail] = useState(null)
  const [epicError, setEpicError] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/epics')
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/epics failed: ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (!cancelled) setEpics(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedEpicId) {
      setEpicDetail(null)
      setEpicError(null)
      return
    }
    let cancelled = false
    setEpicDetail(null)
    setEpicError(null)
    fetch(`/api/epics/${encodeURIComponent(selectedEpicId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/epics/${selectedEpicId} failed: ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (!cancelled) setEpicDetail(data)
      })
      .catch((err) => {
        if (!cancelled) setEpicError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [selectedEpicId])

  if (selectedEpicId) {
    return (
      <Card className="w-full max-w-4xl mx-auto text-left">
        <CardHeader>
          <button
            type="button"
            onClick={() => setSelectedEpicId(null)}
            className="text-sm text-muted-foreground hover:text-foreground hover:underline w-fit"
          >
            ← Back to epics
          </button>
          <CardTitle>{epicDetail ? epicDetail.title : selectedEpicId}</CardTitle>
          <CardDescription className="font-mono text-xs">{selectedEpicId}</CardDescription>
        </CardHeader>
        <CardContent>
          {epicError && (
            <p className="text-sm text-destructive" role="alert">
              Failed to load epic: {epicError}
            </p>
          )}
          {!epicError && epicDetail === null && (
            <p className="text-sm text-muted-foreground">Loading stories…</p>
          )}
          {!epicError && epicDetail !== null && (!epicDetail.stories || epicDetail.stories.length === 0) && (
            <p className="text-sm text-muted-foreground">No stories found for this epic.</p>
          )}
          {!epicError && epicDetail !== null && epicDetail.stories && epicDetail.stories.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Story ID</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Complexity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {epicDetail.stories.map((story) => (
                  <TableRow
                    key={story.id}
                    className="cursor-pointer"
                    onClick={() => onSelectStory?.(selectedEpicId, story.id)}
                  >
                    <TableCell className="font-mono text-xs">{story.id}</TableCell>
                    <TableCell>{story.title}</TableCell>
                    <TableCell>
                      <StatusBadge status={story.status} />
                    </TableCell>
                    <TableCell>{story.complexity || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-4xl mx-auto text-left">
      <CardHeader>
        <CardTitle>Epics</CardTitle>
        <CardDescription>
          Live epic list from this repo&apos;s .pHive/epics/ state.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            Failed to load epics: {error}
          </p>
        )}
        {!error && epics === null && (
          <p className="text-sm text-muted-foreground">Loading epics…</p>
        )}
        {!error && epics !== null && epics.length === 0 && (
          <p className="text-sm text-muted-foreground">No epics found.</p>
        )}
        {!error && epics !== null && epics.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Epic ID</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Stories</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {epics.map((epic) => (
                <TableRow
                  key={epic.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedEpicId(epic.id)}
                >
                  <TableCell className="font-mono text-xs">{epic.id}</TableCell>
                  <TableCell>{epic.title}</TableCell>
                  <TableCell>
                    <StatusBadge status={epic.status} />
                  </TableCell>
                  <TableCell className="text-right">{epic.story_count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
