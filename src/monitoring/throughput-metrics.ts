export interface ThroughputMetrics {
  totalScanned: number;
  itemsProcessed: number;
  assignedQueued: number;
  backlogSize: number;
  cycleDurationMs: number;
  timestamp: Date;
}

export class ThroughputMonitor {
  private metrics: ThroughputMetrics[] = [];

  record(metric: ThroughputMetrics): void {
    this.metrics.push(metric);
  }

  getAverageItemsPerScan(): number {
    if (this.metrics.length === 0) return 0;
    const total = this.metrics.reduce((acc, m) => acc + m.itemsProcessed, 0);
    return total / this.metrics.length;
  }

  getBacklogDrainRate(): number {
    if (this.metrics.length < 2) return 0;
    const first = this.metrics[0];
    const last = this.metrics[this.metrics.length - 1];
    const timeDiffMinutes = (last.timestamp.getTime() - first.timestamp.getTime()) / 60000;
    if (timeDiffMinutes === 0) return 0;
    const itemsDrained = first.backlogSize - last.backlogSize;
    return itemsDrained / timeDiffMinutes;
  }

  getMetrics(): ThroughputMetrics[] {
    return [...this.metrics];
  }
}
