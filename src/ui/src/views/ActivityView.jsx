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
    <li className="relative pb-4 last:pb-0 pl-6 before:content-[''] before:absolute before:left-0 before:top-[7px] before:w-[9px] before:h-[9px] before:rounded-full before:bg-void before:border-2 before:border-star-done">
      <div className="flex items-start gap-3 rounded-md border border-hairline bg-plate px-4 py-3">
        <Badge
          variant="outline"
          className="mt-0.5 shrink-0 font-mono text-[10px] uppercase tracking-wider text-star-done border-transparent bg-star-done-soft"
        >
          commit
        </Badge>
        <div className="min-w-0">
          <p className="text-sm text-ink-1">{item.subject}</p>
          <p className="text-xs text-ink-3 mt-1">
            <span className="font-mono text-ink-1 bg-panel border border-hairline rounded px-1.5 py-0.5">
              {(item.hash || '').slice(0, 7)}
            </span>
            {' · '}
            {formatTime(item.date)}
          </p>
        </div>
      </div>
    </li>
  )
}

function AuditRow({ item }) {
  return (
    <li className="relative pb-4 last:pb-0 pl-6 before:content-[''] before:absolute before:left-0 before:top-[7px] before:w-[9px] before:h-[9px] before:rounded-full before:bg-star-planning before:border-2 before:border-star-planning">
      <div className="flex items-start gap-3 rounded-md border border-star-planning/35 bg-star-planning-soft px-4 py-3">
        <Badge
          variant="secondary"
          className="mt-0.5 shrink-0 font-mono text-[10px] uppercase tracking-wider text-star-planning border-transparent bg-transparent"
        >
          audit
        </Badge>
        <div className="min-w-0">
          <p className="text-sm text-ink-1 font-mono">
            {item.run_id || item.file}
            {item.skill && <span className="text-ink-3"> · {item.skill}</span>}
          </p>
          <p className="text-xs text-ink-3 mt-1">{formatTime(item.timestamp)}</p>
          {item.work_artifacts && (() => {
            // Every work_artifacts field is independently optional — build the
            // summary as a joined list of only the fragments actually present,
            // rather than string-concatenating a leading ", " onto later
            // fragments under the assumption `commits` always renders first
            // (it doesn't; any subset of these three fields can be present).
            const fragments = [
              item.work_artifacts.commits != null && `${item.work_artifacts.commits} commits`,
              item.work_artifacts.files_changed != null && `${item.work_artifacts.files_changed} files changed`,
              item.work_artifacts.tests_passing != null && `${item.work_artifacts.tests_passing} tests passing`,
            ].filter(Boolean)
            return fragments.length > 0 ? (
              <p className="text-xs text-star-planning mt-2 flex flex-wrap gap-1.5">
                {fragments.map((f) => (
                  <span key={f} className="font-mono bg-star-planning-soft border border-star-planning/30 rounded-full px-2 py-0.5">
                    {f}
                  </span>
                ))}
              </p>
            ) : null
          })()}
        </div>
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
        <p className="font-ui text-[11px] tracking-[0.14em] uppercase text-capella mb-1">Plate III · Observation Log</p>
        <CardTitle className="text-2xl">Activity</CardTitle>
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
          <p className="text-sm text-ink-2">Loading activity…</p>
        )}
        {!error && activity !== null && activity.length === 0 && (
          <p className="text-sm text-ink-2">No activity found.</p>
        )}
        {!error && activity !== null && activity.length > 0 && (
          <ul className="relative before:content-[''] before:absolute before:left-[5px] before:top-1.5 before:bottom-1.5 before:w-px before:bg-hairline">
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
