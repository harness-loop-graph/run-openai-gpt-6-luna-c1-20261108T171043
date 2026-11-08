CREATE OR REPLACE FUNCTION reject_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only resource'; END; $$;
CREATE TRIGGER encounter_append_only BEFORE UPDATE OR DELETE ON encuentro FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON auditoria FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
