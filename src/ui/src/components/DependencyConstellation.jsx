// Renders a story's `depends_on` as a constellation diagram — a center
// "star" (this story) connected by dashed lines to one star per dependency
// — matching the design reference's "Plate II: Star Chart Detail" treatment
// (design-concept-b-celestial.html's .dep-diagram). The reference's markup
// hardcodes exactly two dependency nodes at fixed coordinates; this instead
// lays out however many `dependsOn` entries exist. Each dependency slot's
// width grows with its label length (roughly matching monospace character
// width) so long story ids don't collide, and the SVG's own viewBox grows
// with the total width instead of squeezing nodes together — the enclosing
// StoryDetailView wraps this in an overflow-x-auto container so a long row
// of many dependencies scrolls rather than overlapping.
//
// We only know the CURRENT story's status (passed in as `status`) — the
// read layer's getStory() doesn't resolve each dependency id's own status,
// so dependency nodes are rendered in a neutral, unlit tone rather than
// guessing/asserting they're "done".
const STATUS_NODE_COLOR = {
  done: 'var(--star-done)',
  'in-progress': 'var(--star-progress)',
  pending: 'var(--star-pending)',
  planning: 'var(--star-planning)',
}

const CHAR_WIDTH = 6.4
const MIN_SLOT = 118
const NODE_R = 4.5
const CENTER_R = 7
// Vertical layout matches the design reference's own .dep-diagram viewBox
// (0 0 400 170, top nodes at y=46, center node at y=120) exactly — only the
// WIDTH grows with the dependency count; the vertical rhythm (room for a
// two-line label above each top node and a two-line label below the center
// node) stays fixed regardless of how many dependencies there are.
const TOP_Y = 46
const CENTER_Y = 120
const HEIGHT = 170

export default function DependencyConstellation({ storyId, status, dependsOn }) {
  const deps = Array.isArray(dependsOn) ? dependsOn : []
  if (deps.length === 0) return null

  const slotWidths = deps.map((d) => Math.max(MIN_SLOT, d.length * CHAR_WIDTH + 28))
  const totalWidth = slotWidths.reduce((a, b) => a + b, 0)
  const height = HEIGHT
  const centerX = totalWidth / 2
  const centerY = CENTER_Y

  let cursor = 0
  const positions = slotWidths.map((w) => {
    const x = cursor + w / 2
    cursor += w
    return x
  })

  const centerColor = STATUS_NODE_COLOR[status] || STATUS_NODE_COLOR.pending
  const depColor = 'var(--ink-3)'

  return (
    <svg
      viewBox={`0 0 ${totalWidth} ${height}`}
      className="dep-diagram w-full h-auto"
      style={{ minWidth: `${Math.max(totalWidth, 320)}px` }}
      role="img"
      aria-label={`Dependency constellation: ${storyId} depends on ${deps.join(', ')}`}
    >
      {positions.map((x, i) => (
        <line
          key={`link-${deps[i]}`}
          x1={centerX}
          y1={centerY}
          x2={x}
          y2={TOP_Y}
          stroke="var(--capella-line)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
      ))}

      <circle cx={centerX} cy={centerY} r={CENTER_R} fill={centerColor} />
      {positions.map((x, i) => (
        <circle key={`node-${deps[i]}`} cx={x} cy={TOP_Y} r={NODE_R} fill={depColor} opacity="0.9" />
      ))}

      <text
        x={centerX}
        y={centerY + 25}
        textAnchor="middle"
        className="font-mono"
        style={{ fontSize: '9.5px', fill: 'var(--ink-1)', fontWeight: 600 }}
      >
        {storyId}
      </text>
      <text
        x={centerX}
        y={centerY + 38}
        textAnchor="middle"
        className="font-ui uppercase"
        style={{ fontSize: '8px', letterSpacing: '0.08em', fill: centerColor }}
      >
        this story
      </text>

      {positions.map((x, i) => (
        <text
          key={`lbl-${deps[i]}`}
          x={x}
          y={TOP_Y - 16}
          textAnchor="middle"
          className="font-mono"
          style={{ fontSize: '9.5px', fill: 'var(--ink-2)' }}
        >
          {deps[i]}
        </text>
      ))}
      {positions.map((x, i) => (
        <text
          key={`tag-${deps[i]}`}
          x={x}
          y={TOP_Y - 28}
          textAnchor="middle"
          className="font-ui uppercase"
          style={{ fontSize: '8px', letterSpacing: '0.08em', fill: 'var(--ink-3)' }}
        >
          dependency
        </text>
      ))}
    </svg>
  )
}
