import {
  ApplicationService,
  type AuthenticatedPrincipal,
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
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../http/authentication/authenticated-request';
import { DashboardSessionGuard } from '../../http/authentication/dashboard-session.guard';
import { ZodValidationPipe } from '../../http/validation/zod-validation.pipe';
import { UuidParameterPipe } from '../../http/validation/uuid-parameter.pipe';
import {
  toNotificationEventResponse,
  toNotificationResponse,
} from '../../public-api/notifications/notification-response';

/**
 * The same notifications the public API serves, reached with a session cookie
 * instead of an API key.
 *
 * Two authentication surfaces over one query layer: a person signed in to the
 * dashboard and a machine holding a key are asking the same question, and the
 * answer must not be able to differ between them. Only the guard changes.
 */
@Controller('dashboard/applications/:applicationId/notifications')
@UseGuards(DashboardSessionGuard)
export class DashboardNotificationsController {
  private readonly notifications: NotificationQueryService;
  private readonly notificationCreation: CreateNotificationService;
  private readonly applications: ApplicationService;

  public constructor(
    notifications: NotificationQueryService,
    notificationCreation: CreateNotificationService,
    applications: ApplicationService,
  ) {
    this.notifications = notifications;
    this.notificationCreation = notificationCreation;
    this.applications = applications;
  }

  /**
   * Establishing the application under the caller's organization first is what
   * stops one tenant's delivery history being read by another.
   */
  private async authorize(principal: AuthenticatedPrincipal, applicationId: string): Promise<void> {
    await this.applications.getOrFail(principal.organizationId, applicationId);
  }

  @Get()
  public async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Query(new ZodValidationPipe(notificationListQuerySchema))
    query: {
      status?: NotificationStatus | NotificationStatus[];
      recipient?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ data: NotificationResponse[]; nextCursor: string | null }> {
    await this.authorize(principal, applicationId);

    const statuses = query.status === undefined ? undefined : [query.status].flat();
    const result = await this.notifications.list(applicationId, {
      ...(statuses !== undefined && { statuses }),
      ...(query.recipient !== undefined && { recipient: query.recipient }),
      ...(query.cursor !== undefined && { cursor: query.cursor }),
      limit: query.limit,
    });

    return {
      data: result.items.map((record) => toNotificationResponse(record)),
      nextCursor: result.nextCursor,
    };
  }

  /**
   * Sending from the dashboard goes through the same service as the API, so a
   * message composed by a person and one posted by a machine are subject to the
   * same idempotency, scheduling and validation rules.
   */
  @Post()
  @HttpCode(202)
  public async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Body(new ZodValidationPipe(notificationCreationRequestSchema))
    body: NotificationCreationRequest,
  ): Promise<NotificationResponse> {
    await this.authorize(principal, applicationId);

    const result = await this.notificationCreation.create({
      applicationId,
      recipient: body.recipient,
      body: body.body,
      ...(body.whatsAppSessionId !== undefined && { whatsAppSessionId: body.whatsAppSessionId }),
      ...(body.scheduledAt !== undefined && { scheduledAt: new Date(body.scheduledAt) }),
      ...(body.maximumAttempts !== undefined && { maximumAttempts: body.maximumAttempts }),
      metadata: body.metadata,
      requestPath: `/dashboard/applications/${applicationId}/notifications`,
    });

    return toNotificationResponse(result.notification);
  }

  @Get(':notificationId')
  public async get(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('notificationId', new UuidParameterPipe('notificationId')) notificationId: string,
  ): Promise<NotificationResponse> {
    await this.authorize(principal, applicationId);

    return toNotificationResponse(
      await this.notifications.getOrFail(applicationId, notificationId),
    );
  }

  @Get(':notificationId/events')
  public async listEvents(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('notificationId', new UuidParameterPipe('notificationId')) notificationId: string,
  ): Promise<{ data: NotificationEventResponse[] }> {
    await this.authorize(principal, applicationId);
    const events: readonly NotificationEventRecord[] = await this.notifications.listEvents(
      applicationId,
      notificationId,
    );

    return { data: events.map((record) => toNotificationEventResponse(record)) };
  }

  @Post(':notificationId/cancel')
  @HttpCode(200)
  public async cancel(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('notificationId', new UuidParameterPipe('notificationId')) notificationId: string,
  ): Promise<NotificationResponse> {
    await this.authorize(principal, applicationId);
    const record: NotificationRecord = await this.notifications.cancel(
      applicationId,
      notificationId,
    );

    return toNotificationResponse(record);
  }
}
