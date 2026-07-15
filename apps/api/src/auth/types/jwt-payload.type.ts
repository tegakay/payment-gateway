export interface AccessTokenPayload {
  sub: string;
  merchantId: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  merchantId: string;
  type: 'refresh';
  jti: string;
}
