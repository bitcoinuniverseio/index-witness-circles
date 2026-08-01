import { LoggerService } from '@nestjs/common';

const REDACTED_KEYS = /authorization|cookie|password|secret|token|apiKey|seed|privateKey/i;

function sanitize(value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        REDACTED_KEYS.test(key) ? '[redacted]' : sanitize(item),
      ]),
    );
  }
  return value;
}

export class JsonLogger implements LoggerService {
  constructor(private readonly minimumLevel = 'info') {}

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    if (['debug', 'trace'].includes(this.minimumLevel)) this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    if (this.minimumLevel === 'trace') this.write('trace', message, context);
  }

  private write(level: string, message: unknown, context?: string, trace?: string): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      context: context ?? null,
      message: sanitize(message),
      ...(trace ? { trace } : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (level === 'error') process.stderr.write(line);
    else process.stdout.write(line);
  }
}
