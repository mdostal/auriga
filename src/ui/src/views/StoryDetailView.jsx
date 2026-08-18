import { useEffect, useState } from 'react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import StatusBadge from '@/components/StatusBadge'

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
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground hover:underline w-fit"
        >
          ← Back to {epicId}
        </button>
        <CardTitle>{story ? story.title : storyId}</CardTitle>
        <CardDescription className="font-mono text-xs">{storyId}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
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
          <p className="text-sm text-muted-foreground">Loading story…</p>
        )}

        {story && (
          <>
            <section className="flex flex-wrap items-center gap-2">
              <StatusBadge status={story.status || 'pending'} />
              {story.complexity && (
                <span className="text-xs text-muted-foreground">complexity: {story.complexity}</span>
              )}
              {story.methodology && (
                <span className="text-xs text-muted-foreground">methodology: {story.methodology}</span>
              )}
            </section>

            {story.description && (
              <section>
                <h3 className="text-sm font-semibold mb-1">Description</h3>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{story.description}</p>
              </section>
            )}

            <section>
              <h3 className="text-sm font-semibold mb-1">Dependencies</h3>
              {Array.isArray(story.depends_on) && story.depends_on.length > 0 ? (
                <ul className="list-disc list-inside text-sm text-muted-foreground">
                  {story.depends_on.map((dep) => (
                    <li key={dep} className="font-mono text-xs">{dep}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None</p>
              )}
            </section>

            <section>
              <h3 className="text-sm font-semibold mb-1">Acceptance Criteria</h3>
              {Array.isArray(story.acceptance_criteria) && story.acceptance_criteria.length > 0 ? (
                <ul className="list-disc list-inside text-sm space-y-1">
                  {story.acceptance_criteria.map((ac, i) => (
                    <li key={i}>{ac}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None</p>
              )}
            </section>

            <section>
              <h3 className="text-sm font-semibold mb-1">Cross-Cutting</h3>
              {Array.isArray(story.cross_cutting) && story.cross_cutting.length > 0 ? (
                <ul className="text-sm space-y-2">
                  {story.cross_cutting.map((cc, i) => (
                    <li key={i}>
                      <span className="font-medium">{cc.concern}</span>
                      {cc.action && (
                        <p className="text-muted-foreground">{cc.action}</p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None</p>
              )}
            </section>

            {Array.isArray(story.risks) && story.risks.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold mb-1">Risks</h3>
                <ul className="text-sm space-y-2">
                  {story.risks.map((risk, i) => (
                    <li key={i}>
                      {risk.severity && (
                        <span className="uppercase text-xs font-semibold text-muted-foreground mr-2">
                          {risk.severity}
                        </span>
                      )}
                      <span>{risk.description}</span>
                      {risk.mitigation && (
                        <p className="text-muted-foreground">Mitigation: {risk.mitigation}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {Array.isArray(story.references) && story.references.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold mb-1">References</h3>
                <ul className="text-sm space-y-1">
                  {story.references.map((ref, i) => (
                    <li key={i} className="font-mono text-xs text-muted-foreground">{ref.path}</li>
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
