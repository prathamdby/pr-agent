-- 045_source_qualified_ci_facts
UPDATE pr_head_ci_state AS state
   SET checks = COALESCE((
     SELECT jsonb_object_agg((fact.value->>'source') || E'\n' || (fact.value->>'name'), fact.value)
       FROM jsonb_each(state.checks) AS fact(key, value)
   ), '{}'::jsonb)
 WHERE state.checks <> '{}'::jsonb;

CREATE OR REPLACE FUNCTION pr_head_ci_state_checks_source_qualified()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  fact record;
BEGIN
  FOR fact IN SELECT key, value FROM jsonb_each(NEW.checks)
  LOOP
    IF fact.key <> (fact.value->>'source') || E'\n' || (fact.value->>'name') THEN
      RAISE EXCEPTION 'pr_head_ci_state checks keys must be source-qualified';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS pr_head_ci_state_checks_source_qualified ON pr_head_ci_state;
CREATE TRIGGER pr_head_ci_state_checks_source_qualified
  BEFORE INSERT OR UPDATE ON pr_head_ci_state
  FOR EACH ROW EXECUTE FUNCTION pr_head_ci_state_checks_source_qualified();
