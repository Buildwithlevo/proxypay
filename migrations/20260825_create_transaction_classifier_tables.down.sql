-- Migration: 20260825_create_transaction_classifier_tables (down)
-- Description: Drop the transaction classifier tables.

DROP TABLE IF EXISTS transaction_classifier_training;
DROP TABLE IF EXISTS transaction_classifier_feedback;
DROP TABLE IF EXISTS transaction_classifier_models;
