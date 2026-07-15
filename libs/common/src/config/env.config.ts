import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  DATABASE_URL: Joi.string().required(),
  SHADOW_DATABASE_URL: Joi.string().optional(),
  REDIS_URL: Joi.string().required(),
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL: Joi.string().default('7d'),
  S3_ENDPOINT: Joi.string().required(),
  S3_BUCKET: Joi.string().required(),
  S3_ACCESS_KEY: Joi.string().required(),
  S3_SECRET_KEY: Joi.string().required(),
  WEBHOOK_SIGNING_SECRET_PEPPER: Joi.string().min(16).required(),
  API_KEY_PEPPER: Joi.string().min(16).required(),
  API_KEY_ROTATION_GRACE_MS: Joi.number().default(24 * 60 * 60 * 1000),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  PROCESS_TYPE: Joi.string().valid('api', 'worker').default('api'),
});
