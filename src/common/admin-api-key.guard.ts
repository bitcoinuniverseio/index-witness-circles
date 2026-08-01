import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AppConfiguration } from '../config/configuration';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  private readonly allowed: Buffer[];

  constructor(configService: ConfigService<AppConfiguration, true>) {
    this.allowed = configService.get('security', { infer: true }).adminApiKeys.map(digest);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const value = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const candidate = digest(value);
    if (
      this.allowed.length > 0 &&
      this.allowed.some((expected) => timingSafeEqual(expected, candidate))
    ) {
      return true;
    }
    throw new UnauthorizedException('A valid admin bearer token is required');
  }
}
