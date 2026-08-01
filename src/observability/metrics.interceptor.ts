import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const started = process.hrtime.bigint();
    return next.handle().pipe(
      finalize(() => {
        const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
        const labels = {
          method: request.method,
          route: context.getHandler().name || 'unmatched',
          status: String(response.statusCode),
        };
        this.metrics.httpRequests.inc(labels);
        this.metrics.httpDuration.observe(labels, elapsed);
      }),
    );
  }
}
