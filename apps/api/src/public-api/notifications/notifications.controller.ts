import {
  type ApiKeyPrincipal,
  CreateNotificationService,
  type NotificationEventRecord,
  NotificationQueryService,
  type NotificationRecord,
} from '@platform/composition';
import {
  type NotificationCreationRequest,
  notificationCreationRequestSchema,
  type NotificationEventResponse,
  notificationListQuerySchema,
  type NotificationResponse,
} from '@platform/contracts';
import { type NotificationStatus } from '@platform/domain';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { type FastifyReply } from 'fastify';

import { ApiKeyGuard, RequireScopes } from '../../http/authentication/api-key.guard';
import { CurrentApiKey } from '../../http/authentication/authenticated-request';
import { ZodValidationPipe } from '../../http/validation/zod-validation.pipe';

function toResponse(record: NotificationRecord): NotificationResponse {
  return {
    id: record.id,
    status: record.status,
    recipient: record.recipientPhoneNumber,
    body: record.renderedBody,
    whatsAppSessionId: record.whatsAppSessionId,
    scheduledAt: record.scheduledAt?.toISOString() ?? null,
    attemptCount: record.attemptCount,
    maximumAttempts: record.maximumAttempts,
    nextAttemptAt: record.nextAttemptAt?.toISOString() ?? null,
    providerMessageId: record.providerMessageId,
    sentAt: record.sentAt?.toISOString() ?? null,
    deliveredAt: record.deliveredAt?.toISOString() ?? null,
    readAt: record.readAt?.toISOString() ?? null,
    failedAt: record.failedAt?.toISOString() ?? null,
    failureCode: record.failureCode,
    failureReason: record.failureReason,
    metadata: record.metadata,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toEventResponse(record: NotificationEventRecord): NotificationEventResponse {
  return {
    id: record.id,
    eventType: record.eventType,
    fromStatus: record.fromStatus,
    toStatus: record.toStatus,
    attemptNumber: record.attemptNumber,
    payload: record.payload,
    occurredAt: record.occurredAt.toISOString(),
  };
}

function toStatusList(
  status: NotificationStatus | NotificationStatus[] | undefined,
): readonly NotificationStatus[] | undefined {
  if (status === undefined) {
    return undefined;
  }
  return Array.isArray(status) ? status : [status];
}

@Controller('v1/notifications')
@UseGuards(ApiKeyGuard)
export class NotificationsController {
  private readonly notificationCreation: CreateNotificationService;
  private readonly notifications: NotificationQueryService;

  public constructor(
    notificationCreation: CreateNotificationService,
    notifications: NotificationQueryService,
  ) {
    this.notificationCreation = notificationCreation;
    this.notifications = notifications;
  }

  /**
   * Accepts a notification for delivery.
   *
   * Returns 202 rather than 200: the notification has been persisted and
   * queued, not delivered. Saying "accepted" is the honest answer, and it is
   * why the API responds in milliseconds while WhatsApp takes seconds.
   */
  @Post()
  @HttpCode(202)
  @RequireScopes('notifications:write')
  public async create(
    @CurrentApiKey() principal: ApiKeyPrincipal,
    @Body(new ZodValidationPipe(notificationCreationRequestSchema))
    body: NotificationCreationRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<NotificationResponse> {
    const result = await this.notificationCreation.create({
      applicationId: principal.applicationId,
      recipient: body.recipient,
      body: body.body,
      ...(body.whatsAppSessionId !== undefined && {
        whatsAppSessionId: body.whatsAppSessionId,
      }),
      ...(body.scheduledAt !== undefined && { scheduledAt: new Date(body.scheduledAt) }),
      ...(body.maximumAttempts !== undefined && { maximumAttempts: body.maximumAttempts }),
      metadata: body.metadata,
      ...(idempotencyKey !== undefined && { idempotencyKey }),
      requestPath: '/v1/notifications',
    });

    if (result.wasReplayed) {
      // The caller learns that this response is a replay rather than a second
      // notification, which is the difference between "it worked twice" and
      // "it worked once and you asked twice".
      void reply.header('idempotent-replayed', 'true');
    }

    return toResponse(result.notification);
  }

  @Get()
  @RequireScopes('notifications:read')
  public async list(
    @CurrentApiKey() principal: ApiKeyPrincipal,
    @Query(new ZodValidationPipe(notificationListQuerySchema))
    query: {
      status?: NotificationStatus | NotificationStatus[];
      recipient?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ data: NotificationResponse[]; nextCursor: string | null }> {
    const statuses = toStatusList(query.status);
    const result = await this.notifications.list(principal.applicationId, {
      ...(statuses !== undefined && { statuses }),
      ...(query.recipient !== undefined && { recipient: query.recipient }),
      ...(query.cursor !== undefined && { cursor: query.cursor }),
      limit: query.limit,
    });

    return {
      data: result.items.map((record) => toResponse(record)),
      nextCursor: result.nextCursor,
    };
  }

  @Get(':notificationId')
  @RequireScopes('notifications:read')
  public async get(
    @CurrentApiKey() principal: ApiKeyPrincipal,
    @Param('notificationId') notificationId: string,
  ): Promise<NotificationResponse> {
    const record = await this.notifications.getOrFail(principal.applicationId, notificationId);

    return toResponse(record);
  }

  @Get(':notificationId/events')
  @RequireScopes('notifications:read')
  public async listEvents(
    @CurrentApiKey() principal: ApiKeyPrincipal,
    @Param('notificationId') notificationId: string,
  ): Promise<{ data: NotificationEventResponse[] }> {
    const events = await this.notifications.listEvents(principal.applicationId, notificationId);

    return { data: events.map((record) => toEventResponse(record)) };
  }

  @Post(':notificationId/cancel')
  @HttpCode(200)
  @RequireScopes('notifications:write')
  public async cancel(
    @CurrentApiKey() principal: ApiKeyPrincipal,
    @Param('notificationId') notificationId: string,
  ): Promise<NotificationResponse> {
    const record = await this.notifications.cancel(principal.applicationId, notificationId);

    return toResponse(record);
  }
}
