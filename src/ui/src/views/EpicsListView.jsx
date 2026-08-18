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
import { Badge } from '@/components/ui/badge'

// Maps an epic's derived `status` (see src/server/lib/read.mjs's
// deriveEpicStatus) to a shadcn Badge visual variant. Falls back to
// "outline" for any status this view doesn't explicitly know about, so an
// unrecognized value still renders instead of throwing.
const STATUS_VARIANTS = {
  done: 'default',
  'in-progress': 'secondary',
  pending: 'outline',
  planning: 'outline',
}

function StatusBadge({ status }) {
  const variant = STATUS_VARIANTS[status] || 'outline'
  return <Badge variant={variant}>{status}</Badge>
}

/**
 * Fetches GET /api/epics (src/server/index.mjs, backed by
 * src/server/lib/read.mjs's listEpics()) and renders the real epics found
 * under this repo's .pHive/epics/ — no fixture/mock data. Plain
 * fetch-on-mount + React state, no client-state library (per this story's
 * design decision — v1 is read-only with a handful of simple views).
 */
export default function EpicsListView() {
  const [epics, setEpics] = useState(null)
  const [error, setError] = useState(null)

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
                <TableRow key={epic.id}>
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
