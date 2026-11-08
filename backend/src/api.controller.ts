import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Patch,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  UnauthorizedException,
  BadRequestException,
  UseGuards,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { Request, Response } from "express";
import { memoryStorage } from "multer";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiService, SessionUser } from "./api.service";
import { RateLimitGuard } from "./common/rate-limit";

@Controller()
@UseGuards(RateLimitGuard)
export class ApiController {
  constructor(private readonly api: ApiService) {}

  private keys(value: Record<string, unknown>, allowed: string[]): void {
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).some((key) => !allowed.includes(key))
    )
      throw new BadRequestException("Undeclared or invalid fields");
  }

  private async user(header?: string): Promise<SessionUser> {
    if (!header?.startsWith("Bearer "))
      throw new UnauthorizedException("Bearer token required");
    return this.api.validate(header.slice(7));
  }

  private role(user: SessionUser, allowed: string[]): void {
    if (!allowed.includes(user.role))
      throw new ForbiddenException("Insufficient role");
  }
  private escape(value: string): string {
    return value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char] ?? char,
    );
  }

  @Get("health")
  health(): { status: string } {
    return { status: "ok" };
  }

  @Get("auth/authorize")
  authorize(
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): void {
    if (
      query.response_type !== "code" ||
      query.code_challenge_method !== "S256" ||
      query.client_id !== "medapp-spa" ||
      query.redirect_uri !== "http://localhost:8080/auth/callback" ||
      !query.code_challenge ||
      !query.state
    )
      throw new BadRequestException("Invalid authorization request");
    const target = new URLSearchParams({
      client_id: query.client_id,
      redirect_uri: query.redirect_uri,
      code_challenge: query.code_challenge,
      state: query.state,
    });
    response.redirect(302, `/auth/login-page?${target.toString()}`);
  }

  @Get("auth/login-page")
  loginPage(
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): void {
    const fields = Object.entries(query)
      .filter(([key]) =>
        ["client_id", "redirect_uri", "code_challenge", "state"].includes(key),
      )
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${key}" value="${this.escape(value)}">`,
      )
      .join("");
    response
      .type("html")
      .send(
        `<!doctype html><html><body><form method="post" action="/auth/login"><label>Email <input name="email" type="email" data-testid="login-email" required></label><label>Password <input name="password" type="password" data-testid="login-password" required></label>${fields}<button type="submit" data-testid="login-submit">Sign in</button></form></body></html>`,
      );
  }

  @Post("auth/login")
  async login(
    @Body() body: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    this.keys(body, [
      "email",
      "password",
      "client_id",
      "redirect_uri",
      "code_challenge",
      "state",
    ]);
    const code = await this.api.authorize(body.email, body.password, {
      client_id: body.client_id,
      redirect_uri: body.redirect_uri,
      code_challenge: body.code_challenge,
      state: body.state,
    });
    const redirect = new URL(body.redirect_uri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", body.state);
    response.redirect(302, redirect.toString());
  }

  @Post("auth/token")
  async token(@Body() body: Record<string, string>): Promise<unknown> {
    this.keys(body, ["code", "code_verifier", "client_id", "redirect_uri"]);
    if (
      body.client_id !== "medapp-spa" ||
      body.redirect_uri !== "http://localhost:8080/auth/callback"
    )
      throw new BadRequestException("Invalid client");
    return this.api.exchange(body.code, body.code_verifier);
  }
  @Post("auth/token/refresh")
  async refresh(@Body() body: Record<string, string>): Promise<unknown> {
    this.keys(body, ["refresh_token"]);
    return this.api.refresh(body.refresh_token);
  }
  @Post("auth/revoke")
  @HttpCode(204)
  async revoke(@Body() body: Record<string, string>): Promise<void> {
    this.keys(body, ["token"]);
    await this.api.revoke(body.token);
  }
  @Get("me")
  async me(@Headers("authorization") authorization?: string): Promise<unknown> {
    return this.api.me(await this.user(authorization));
  }
  @Get("me/appointments")
  async appointments(
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    const user = await this.user(authorization);
    this.role(user, ["patient"]);
    return this.api.listAppointments(user);
  }
  @Get("professional-id/:userId")
  async professionalId(
    @Param("userId") id: string,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    const user = await this.user(authorization);
    this.role(user, ["professional"]);
    return { id: await this.api.professionalIdForUser(Number(id)) };
  }
  @Get("professionals")
  async professionals(
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    const user = await this.user(authorization);
    this.role(user, ["patient", "staff"]);
    return this.api.professionals();
  }
  @Get("availability")
  async availability(
    @Query() query: Record<string, string>,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    const user = await this.user(authorization);
    this.role(user, ["patient", "staff"]);
    return this.api.availability(
      Number(query.professionalId),
      query.from,
      query.to,
    );
  }
  @Post("appointments")
  async book(
    @Body() body: Record<string, string>,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    this.keys(body, ["professionalId", "slotStart"]);
    const user = await this.user(authorization);
    this.role(user, ["patient"]);
    return this.api.book(user, Number(body.professionalId), body.slotStart);
  }
  @Delete("appointments/:id")
  @HttpCode(204)
  async cancel(
    @Param("id") id: string,
    @Headers("authorization") authorization?: string,
  ): Promise<void> {
    const user = await this.user(authorization);
    this.role(user, ["patient"]);
    await this.api.cancel(user, Number(id));
  }
  @Get("agenda")
  async agenda(
    @Query() query: Record<string, string>,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    const user = await this.user(authorization);
    this.role(user, ["professional", "staff"]);
    if (user.role !== "professional") return [];
    return this.api.agenda(user, query.from, query.to);
  }
  @Get("appointments/:id")
  async appointment(
    @Param("id") id: string,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    const user = await this.user(authorization);
    const result = await this.api.appointment(user, Number(id));
    return result;
  }
  @Post("appointments/:id/encounter")
  async encounter(
    @Param("id") id: string,
    @Body() body: Record<string, string>,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    this.keys(body, ["notes", "diagnosis"]);
    if (!body.notes || !body.diagnosis)
      throw new BadRequestException("Notes and diagnosis required");
    const user = await this.user(authorization);
    this.role(user, ["professional"]);
    return this.api.encounter(user, Number(id), body.notes, body.diagnosis);
  }
  @Post("encounters/:id/attachments")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_request, file, callback) => {
        if (
          !["application/pdf", "image/jpeg", "image/png"].includes(
            file.mimetype,
          )
        )
          callback(
            new UnsupportedMediaTypeException("Unsupported attachment type"),
            false,
          );
        else callback(null, true);
      },
    }),
  )
  async uploadAttachment(
    @Param("id") id: string,
    @UploadedFile()
    file:
      | { originalname: string; mimetype: string; buffer: Buffer }
      | undefined,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    if (!file) throw new BadRequestException("File is required");
    const user = await this.user(authorization);
    await this.api.encounterAuthor(user, Number(id));
    return this.api.saveAttachment(
      Number(id),
      file.originalname,
      file.mimetype,
      file.buffer,
    );
  }
  @Get("attachments/:id")
  async downloadAttachment(
    @Param("id") id: string,
    @Headers("authorization") authorization: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const user = await this.user(authorization);
    const attachment = await this.api.attachment(Number(id));
    if (user.role === "professional")
      await this.api.encounterAuthor(user, attachment.encounterId);
    else if (user.role === "patient")
      await this.api.patientOwnsEncounter(user, attachment.encounterId);
    else throw new ForbiddenException("Not authorized");
    response
      .type(attachment.contentType)
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${attachment.filename}"`,
      )
      .sendFile(attachment.path);
  }
  @Get("patients/:id/clinical-history")
  async history(
    @Param("id") id: string,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    const user = await this.user(authorization);
    this.role(user, ["patient", "professional"]);
    return this.api.history(user, Number(id));
  }
  @Get("admin/users")
  async users(
    @Query("page") page: string,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    const user = await this.user(authorization);
    this.role(user, ["admin"]);
    return this.api.adminUsers(Number(page ?? 1));
  }
  @Post("admin/users")
  async createUser(
    @Body() body: { email: string; roles: string[] },
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    this.keys(body, ["email", "roles"]);
    const user = await this.user(authorization);
    this.role(user, ["admin"]);
    return this.api.createUser(body.email, body.roles);
  }
  @Patch("admin/users/:id/roles")
  async roles(
    @Param("id") id: string,
    @Body() body: { roles: string[] },
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    this.keys(body, ["roles"]);
    const user = await this.user(authorization);
    this.role(user, ["admin"]);
    return this.api.roles(Number(id), body.roles);
  }
  @Put("admin/professionals/:id/availability")
  async setAvailability(
    @Param("id") id: string,
    @Body() body: { slots: Array<{ start: string; end: string }> },
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    this.keys(body, ["slots"]);
    const user = await this.user(authorization);
    this.role(user, ["admin"]);
    return this.api.setAvailability(Number(id), body.slots);
  }
  @Get("admin/audit")
  async audit(
    @Query() query: Record<string, string>,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    const user = await this.user(authorization);
    this.role(user, ["admin"]);
    return this.api.auditLog({
      actor: query.actor ? Number(query.actor) : undefined,
      action: query.action,
      from: query.from,
      to: query.to,
    });
  }
}
