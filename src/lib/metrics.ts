// ======== Prometheus 指标（v5.5.6 产品化）========
//
// 简单内存版指标收集，暴露 /metrics 端点供 Prometheus 抓取。
// 指标：
//   - http_requests_total
//   - http_request_duration_seconds
//   - task_queue_total
//   - task_queue_operations_total
//   - storage_write_errors_total
//   - bridge_uptime_seconds

class MetricsRegistry {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private startedAt = Date.now();

  inc(name: string, labels: Record<string, string> = {}, value: number = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  set(name: string, labels: Record<string, string>, value: number): void {
    const key = this.key(name, labels);
    this.gauges.set(key, value);
  }

  observe(name: string, labels: Record<string, string>, value: number): void {
    const key = this.key(name, labels);
    const arr = this.histograms.get(key) || [];
    arr.push(value);
    this.histograms.set(key, arr);
  }

  private key(name: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
      .join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  render(): string {
    const lines: string[] = [];

    // counters
    lines.push('# HELP http_requests_total Total HTTP requests');
    lines.push('# TYPE http_requests_total counter');
    for (const [key, value] of this.counters) {
      if (key.startsWith('http_requests_total')) lines.push(`${key} ${value}`);
    }

    // histogram
    lines.push('# HELP http_request_duration_seconds HTTP request duration');
    lines.push('# TYPE http_request_duration_seconds histogram');
    for (const [key, values] of this.histograms) {
      if (key.startsWith('http_request_duration_seconds')) {
        const sum = values.reduce((a, b) => a + b, 0);
        lines.push(`${key}_count ${values.length}`);
        lines.push(`${key}_sum ${sum.toFixed(6)}`);
      }
    }

    // task queue gauge
    lines.push('# HELP task_queue_total Current task count by status');
    lines.push('# TYPE task_queue_total gauge');
    for (const [key, value] of this.gauges) {
      if (key.startsWith('task_queue_total')) lines.push(`${key} ${value}`);
    }

    // task operations
    lines.push('# HELP task_queue_operations_total Task queue operations');
    lines.push('# TYPE task_queue_operations_total counter');
    for (const [key, value] of this.counters) {
      if (key.startsWith('task_queue_operations_total')) lines.push(`${key} ${value}`);
    }

    // storage errors
    lines.push('# HELP storage_write_errors_total Storage write errors');
    lines.push('# TYPE storage_write_errors_total counter');
    for (const [key, value] of this.counters) {
      if (key.startsWith('storage_write_errors_total')) lines.push(`${key} ${value}`);
    }

    // uptime
    lines.push('# HELP bridge_uptime_seconds Bridge uptime in seconds');
    lines.push('# TYPE bridge_uptime_seconds gauge');
    lines.push(`bridge_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(3)}`);

    return lines.join('\n') + '\n';
  }
}

export const metrics = new MetricsRegistry();
