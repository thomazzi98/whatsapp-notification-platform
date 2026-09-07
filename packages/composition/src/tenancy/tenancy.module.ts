import { Module } from '@nestjs/common';

import { ApiKeyService } from './api-key.service';
import { ApplicationService } from './application.service';

@Module({
  providers: [ApplicationService, ApiKeyService],
  exports: [ApplicationService, ApiKeyService],
})
export class TenancyModule {}
