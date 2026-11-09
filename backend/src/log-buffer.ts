export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  ts: number;
  level: LogLevelName;
  channel: string;
  msg: string;
}

export const LOG_BUFFER_CAPACITY = 2000;

/** Fixed-size ring buffer of the most recent log lines, for the admin Logs page. */
export class LogBuffer {
  private readonly lines: (LogLine | undefined)[];
  private next = 0;
  private size = 0;

  constructor(private readonly capacity = LOG_BUFFER_CAPACITY) {
    this.lines = new Array(capacity);
  }

  push(line: LogLine): void {
    this.lines[this.next] = line;
    this.next = (this.next + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** The newest `limit` lines, oldest first (reads like a terminal). */
  tail(limit = this.capacity): LogLine[] {
    const count = Math.max(0, Math.min(limit, this.size));
    const out: LogLine[] = [];
    for (let i = count; i > 0; i--) {
      const line = this.lines[(this.next - i + this.capacity) % this.capacity];
      if (line) out.push(line);
    }
    return out;
  }

  clear(): void {
    this.lines.fill(undefined);
    this.next = 0;
    this.size = 0;
  }
}

export const logBuffer = new LogBuffer();
