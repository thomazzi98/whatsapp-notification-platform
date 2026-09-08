import { type ApplicationConfiguration } from '@platform/configuration';
import { type WhatsAppProviderPort, WHATSAPP_PROVIDER_PORT } from '@platform/domain';
import { WahaProvider } from '@platform/provider-whatsapp';
import { type DynamicModule, Global, Module } from '@nestjs/common';

/**
 * Binds the provider port to the WAHA adapter.
 *
 * Nothing outside this module names WAHA. The dispatch pipeline depends on the
 * port alone, which is what lets the same code run against the deterministic
 * stub in tests and against a real WhatsApp connection in production.
 */
@Global()
@Module({})
export class WhatsAppProviderModule {
  public static forConfiguration(configuration: ApplicationConfiguration): DynamicModule {
    return {
      module: this,
      providers: [
        {
          provide: WHATSAPP_PROVIDER_PORT,
          useFactory: (): WhatsAppProviderPort =>
            new WahaProvider({
              baseUrl: configuration.whatsAppProvider.baseUrl,
              apiKey: configuration.whatsAppProvider.apiKey,
              requestTimeoutMilliseconds: configuration.whatsAppProvider.requestTimeoutMilliseconds,
            }),
        },
      ],
      exports: [WHATSAPP_PROVIDER_PORT],
    };
  }
}
