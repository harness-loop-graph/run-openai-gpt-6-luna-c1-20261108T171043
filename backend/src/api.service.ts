import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { Pool } from "pg";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";

export interface SessionUser {
  id: number;
  role: string;
  patientId?: number;
  professionalId?: number;
}

@Injectable()
export class ApiService implements OnModuleInit {
  private readonly pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://medapp:medapp@localhost:5432/medapp",
  });
  private readonly codes = new Map<
    string,
    { userId: number; challenge: string; expires: number }
  >();

  async onModuleInit(): Promise<void> {
    await this.migrate();
    await this.seed();
  }

  private async migrate(): Promise<void> {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const dir = join(process.cwd(), "src/database/migrations");
    for (const name of readdirSync(dir)
      .filter((item) => item.endsWith(".sql") && !item.endsWith(".down.sql"))
      .sort()) {
      const exists = await this.pool.query(
        "SELECT 1 FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (exists.rowCount) continue;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(join(dir, name), "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [
          name,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  private async seed(): Promise<void> {
    const passwordHash = this.hashPassword(
      process.env.SEED_PASSWORD ?? "Seed!Passw0rd",
    );
    const users = [
      ["admin@seed.local", "admin", "Admin"],
      ["staff@seed.local", "staff", "Staff"],
      ["paciente1@seed.local", "patient", "Paciente Uno"],
      ["paciente2@seed.local", "patient", "Paciente Dos"],
      ["paciente3@seed.local", "patient", "Paciente Tres"],
      ["gomez@seed.local", "professional", "Gómez"],
      ["lopez@seed.local", "professional", "López"],
    ];
    for (const [email, role, name] of users) {
      const user = await this.pool.query(
        "INSERT INTO usuario(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING id",
        [email, passwordHash],
      );
      const roleRow = await this.pool.query(
        "SELECT id FROM rol WHERE nombre=$1",
        [role],
      );
      await this.pool.query(
        "INSERT INTO usuario_rol(usuario_id,rol_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [user.rows[0].id, roleRow.rows[0].id],
      );
      if (role === "patient")
        await this.pool.query(
          "INSERT INTO paciente(usuario_id,nombre) VALUES($1,$2) ON CONFLICT(usuario_id) DO NOTHING",
          [user.rows[0].id, name],
        );
      if (role === "professional")
        await this.pool.query(
          "INSERT INTO profesional(usuario_id,nombre) VALUES($1,$2) ON CONFLICT(usuario_id) DO NOTHING",
          [user.rows[0].id, name],
        );
    }
    const professionals = await this.pool.query(
      "SELECT id,nombre FROM profesional ORDER BY id",
    );
    for (const professional of professionals.rows as Array<{
      id: number;
      nombre: string;
    }>) {
      const midnight = new Date();
      midnight.setUTCHours(0, 0, 0, 0);
      for (let day = 1; day <= 14; day += 1) {
        const date = new Date(midnight.getTime() + day * 86400000);
        if (
          date.getUTCDay() === 0 ||
          date.getUTCDay() === 6 ||
          (professional.nombre === "López" && date.getUTCDay() === 5)
        )
          continue;
        for (let minute = 480; minute < 960; minute += 30) {
          const start = new Date(date.getTime() + minute * 60000);
          await this.pool.query(
            "INSERT INTO disponibilidad(profesional_id,franja_inicio,franja_fin) VALUES($1,$2,$3) ON CONFLICT(profesional_id,franja_inicio) DO NOTHING",
            [professional.id, start, new Date(start.getTime() + 1800000)],
          );
        }
      }
    }
  }

  private hashPassword(value: string): string {
    return scryptSync(value, "medapp-fixed-seed-salt", 64).toString("hex");
  }
  private async audit(
    userId: number | null,
    action: string,
    type: string,
    id: string | number,
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO auditoria(usuario_id,action,resource_type,resource_id) VALUES($1,$2,$3,$4)",
      [userId, action, type, String(id)],
    );
  }

  async authorize(
    email: string,
    password: string,
    request: {
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      state: string;
    },
  ): Promise<string> {
    if (
      request.client_id !== "medapp-spa" ||
      request.redirect_uri !== "http://localhost:8080/auth/callback"
    )
      throw new BadRequestException("Invalid OAuth client");
    const result = await this.pool.query(
      "SELECT id,password_hash FROM usuario WHERE email=$1 AND activo=true",
      [email],
    );
    if (
      !result.rowCount ||
      !timingSafeEqual(
        Buffer.from(this.hashPassword(password)),
        Buffer.from(result.rows[0].password_hash),
      )
    )
      throw new UnauthorizedException("Invalid credentials");
    const code = randomBytes(32).toString("hex");
    this.codes.set(code, {
      userId: result.rows[0].id,
      challenge: request.code_challenge,
      expires: Date.now() + 600000,
    });
    return code;
  }

  async exchange(
    code: string,
    verifier: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const saved = this.codes.get(code);
    if (!saved || saved.expires < Date.now())
      throw new UnauthorizedException("Invalid code");
    if (
      createHash("sha256").update(verifier).digest("base64url") !==
      saved.challenge
    )
      throw new BadRequestException("Invalid verifier");
    this.codes.delete(code);
    const access = randomBytes(32).toString("hex");
    const refresh = randomBytes(32).toString("hex");
    await this.pool.query(
      "INSERT INTO auth_token(token,usuario_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '15 minutes'),($3,$2,'refresh',now()+interval '8 hours')",
      [access, saved.userId, refresh],
    );
    return { access_token: access, refresh_token: refresh };
  }

  async validate(token: string): Promise<SessionUser> {
    const result = await this.pool.query(
      "SELECT u.id,r.nombre FROM auth_token t JOIN usuario u ON u.id=t.usuario_id JOIN usuario_rol ur ON ur.usuario_id=u.id JOIN rol r ON r.id=ur.rol_id WHERE t.token=$1 AND t.kind='access' AND t.revoked=false AND t.expires_at>now() AND u.activo=true",
      [token],
    );
    if (!result.rowCount) throw new UnauthorizedException("Invalid token");
    const user: SessionUser = {
      id: result.rows[0].id,
      role: result.rows[0].nombre,
    };
    if (user.role === "patient")
      user.patientId = (
        await this.pool.query("SELECT id FROM paciente WHERE usuario_id=$1", [
          user.id,
        ])
      ).rows[0]?.id;
    if (user.role === "professional")
      user.professionalId = (
        await this.pool.query(
          "SELECT id FROM profesional WHERE usuario_id=$1",
          [user.id],
        )
      ).rows[0]?.id;
    return user;
  }

  async me(user: SessionUser): Promise<SessionUser> {
    return user;
  }
  async refresh(
    token: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const result = await this.pool.query(
      "SELECT usuario_id FROM auth_token WHERE token=$1 AND kind='refresh' AND revoked=false AND expires_at>now()",
      [token],
    );
    if (!result.rowCount)
      throw new UnauthorizedException("Invalid refresh token");
    await this.pool.query("UPDATE auth_token SET revoked=true WHERE token=$1", [
      token,
    ]);
    const access = randomBytes(32).toString("hex");
    const refresh = randomBytes(32).toString("hex");
    await this.pool.query(
      "INSERT INTO auth_token(token,usuario_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '15 minutes'),($3,$2,'refresh',now()+interval '8 hours')",
      [access, result.rows[0].usuario_id, refresh],
    );
    return { access_token: access, refresh_token: refresh };
  }
  async revoke(token: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE auth_token SET revoked=true WHERE token=$1 RETURNING token",
      [token],
    );
    if (!result.rowCount) throw new UnauthorizedException("Invalid token");
  }

  async listAppointments(user: SessionUser): Promise<unknown[]> {
    const result = await this.pool.query(
      "SELECT c.id,c.profesional_id,c.franja_inicio AS start,c.franja_fin AS end,c.estado,p.nombre AS professional FROM cita c JOIN profesional p ON p.id=c.profesional_id WHERE c.paciente_id=$1 ORDER BY c.franja_inicio",
      [user.patientId],
    );
    await this.audit(user.id, "read", "appointments", user.patientId ?? 0);
    return result.rows;
  }
  async professionals(): Promise<unknown[]> {
    return (
      await this.pool.query(
        "SELECT id,nombre AS name FROM profesional ORDER BY id",
      )
    ).rows;
  }
  async professionalIdForUser(userId: number): Promise<number> {
    const result = await this.pool.query(
      "SELECT id FROM profesional WHERE usuario_id=$1",
      [userId],
    );
    if (!result.rowCount) throw new NotFoundException("Professional not found");
    return result.rows[0].id;
  }
  async availability(
    professionalId: number,
    from: string,
    to: string,
  ): Promise<unknown[]> {
    if (
      !Number.isInteger(professionalId) ||
      !from ||
      !to ||
      new Date(from) > new Date(to) ||
      new Date(to).getTime() - new Date(from).getTime() > 31 * 86400000
    )
      throw new BadRequestException("Invalid date range");
    return (
      await this.pool.query(
        "SELECT d.franja_inicio AS start,d.franja_fin AS end FROM disponibilidad d WHERE d.profesional_id=$1 AND d.franja_inicio >= $2::date AND d.franja_inicio < ($3::date + interval '1 day') AND NOT EXISTS(SELECT 1 FROM cita c WHERE c.profesional_id=d.profesional_id AND c.franja_inicio=d.franja_inicio AND c.estado <> 'cancelled') ORDER BY d.franja_inicio",
        [professionalId, from, to],
      )
    ).rows;
  }

  async book(
    user: SessionUser,
    professionalId: number,
    slotStart: string,
  ): Promise<{ id: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const slot = await client.query(
        "SELECT id,franja_fin FROM disponibilidad WHERE profesional_id=$1 AND franja_inicio=$2 FOR UPDATE",
        [professionalId, slotStart],
      );
      if (!slot.rowCount || new Date(slotStart) <= new Date())
        throw new BadRequestException("Slot unavailable");
      const result = await client.query(
        "INSERT INTO cita(paciente_id,profesional_id,franja_inicio,franja_fin,estado) VALUES($1,$2,$3,$4,'scheduled') RETURNING id",
        [user.patientId, professionalId, slotStart, slot.rows[0].franja_fin],
      );
      await client.query(
        "INSERT INTO auditoria(usuario_id,action,resource_type,resource_id) VALUES($1,$2,$3,$4)",
        [user.id, "create", "appointment", String(result.rows[0].id)],
      );
      await client.query("COMMIT");
      return { id: result.rows[0].id };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        throw new ConflictException("Slot already booked");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(user: SessionUser, id: number): Promise<void> {
    const result = await this.pool.query(
      "UPDATE cita SET estado='cancelled' WHERE id=$1 AND paciente_id=$2 AND estado='scheduled' RETURNING id",
      [id, user.patientId],
    );
    if (!result.rowCount) {
      const found = await this.pool.query(
        "SELECT paciente_id FROM cita WHERE id=$1",
        [id],
      );
      if (!found.rowCount) throw new NotFoundException("Appointment not found");
      throw new ForbiddenException("Appointment is not owned by user");
    }
    await this.audit(user.id, "cancel", "appointment", id);
  }
  async agenda(
    user: SessionUser,
    from: string,
    to: string,
  ): Promise<unknown[]> {
    return (
      await this.pool.query(
        "SELECT c.id,c.paciente_id,c.profesional_id,c.franja_inicio AS start,c.franja_fin AS end,c.estado FROM cita c WHERE c.profesional_id=$1 AND c.franja_inicio >= $2::date AND c.franja_inicio < ($3::date + interval '1 day') ORDER BY c.franja_inicio",
        [user.professionalId, from, to],
      )
    ).rows;
  }
  async appointment(
    user: SessionUser,
    id: number,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      "SELECT c.*,p.usuario_id AS patient_user_id FROM cita c JOIN paciente p ON p.id=c.paciente_id WHERE c.id=$1",
      [id],
    );
    if (!result.rowCount) throw new NotFoundException("Appointment not found");
    const row = result.rows[0];
    if (
      !(user.role === "patient" && row.patient_user_id === user.id) &&
      !(
        user.role === "professional" &&
        row.profesional_id === user.professionalId
      )
    )
      throw new ForbiddenException("Not allowed");
    return row;
  }
  async encounter(
    user: SessionUser,
    id: number,
    notes: string,
    diagnosis: string,
  ): Promise<{ id: number; version: number }> {
    const appointment = await this.appointment(user, id);
    if (
      user.role !== "professional" ||
      appointment.profesional_id !== user.professionalId
    )
      throw new ForbiddenException("Not assigned professional");
    const prior = await this.pool.query(
      "SELECT id,version FROM encuentro WHERE cita_id=$1 ORDER BY version DESC LIMIT 1",
      [id],
    );
    const version = prior.rowCount ? prior.rows[0].version + 1 : 1;
    const result = await this.pool.query(
      "INSERT INTO encuentro(cita_id,version,reemplaza_id,notes,diagnosis,author_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,version",
      [
        id,
        version,
        prior.rows[0]?.id ?? null,
        notes,
        diagnosis,
        user.professionalId,
      ],
    );
    await this.audit(user.id, "create", "encounter", result.rows[0].id);
    return result.rows[0];
  }
  async history(user: SessionUser, patientId: number): Promise<unknown[]> {
    const assigned =
      user.role === "professional"
        ? await this.pool.query(
            "SELECT 1 FROM cita WHERE paciente_id=$1 AND profesional_id=$2 LIMIT 1",
            [patientId, user.professionalId],
          )
        : null;
    if (
      !(user.role === "patient" && user.patientId === patientId) &&
      !(user.role === "professional" && assigned?.rowCount)
    )
      throw new ForbiddenException("Not assigned");
    const query =
      user.role === "professional"
        ? "SELECT e.id,e.notes,e.diagnosis,e.version,e.created_at,c.franja_inicio FROM encuentro e JOIN cita c ON c.id=e.cita_id WHERE c.paciente_id=$1 AND c.profesional_id=$2 ORDER BY c.franja_inicio DESC,e.version DESC"
        : "SELECT e.id,e.notes,e.diagnosis,e.version,e.created_at,c.franja_inicio FROM encuentro e JOIN cita c ON c.id=e.cita_id WHERE c.paciente_id=$1 ORDER BY c.franja_inicio DESC,e.version DESC";
    const result = await this.pool.query(
      query,
      user.role === "professional"
        ? [patientId, user.professionalId]
        : [patientId],
    );
    await this.audit(user.id, "read", "clinical-history", patientId);
    return result.rows;
  }

  async adminUsers(page: number): Promise<unknown> {
    const result = await this.pool.query(
      "SELECT u.id,u.email,array_agg(r.nombre) AS roles FROM usuario u JOIN usuario_rol ur ON ur.usuario_id=u.id JOIN rol r ON r.id=ur.rol_id GROUP BY u.id ORDER BY u.id LIMIT 20 OFFSET $1",
      [Math.max(0, page - 1) * 20],
    );
    return { items: result.rows, page, pageSize: 20 };
  }
  async createUser(email: string, roles: string[]): Promise<{ id: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query(
        "INSERT INTO usuario(email,password_hash) VALUES($1,$2) RETURNING id",
        [email, this.hashPassword(randomBytes(24).toString("hex"))],
      );
      for (const role of roles) {
        const found = await client.query("SELECT id FROM rol WHERE nombre=$1", [
          role,
        ]);
        if (!found.rowCount) throw new BadRequestException("Unknown role");
        await client.query(
          "INSERT INTO usuario_rol(usuario_id,rol_id) VALUES($1,$2)",
          [user.rows[0].id, found.rows[0].id],
        );
      }
      await client.query("COMMIT");
      return { id: user.rows[0].id };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        throw new ConflictException("Email exists");
      throw error;
    } finally {
      client.release();
    }
  }
  async roles(id: number, roles: string[]): Promise<unknown> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM usuario_rol WHERE usuario_id=$1", [id]);
      for (const role of roles) {
        const found = await client.query("SELECT id FROM rol WHERE nombre=$1", [
          role,
        ]);
        if (!found.rowCount) throw new BadRequestException("Unknown role");
        await client.query(
          "INSERT INTO usuario_rol(usuario_id,rol_id) VALUES($1,$2)",
          [id, found.rows[0].id],
        );
      }
      await client.query("COMMIT");
      return { id, roles };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async setAvailability(
    id: number,
    slots: Array<{ start: string; end: string }>,
  ): Promise<unknown> {
    const sorted = [...slots].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < sorted.length; i += 1)
      if (
        !Number.isFinite(Date.parse(sorted[i].start)) ||
        !Number.isFinite(Date.parse(sorted[i].end)) ||
        new Date(sorted[i].end) <= new Date(sorted[i].start) ||
        (i > 0 && sorted[i].start < sorted[i - 1].end)
      )
        throw new BadRequestException("Overlapping or invalid slots");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM disponibilidad WHERE profesional_id=$1 AND franja_inicio>now()",
        [id],
      );
      for (const slot of sorted)
        await client.query(
          "INSERT INTO disponibilidad(profesional_id,franja_inicio,franja_fin) VALUES($1,$2,$3)",
          [id, slot.start, slot.end],
        );
      await client.query("COMMIT");
      return { replaced: sorted.length };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async encounterAuthor(
    user: SessionUser,
    encounterId: number,
  ): Promise<number> {
    const result = await this.pool.query(
      "SELECT author_id FROM encuentro WHERE id=$1",
      [encounterId],
    );
    if (!result.rowCount) throw new NotFoundException("Encounter not found");
    if (
      user.role !== "professional" ||
      result.rows[0].author_id !== user.professionalId
    )
      throw new ForbiddenException("Attachment author required");
    return result.rows[0].author_id;
  }
  async attachmentAuthorId(encounterId: number): Promise<number> {
    const result = await this.pool.query(
      "SELECT author_id FROM encuentro WHERE id=$1",
      [encounterId],
    );
    if (!result.rowCount) throw new NotFoundException("Encounter not found");
    return result.rows[0].author_id;
  }
  async patientOwnsEncounter(
    user: SessionUser,
    encounterId: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT c.paciente_id FROM encuentro e JOIN cita c ON c.id=e.cita_id WHERE e.id=$1",
      [encounterId],
    );
    if (!result.rowCount) throw new NotFoundException("Encounter not found");
    if (
      user.role !== "patient" ||
      result.rows[0].paciente_id !== user.patientId
    )
      throw new ForbiddenException("Not authorized");
    return true;
  }
  async saveAttachment(
    encounterId: number,
    filename: string,
    contentType: string,
    buffer: Buffer,
  ): Promise<{ id: number }> {
    const safeName =
      basename(filename)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 120) || "attachment";
    const directory =
      process.env.ATTACHMENT_DIR ?? "/var/lib/medapp/attachments";
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const storage = join(
      directory,
      `${randomBytes(24).toString("hex")}-${safeName}`,
    );
    writeFileSync(storage, buffer, { mode: 0o600 });
    const result = await this.pool.query(
      "INSERT INTO adjunto(encuentro_id,filename,content_type,storage_path) VALUES($1,$2,$3,$4) RETURNING id",
      [encounterId, safeName, contentType, storage],
    );
    return { id: result.rows[0].id };
  }
  async attachment(id: number): Promise<{
    path: string;
    filename: string;
    contentType: string;
    encounterId: number;
  }> {
    const result = await this.pool.query(
      "SELECT storage_path,filename,content_type,encuentro_id FROM adjunto WHERE id=$1",
      [id],
    );
    if (!result.rowCount || !existsSync(result.rows[0].storage_path))
      throw new NotFoundException("Attachment not found");
    return {
      path: result.rows[0].storage_path,
      filename: result.rows[0].filename,
      contentType: result.rows[0].content_type,
      encounterId: result.rows[0].encuentro_id,
    };
  }
  async auditLog(query: {
    actor?: number;
    action?: string;
    from?: string;
    to?: string;
  }): Promise<unknown> {
    const result = await this.pool.query(
      'SELECT id,usuario_id AS actor,action,resource_type AS "resourceType",resource_id AS "resourceId",created_at FROM auditoria WHERE ($1::int IS NULL OR usuario_id=$1) AND ($2::text IS NULL OR action=$2) AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at <= $4) ORDER BY created_at DESC LIMIT 100',
      [
        query.actor ?? null,
        query.action ?? null,
        query.from ?? null,
        query.to ?? null,
      ],
    );
    return { items: result.rows, page: 1, pageSize: 100 };
  }
}
