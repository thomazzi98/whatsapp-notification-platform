import { DatabaseHealthService, type DependencyCheckResult } from '@platform/composition';
import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import { type FastifyReply } from 'fastify';

interface LivenessResponse {
  readonly status: 'ok';
  readonly service: string;
  readonly uptimeSeconds: number;
}

interface ReadinessResponse {
  readonly status: 'ready' | 'not_ready';
  readonly checks: Readonly<Record<string, DependencyCheckResult>>;
}

@Controller()
export class HealthController {
  private readonly databaseHealth: DatabaseHealthService;

  public constructor(databaseHealth: DatabaseHealthService) {
    this.databaseHealth = databaseHealth;
  }

  /**
   * Liveness. Deliberately checks no dependency.
   *
   * A liveness probe that touches the database turns a thirty second Postgres
   * blip into a restart storm, converting a recoverable dependency outage into
   * an outage of the whole platform.
   */
  @Get('health')
  @HttpCode(200)
  public liveness(): LivenessResponse {
    return {
      status: 'ok',
      service: 'api',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  /**
   * Readiness. Reports whether this instance can do useful work.
   *
   * The WhatsApp provider is deliberately absent from this probe: notifications
   * still validate, persist and queue while WhatsApp is unreachable, and taking
   * the API out of service then would hide the queue exactly when an operator
   * needs to see it.
   */
  @Get('ready')
  public async readiness(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReadinessResponse> {
    const database = await this.databaseHealth.check();
    const isReady = database.status === 'up';

    void reply.status(isReady ? 200 : 503);

    return {
      status: isReady ? 'ready' : 'not_ready',
      checks: { database },
    };
  }
}
