import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import {
  assertProductionConfig,
  swaggerEnabled,
  trustProxySetting,
} from './common/production.js';

async function bootstrap() {
  // Avant tout le reste : une configuration de production dangereuse arrête le démarrage, elle ne tourne pas.
  assertProductionConfig(process.env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Derrière le proxy de la plateforme : sans cela, `req.ip` serait celle du proxy pour tout le monde.
  app.set('trust proxy', trustProxySetting(process.env));
  // SIGTERM (chaque déploiement) : fermer proprement les jobs, le WebSocket, Redis et la base.
  app.enableShutdownHooks();

  app.setGlobalPrefix('api');
  // WebSocket natif (bibliothèque ws) : le front utilise le WebSocket du navigateur, sans client dédié.
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Contrat OpenAPI consommé par crypto-web (npm run api:types). Fermé en production (SWAGGER_ENABLED=true le rouvre).
  if (swaggerEnabled(process.env)) {
    const config = new DocumentBuilder()
      .setTitle('Veille — crypto-api')
      .setDescription('API de suivi et de trading crypto')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'docs',
      app,
      SwaggerModule.createDocument(app, config),
      {
        jsonDocumentUrl: 'docs-json',
      },
    );
  }

  await app.listen(process.env.PORT ?? 3001);
}
await bootstrap();
