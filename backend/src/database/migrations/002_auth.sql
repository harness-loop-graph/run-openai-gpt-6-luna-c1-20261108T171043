CREATE TABLE IF NOT EXISTS auth_code (code TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuario(id), challenge TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS auth_token (token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuario(id), kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE);
CREATE INDEX IF NOT EXISTS token_user_idx ON auth_token(usuario_id, kind, expires_at);
