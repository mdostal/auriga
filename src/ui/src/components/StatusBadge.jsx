import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Shared status -> Star Atlas pill-color mapping, used by every view that
// renders an epic or story status (EpicsListView's epic rows, EpicsListView's
// story rows, StoryDetailView). Matches the design reference's 4-state glyph
// legend: pending (unlit), planning (nebulous), in-progress (burning), done
// (fixed in the chart). Falls back to the pending treatment for any status
// value this dashboard doesn't explicitly know about, so an unrecognized
// value still renders instead of throwing.
const STATUS_STYLES = {
  done: 'text-star-done bg-star-done-soft border-transparent',
  'in-progress': 'text-star-progress bg-star-progress-soft border-transparent',
  pending: 'text-star-pending bg-star-pending-soft border-transparent',
  planning: 'text-star-planning bg-star-planning-soft border-transparent',
}

export default function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.pending
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-ui text-[11px] font-semibold uppercase tracking-wide rounded-full',
        style,
      )}
    >
      {status}
    </Badge>
  )
}
