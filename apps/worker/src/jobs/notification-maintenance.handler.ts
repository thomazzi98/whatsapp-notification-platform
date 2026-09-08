import { randomUUID } from 'node:crypto';

import { LOGGER, NotificationMaintenanceService } from '@platform/composition';
import { logEvents, runWithCorrelationContext } from '@platform/observability';
import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';

@Injectable()
export class NotificationMaintenanceHandler {
  private readonly maintenance: NotificationMaintenanceService;
  private readonly logger: Logger;

  public constructor(maintenance: NotificationMaintenanceService, @Inject(LOGGER) logger: Logger) {
    this.maintenance = maintenance;
    this.logger = logger;
  }

  /**
   * A cron job has no request behind it, so it starts its own correlation
   * scope. Without one, the repairs it makes would be the only events in the
   * system that cannot be traced.
   */
  public async handle(): Promise<void> {
    await runWithCorrelationContext({ correlationId: randomUUID() }, async () => {
      const report = await this.maintenance.runOnce();

      if (report.reapedClaims === 0 && report.requeuedNotifications === 0) {
        this.logger.debug(
          { event: logEvents.queueJobCompleted, ...report },
          'Maintenance found nothing to repair',
        );
        return;
      }

      this.logger.warn(
        { event: logEvents.queueJobCompleted, ...report },
        'Maintenance repaired stalled deliveries',
      );
    });
  }
}
