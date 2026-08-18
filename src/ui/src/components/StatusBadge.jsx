import { Badge } from '@/components/ui/badge'

// Shared status -> shadcn Badge variant mapping, used by every view that
// renders an epic or story status (EpicsListView's epic rows, EpicsListView's
// story rows, StoryDetailView). Falls back to "outline" for any status value
// this dashboard doesn't explicitly know about, so an unrecognized value
// still renders instead of throwing.
const STATUS_VARIANTS = {
  done: 'default',
  'in-progress': 'secondary',
  pending: 'outline',
  planning: 'outline',
}

export default function StatusBadge({ status }) {
  const variant = STATUS_VARIANTS[status] || 'outline'
  return <Badge variant={variant}>{status}</Badge>
}
