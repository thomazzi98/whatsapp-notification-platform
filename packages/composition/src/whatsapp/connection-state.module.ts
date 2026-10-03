import { Module } from '@nestjs/common';

import { ConnectionLimitsModule } from './connection-limits.module';
import { ConnectionStateService } from './connection-state.service';

/**
 * Its own module because both the dashboard's connections and delivery need
 * it, and neither should have to import the other's to get it.
 */
@Module({
  imports: [ConnectionLimitsModule],
  providers: [ConnectionStateService],
  exports: [ConnectionStateService],
})
export class ConnectionStateModule {}
