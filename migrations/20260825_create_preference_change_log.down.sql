-- Migration: 20260825_create_preference_change_log (down)
-- Description: Drop the preference change audit log table.

DROP TABLE IF EXISTS preference_change_log;
