import { Module } from '@nestjs/common';

import { WhatsAppSessionService } from './whatsapp-session.service';

@Module({
  providers: [WhatsAppSessionService],
  exports: [WhatsAppSessionService],
})
export class WhatsAppSessionModule {}
