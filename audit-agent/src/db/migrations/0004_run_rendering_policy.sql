-- Build step 11 / open decision #4: the exact rendering engine a run used, in
-- full (engine, channel, exact browser build, Playwright version, viewport,
-- locale, timezone, user agent). policy_version carries the short form; this
-- keeps the whole record so a later run can be compared field by field.
ALTER TABLE runs ADD COLUMN rendering_policy_json TEXT;
