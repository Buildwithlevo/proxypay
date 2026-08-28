
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { RefreshTokenFamilyModel } from "../models/refreshTokenFamily";
import { redisClient } from "../config/redis";

dotenv.config();

const JWT_EXPIRES_IN = "1h";
const REFRESH_TOKEN_EXPIRES_IN = "7d";
const refreshTokenFamilyModel = new RefreshTokenFamilyModel();

export interface JWTImpersonationClaim {
  active: true;
  readOnly: true;
  actorUserId: string;
  actorRole: string;
  targetUserId: string;
  reason: string;
  issuedAt: string;
}

interface GenerateTokenOptions {
  expiresIn?: string | number;
  sessionId?: string;
  binding?: string;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not defined in environment variables");
  }
  return secret;
}

export interface JWTPayload {
  userId: string;
  email: string;
  role?: string;
  impersonation?: JWTImpersonationClaim;
  tokenVersion?: number;
  sessionId?: string;
  binding?: string;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  userId: string;
  familyId: string;
  tokenId: string;
  parentTokenId?: string;
  sessionId?: string;
  binding?: string;
  iat?: number;
  exp?: number;
}


/**
 * Generates a JWT token for the given user payload
 * @param payload - User data to include in the token
 * @returns Signed JWT token
 */
export function generateToken(
  payload: Omit<JWTPayload, "iat" | "exp">,
  options?: GenerateTokenOptions,
): string {
  const expiresIn = options?.expiresIn ?? JWT_EXPIRES_IN;
  return jwt.sign({
    ...payload,
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.binding ? { binding: options.binding } : {}),
  }, getJwtSecret(), {
    expiresIn: typeof expiresIn === 'string' ? expiresIn : expiresIn,
  } as jwt.SignOptions);
}

export function createSessionBinding(deviceId?: string, userAgent?: string): string {
  return crypto.createHash("sha256").update(`${deviceId ?? ""}:${userAgent ?? ""}`).digest("hex");
}

const sessionKey = (sessionId: string) => `jwt:session:${sessionId}`;
const userSessionsKey = (userId: string) => `user:${userId}:jwt_sessions`;

export async function registerJwtSession(
  userId: string,
  sessionId: string,
  binding: string,
  expiresAt: number,
): Promise<void> {
  if (!redisClient.isOpen) return;
  const maxSessions = Math.max(1, Number(process.env.JWT_MAX_CONCURRENT_SESSIONS ?? 5));
  const ttl = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
  const sessionsKey = userSessionsKey(userId);

  await redisClient.set(sessionKey(sessionId), JSON.stringify({ userId, binding }), { EX: ttl });
  await redisClient.zAdd(sessionsKey, [{ score: Date.now(), value: sessionId }]);
  await redisClient.expire(sessionsKey, ttl);

  const sessions = await redisClient.zRange(sessionsKey, 0, -1);
  for (const oldSessionId of sessions.slice(0, Math.max(0, sessions.length - maxSessions))) {
    await redisClient.del(sessionKey(oldSessionId));
    await redisClient.zRem(sessionsKey, oldSessionId);
  }
}

/**
 * Generates a refresh token and tracks its family chain
 * @param userId - User's ID
 * @param familyId - Family chain ID (new for first token)
 * @param parentTokenId - Parent token ID (if rotating)
 * @returns Signed refresh token
 */
export async function generateRefreshToken(
  userId: string,
  familyId?: string,
  parentTokenId?: string,
  session?: { sessionId: string; binding: string },
): Promise<string> {
  const tokenId = uuidv4();
  const famId = familyId || uuidv4();
  const payload: RefreshTokenPayload = {
    userId,
    familyId: famId,
    tokenId,
    parentTokenId,
    ...session,
  };
  const token = jwt.sign(payload, getJwtSecret(), {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  });
  await refreshTokenFamilyModel.create({ user_id: userId, family_id: famId, token, parent_token: parentTokenId });
  return token;
}


/**
 * Verifies a JWT token and returns the decoded payload
 * @param token - JWT token to verify
 * @returns Decoded token payload
 * @throws Error if token is invalid or expired
 */
export function verifyToken(token: string): JWTPayload {
  const secret = getJwtSecret();
  try {
    const decoded = jwt.verify(token, secret, { clockTolerance: 60 }) as JWTPayload;
    return decoded;
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Token has expired", { cause: error });
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid token", { cause: error });
    } else {
      throw new Error("Token verification failed", { cause: error });
    }
  }
}

/**
 * Verifies a refresh token, detects reuse, and revokes family if reused
 * @param token - Refresh token to verify
 * @returns Decoded refresh token payload
 * @throws Error if token is invalid, expired, or reused
 */
export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const secret = getJwtSecret();
  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(token, secret) as RefreshTokenPayload;
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Refresh token has expired", { cause: error });
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid refresh token", { cause: error });
    } else {
      throw new Error("Refresh token verification failed", { cause: error });
    }
  }
  // Check for reuse
  const dbToken = await refreshTokenFamilyModel.findByToken(token);
  if (!dbToken || dbToken.is_revoked) {
    // Revoke the whole family if reused
    if (decoded.familyId && decoded.userId) {
      await refreshTokenFamilyModel.revokeFamily(decoded.familyId, decoded.userId, 'reuse_detected');
    }
    throw new Error("Refresh token reuse detected. All tokens in this chain are revoked. Please re-login.");
  }
  return decoded;
}

/**
 * Checks if a token is expired without throwing an error
 * @param token - JWT token to check
 * @returns True if token is expired, false otherwise
 */
export function isTokenExpired(token: string): boolean {
  try {
    verifyToken(token);
    return false;
  } catch (error) {
    return error instanceof Error && error.message === "Token has expired";
  }
}
