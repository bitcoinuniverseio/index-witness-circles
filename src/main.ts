import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { WitnessSocketAdapter } from './api/witness-socket.adapter';
import { JsonLogger } from './common/json-logger';
import { AppConfiguration } from './config/configuration';
import { INDEXER_VERSION } from './protocol';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const configService = app.get(ConfigService<AppConfiguration, true>);
  const security = configService.get('security', { infer: true });
  app.useLogger(new JsonLogger(configService.get('logLevel', { infer: true })));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
        },
      },
    }),
  );
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableCors({
    origin: security.corsOrigins.length > 0 ? security.corsOrigins : false,
    credentials: false,
  });
  app.useWebSocketAdapter(new WitnessSocketAdapter(app, security));
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Witness Circles Indexer API')
      .setDescription(
        'Canonical WITC v1 Circles and lineage state derived only from Bitcoin, plus explicitly local mempool observations.',
      )
      .setVersion(INDEXER_VERSION)
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });

  const port = configService.get('port', { infer: true });
  const host = configService.get('listenHost', { infer: true });
  await app.listen(port, host);
  Logger.log({ event: 'http_listening', host, port }, 'Bootstrap');
}

void bootstrap();
