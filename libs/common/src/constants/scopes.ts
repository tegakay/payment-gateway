export const API_KEY_SCOPES = ['payments:read', 'payments:write', 'refunds:write'] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
