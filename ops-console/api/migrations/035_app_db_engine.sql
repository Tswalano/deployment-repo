-- Ops Console schema: which database a console-created app got (PostgreSQL, MariaDB, SQLite or an external one).
ALTER TABLE app_creations ADD COLUMN db_engine text CHECK (db_engine IN ('postgresql', 'mariadb', 'sqlite', 'external'));
UPDATE app_creations SET db_engine = 'postgresql' WHERE with_db AND db_engine IS NULL;
