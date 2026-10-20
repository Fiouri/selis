-- 0009: a short note on a version (ADR 0033 amendment): what an erase or a redaction did
-- besides the page content, e.g. the annotations over the area it removed or clipped
-- ({"annotationsRemoved":1,"annotationsClipped":2}). NULL for every other version.
ALTER TABLE versions ADD COLUMN note TEXT CHECK (note IS NULL OR length(note) <= 200);
