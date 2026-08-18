import { useEffect, useState } from 'react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import StatusBadge from '@/components/StatusBadge'
import DependencyConstellation from '@/components/DependencyConstellation'

/**
 * Fetches GET /api/epics/:epicId/stories/:storyId (src/server/index.mjs,
 * backed by src/server/lib/read.mjs's getStory()) and renders that story's
 * REAL YAML content — acceptance criteria, cross_cutting (concern + action),
 * status, and dependencies, per this story's acceptance criteria. getStory()
 * returns the full parsed story YAML as-is, so every field below is read
 * directly off the fetched object, never truncated/summarized.
 *
 * Real story YAMLs vary a lot in richness (see p2-router-cutover.yaml vs.
 * p3-dashboard-hardening.yaml) — every optional section below is guarded so
 * a minimal story still renders cleanly instead of throwing.
 */
export default function StoryDetailView({ epicId, storyId, onBack }) {
  const [story, setStory] = useState(null)
  const [error, setError] = useState(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false
    setStory(null)
    setError(null)
    setNotFound(false)
    fetch(`/api/epics/${encodeURIComponent(epicId)}/stories/${encodeURIComponent(storyId)}`)
      .then((res) => {
        if (res.status === 404) {
          if (!cancelled) setNotFound(true)
          return null
        }
        if (!res.ok) throw new Error(`GET story failed: ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (!cancelled && data) setStory(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [epicId, storyId])

  return (
    <Card className="w-full max-w-4xl mx-auto text-left">
      <CardHeader>
        <p className="font-mono text-xs text-ink-3 flex items-center gap-2 mb-2">
          <span>{epicId}</span>
          <span className="text-hairline">›</span>
          <span className="text-capella">{storyId}</span>
        </p>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-ink-3 hover:text-capella hover:underline w-fit"
        >
          ← Back to {epicId}
        </button>
        <CardTitle className="text-2xl max-w-[32ch] mt-1">{story ? story.title : storyId}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-8">
        {error && (
          <p className="text-sm text-destructive" role="alert">
            Failed to load story: {error}
          </p>
        )}
        {notFound && (
          <p className="text-sm text-destructive" role="alert">
            Story not found.
          </p>
        )}
        {!error && !notFound && story === null && (
          <p className="text-sm text-ink-2">Loading story…</p>
        )}

        {story && (
          <>
            <section className="flex flex-wrap items-center gap-2">
              <StatusBadge status={story.status || 'pending'} />
              {story.complexity && (
                <span className="text-xs font-mono text-ink-3 border border-hairline rounded-full px-3 py-1">
                  complexity: {story.complexity}
                </span>
              )}
              {story.methodology && (
                <span className="text-xs font-mono text-ink-2 border border-hairline rounded-full px-3 py-1">
                  method · {story.methodology}
                </span>
              )}
            </section>

            {story.description && (
              <section>
                <p className="text-[11px] tracking-[0.14em] uppercase text-ink-3 mb-2">Log entry</p>
                <div className="rounded-md border border-hairline border-l-2 border-l-capella-line bg-plate px-5 py-4">
                  <p className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">{story.description}</p>
                </div>
              </section>
            )}

            <section>
              <h3 className="text-[11px] tracking-[0.14em] uppercase text-ink-3 mb-2">Dependencies</h3>
              {Array.isArray(story.depends_on) && story.depends_on.length > 0 ? (
                <div className="rounded-md border border-hairline bg-panel px-5 py-4 overflow-x-auto">
                  <p className="text-[11px] tracking-[0.14em] uppercase text-ink-3 mb-1">Dependency constellation</p>
                  <DependencyConstellation storyId={storyId} status={story.status} dependsOn={story.depends_on} />
                </div>
              ) : (
                <p className="text-sm text-ink-2">None</p>
              )}
            </section>

            <section>
              <h3 className="text-[11px] tracking-[0.14em] uppercase text-ink-3 mb-2">Acceptance Criteria</h3>
              {Array.isArray(story.acceptance_criteria) && story.acceptance_criteria.length > 0 ? (
                <ul className="flex flex-col gap-2.5">
                  {story.acceptance_criteria.map((ac, i) => (
                    <li
                      key={i}
                      className="flex gap-3 items-start rounded-md border border-hairline bg-plate px-4 py-3 text-sm text-ink-2 leading-relaxed"
                    >
                      <svg viewBox="0 0 24 24" className="w-[18px] h-[18px] mt-0.5 shrink-0">
                        <circle cx="12" cy="12" r="11" fill="none" stroke="var(--star-done)" strokeWidth="1.4" />
                        <path
                          d="M7 12.5 L10.3 16 L17 8.5"
                          fill="none"
                          stroke="var(--star-done)"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span>{ac}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-2">None</p>
              )}
            </section>

            <section>
              <h3 className="text-[11px] tracking-[0.14em] uppercase text-ink-3 mb-2">Cross-Cutting</h3>
              {Array.isArray(story.cross_cutting) && story.cross_cutting.length > 0 ? (
                <div className="rounded-md border border-star-planning/35 bg-star-planning-soft px-5 py-4 space-y-3">
                  {story.cross_cutting.map((cc, i) => (
                    <div key={i}>
                      <p className="text-[11px] tracking-[0.12em] uppercase text-star-planning font-semibold mb-1">
                        {cc.concern}
                      </p>
                      {cc.action && (
                        <p className="text-sm text-ink-2 leading-relaxed">{cc.action}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-2">None</p>
              )}
            </section>

            {Array.isArray(story.risks) && story.risks.length > 0 && (
              <section>
                <h3 className="text-[11px] tracking-[0.14em] uppercase text-ink-3 mb-2">Risks</h3>
                <ul className="space-y-3">
                  {story.risks.map((risk, i) => (
                    <li
                      key={i}
                      className="rounded-md border border-nova-high/40 border-l-[3px] border-l-nova-high bg-nova-high-soft px-5 py-4"
                    >
                      {risk.severity && (
                        <p className="text-[11px] tracking-[0.12em] uppercase text-nova-high font-semibold mb-1.5">
                          {risk.severity} severity
                        </p>
                      )}
                      <p className="text-sm text-ink-2 leading-relaxed">{risk.description}</p>
                      {risk.mitigation && (
                        <p className="text-sm text-ink-2 leading-relaxed mt-1">
                          <span className="text-nova-low font-semibold text-xs uppercase tracking-wide mr-1.5">
                            Mitigation
                          </span>
                          {risk.mitigation}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {Array.isArray(story.references) && story.references.length > 0 && (
              <section>
                <h3 className="text-[11px] tracking-[0.14em] uppercase text-ink-3 mb-2">References</h3>
                <ul className="text-sm space-y-1">
                  {story.references.map((ref, i) => (
                    <li key={i} className="font-mono text-xs text-ink-3">{ref.path}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
