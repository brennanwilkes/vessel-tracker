ALTER TABLE vessels ADD COLUMN direct_entry_count INTEGER NOT NULL DEFAULT 0;
UPDATE vessels SET direct_entry_count = 1 WHERE of_interest = 1;
