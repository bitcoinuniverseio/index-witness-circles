import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApiModule } from './api/api.module';
import { BigIntJsonInterceptor } from './common/bigint-json.interceptor';
import { AppConfiguration, configuration, validateEnvironment } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { IndexerModule } from './indexer/indexer.module';
import { MetricsInterceptor } from './observability/metrics.interceptor';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnvironment,
    }),
    EventEmitterModule.forRoot({ wildcard: false, global: true }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfiguration, true>) => {
        const security = configService.get('security', { infer: true });
        return [
          {
            name: 'default',
            ttl: security.publicRateLimitTtlMs,
            limit: security.publicRateLimitMax,
          },
        ];
      },
    }),
    DatabaseModule,
    IndexerModule,
    ApiModule,
    ObservabilityModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: BigIntJsonInterceptor },
  ],
})
export class AppModule {}
