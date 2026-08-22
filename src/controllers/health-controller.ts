import { Controller, Get } from '@nestjs/common';

@Controller('healthcheck')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
