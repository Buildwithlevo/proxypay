import { Request, Response, NextFunction } from "express";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { redisClient } from "../config/redis";

// Define tiers
export type UserTier = "free" | "pro" | "enterprise";

export interface TierConfig {
  points: number;
  duration: number;
  keyPrefix: string;
}

export const TIER_CONFIGS: Record<UserTier, TierConfig> = {
  free: {
    points: 100, // 100 requests
    duration: 60, // per 60 seconds
    keyPrefix: "rl_free"
  },
  pro: {
    points: 1000, // 1000 requests
    duration: 60, // per 60 seconds
    keyPrefix: "rl_pro"
  },
  enterprise: {
    points: 10000, // 10000 requests
    duration: 60, // per 60 seconds
    keyPrefix: "rl_enterprise"
  },
};

const limiters = new Map<UserTier, RateLimiterRedis>();

function getLimiter(tier: UserTier): RateLimiterRedis {
  if (!limiters.has(tier)) {
    const config = TIER_CONFIGS[tier];
    limiters.set(tier, new RateLimiterRedis({
      storeClient: redisClient,
      ...config,
    }));
  }
  return limiters.get(tier)!;
}

function getTier(req: Request): UserTier {
  // Check user tier from JWT or session
  // Default to free if not authenticated or tier not specified
  const user = req.user as any;
  const jwtUser = req.jwtUser as any;
  
  const tier = user?.tier || jwtUser?.tier || "free";
  
  // Validate tier
  if (["free", "pro", "enterprise"].includes(tier)) {
    return tier as UserTier;
  }
  
  return "free";
}

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip;
  const userId = req.jwtUser?.userId || req.user?.id;
  const tier = getTier(req);
  const key = userId ? `${tier}:${userId}` : `${tier}:ip:${ip}`;
  const limiter = getLimiter(tier);

  try {
    await limiter.consume(key);
    next();
  } catch (rejRes) {
    const retrySecs = Math.round(rejRes.msBeforeNext / 1000) || 1;
    res.set("Retry-After", String(retrySecs));
    res.status(429).json({
      error: "Too Many Requests",
      message: `Rate limit exceeded for ${tier} tier. Try again in ${retrySecs} seconds.`,
      tier,
      limit: TIER_CONFIGS[tier].points,
      windowSeconds: TIER_CONFIGS[tier].duration,
    });
  }
}

export function getTierConfig(tier: UserTier): TierConfig {
  return TIER_CONFIGS[tier];
}

export function getTierFromRequest(req: Request): UserTier {
  return getTier(req);
}
