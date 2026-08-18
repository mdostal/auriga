import { useEffect, useState } from 'react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function CommitRow({ item }) {
  return (
    <li className="flex items-start gap-3 py-2 border-b last:border-b-0">
      <Badge variant="outline" className="mt-0.5 shrink-0">commit</Badge>
      <div className="min-w-0">
        <p className="text-sm">{item.subject}</p>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{(item.hash || '').slice(0, 7)}</span>
          {' · '}
          {formatTime(item.date)}
        </p>
      </div>
    </li>
  )
}

function AuditRow({ item }) {
  return (
    <li className="flex items-start gap-3 py-2 border-b last:border-b-0">
      <Badge variant="secondary" className="mt-0.5 shrink-0">audit</Badge>
      <div className="min-w-0">
        <p className="text-sm">
          {item.run_id || item.file}
          {item.skill && <span className="text-muted-foreground"> · {item.skill}</span>}
        </p>
        <p className="text-xs text-muted-foreground">{formatTime(item.timestamp)}</p>
        {item.work_artifacts && (
          <p className="text-xs text-muted-foreground">
            {item.work_artifacts.commits != null && `${item.work_artifacts.commits} commits`}
            {item.work_artifacts.files_changed != null && `, ${item.work_artifacts.files_changed} files changed`}
            {item.work_artifacts.tests_passing != null && `, ${item.work_artifacts.tests_passing} tests passing`}
          </p>
        )}
      </div>
    </li>
  )
}

/**
 * Fetches GET /api/activity (src/server/index.mjs, backed by
 * src/server/lib/read.mjs's listActivity()) and renders it as a single
 * chronological feed — real git commits from this repo's own git log merged
 * with real .pHive/audits/post-run/*.yaml records, already sorted most-recent
 * first by the read layer. Plain fetch-on-mount + React state, matching
 * EpicsListView's established pattern.
 */
export default function ActivityView() {
  const [activity, setActivity] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/activity')
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/activity failed: ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (!cancelled) setActivity(data)
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
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          Real git commits merged with post-run audit records, most recent first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            Failed to load activity: {error}
          </p>
        )}
        {!error && activity === null && (
          <p className="text-sm text-muted-foreground">Loading activity…</p>
        )}
        {!error && activity !== null && activity.length === 0 && (
          <p className="text-sm text-muted-foreground">No activity found.</p>
        )}
        {!error && activity !== null && activity.length > 0 && (
          <ul>
            {activity.map((item, i) => (
              item.type === 'audit'
                ? <AuditRow key={`audit-${item.file || i}`} item={item} />
                : <CommitRow key={`commit-${item.hash || i}`} item={item} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
