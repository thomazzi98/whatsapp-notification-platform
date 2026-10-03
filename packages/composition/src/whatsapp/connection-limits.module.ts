import { Module } from '@nestjs/common';

import { ConnectionLimitsService } from './connection-limits.service';

/**
 * Separate from the connection state module so callback processing can have
 * it without a WhatsApp provider: recording a report needs only the database.
 */
@Module({
  providers: [ConnectionLimitsService],
  exports: [ConnectionLimitsService],
})
export class ConnectionLimitsModule {}
