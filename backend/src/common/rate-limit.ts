import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
} from "@nestjs/common";
import { Request, Response } from "express";

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly requests = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const auth = request.path.startsWith("/auth/");
    const booking =
      request.path === "/appointments" && request.method === "POST";
    if (!auth && !booking) return true;
    const identity = auth
      ? (request.ip ?? "unknown")
      : (request.headers.authorization ?? request.ip ?? "unknown");
    const key = `${auth ? "auth" : "booking"}:${identity}`;
    const now = Date.now();
    const active = (this.requests.get(key) ?? []).filter(
      (stamp) => now - stamp < 60000,
    );
    const limit = auth ? 5 : 10;
    if (active.length >= limit) {
      response.setHeader("Retry-After", "60");
      throw new HttpException("Rate limit exceeded", 429);
    }
    active.push(now);
    this.requests.set(key, active);
    return true;
  }
}
