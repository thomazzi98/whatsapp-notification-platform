import { Module } from '@nestjs/common';

import { ConnectionStateModule } from './connection-state.module';
import { WhatsAppSessionService } from './whatsapp-session.service';

@Module({
  imports: [ConnectionStateModule],
  providers: [WhatsAppSessionService],
  exports: [WhatsAppSessionService],
})
export class WhatsAppSessionModule {}
