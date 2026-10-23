import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  // Contrat OpenAPI consommé par crypto-web (npm run api:types)
  const config = new DocumentBuilder()
    .setTitle('Veille — crypto-api')
    .setDescription('API de suivi et de trading crypto')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'docs-json',
  });

  await app.listen(process.env.PORT ?? 3001);
}
await bootstrap();
