-- 0007: English first (ADR 0030). Before English became the default (#31) the
-- language setting defaulted to "system", which shows Greek on a Greek device.
-- A stored "system" becomes "en" once, on this upgrade; an explicit "el" or
-- "en" is kept. A "system" chosen after this migration stays as chosen.
UPDATE settings SET value = '"en"' WHERE key = 'locale' AND json(value) = json('"system"');
