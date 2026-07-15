import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy';
import { JwtAccessGuard } from './guards/jwt-access.guard';
import { ApiKeyGuard } from './guards/api-key.guard';
import { FlexibleAuthGuard } from './guards/flexible-auth.guard';
import { ScopesGuard } from './guards/scopes.guard';
import { LoginThrottleGuard } from './guards/login-throttle.guard';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAccessStrategy,
    JwtAccessGuard,
    ApiKeyGuard,
    FlexibleAuthGuard,
    ScopesGuard,
    LoginThrottleGuard,
  ],
  exports: [AuthService, JwtAccessGuard, ApiKeyGuard, FlexibleAuthGuard, ScopesGuard],
})
export class AuthModule {}
