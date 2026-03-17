-- Fix: siso_loc_sort_key crashes with "upper bound of FOR loop cannot be null"
-- when localizacao is '' (empty string). string_to_array('', '-') returns an
-- empty array, array_length returns NULL, and FOR 1..NULL crashes.

CREATE OR REPLACE FUNCTION siso_loc_sort_key(loc text)
RETURNS text AS $$
DECLARE
  parts text[];
  part text;
  result text := '';
  i int;
  n int;
BEGIN
  IF loc IS NULL OR loc = '' THEN RETURN NULL; END IF;
  parts := string_to_array(loc, '-');
  n := array_length(parts, 1);
  IF n IS NULL OR n = 0 THEN RETURN NULL; END IF;
  FOR i IN 1..n LOOP
    part := parts[i];
    IF i > 1 THEN result := result || '-'; END IF;
    IF part ~ '^\d+$' THEN
      result := result || lpad(part, 10, '0');
    ELSE
      result := result || lpad(length(part)::text, 2, '0') || ':' || part;
    END IF;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
