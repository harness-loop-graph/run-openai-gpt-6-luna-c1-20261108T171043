import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { UnprocessableEntityException, ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { ErrorsFilter } from "./common/errors.filter";
import * as express from "express";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: ["http://localhost:8080"], credentials: true });
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: "1mb" }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new UnprocessableEntityException(
          errors.map((error) => ({
            property: error.property,
            constraints: error.constraints,
          })),
        ),
    }),
  );
  app.useGlobalFilters(new ErrorsFilter());
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

void bootstrap();
