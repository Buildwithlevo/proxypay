import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { TimeoutPresets, haltOnTimedout } from '../middleware/timeout';
import {
  getFraudHistory,
  listFraudAlerts,
  getFraudAlert,
  submitFeedback,
} from '../controllers/fraudController';

export const fraudRoutes = Router();

// All fraud routes require authentication
fraudRoutes.use(authenticateToken);

/**
 * Fraud Detection Logging Routes
 */

// Retrieve fraud evaluation history for a specific user
fraudRoutes.get(
  '/history/:userId',
  TimeoutPresets.quick,
  haltOnTimedout,
  getFraudHistory,
);

// List all fraud alerts with optional filtering
fraudRoutes.get(
  '/alerts',
  TimeoutPresets.quick,
  haltOnTimedout,
  listFraudAlerts,
);

// Get a specific fraud alert by ID
fraudRoutes.get(
  '/alerts/:alertId',
  TimeoutPresets.quick,
  haltOnTimedout,
  getFraudAlert,
);

// Submit feedback on a fraud alert
fraudRoutes.post(
  '/feedback',
  TimeoutPresets.quick,
  haltOnTimedout,
  submitFeedback,
);
