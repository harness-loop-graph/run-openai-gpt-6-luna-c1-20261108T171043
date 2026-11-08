import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { Response } from "express";

@Catch()
export class ErrorsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const raw = error instanceof HttpException ? error.getResponse() : null;
    const message =
      typeof raw === "string" ? raw : "Request could not be processed";
    response.status(status).json({
      error: {
        code: status === 500 ? "INTERNAL_ERROR" : `HTTP_${status}`,
        message,
      },
    });
  }
}
