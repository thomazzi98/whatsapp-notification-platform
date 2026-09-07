// Record shapes are part of the contract of the services that return them, so
// applications import them from here rather than reaching into the persistence
// adapter directly.
export type { ApiKeyRecord, ApplicationRecord } from '@platform/database';
export {
  type AuthenticatedPrincipal,
  AuthenticationService,
  type EstablishedSession,
  type LoginInput,
  type RegisterInput,
} from './authentication/authentication.service';
export { AuthenticationModule } from './authentication/authentication.module';
export {
  DatabaseHealthService,
  type DependencyCheckResult,
} from './database/database-health.service';
export { DatabaseModule } from './database/database.module';
export { RuntimeModule } from './runtime/runtime.module';
export { type ApiKeyPrincipal, ApiKeyService, type CreatedApiKey } from './tenancy/api-key.service';
export { ApplicationService } from './tenancy/application.service';
export { TenancyModule } from './tenancy/tenancy.module';
export { APPLICATION_CONFIGURATION, DATABASE_CONNECTION } from './tokens';
