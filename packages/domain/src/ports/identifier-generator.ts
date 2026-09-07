/**
 * Identifiers for the hot tables are time-ordered (UUIDv7), which keeps B-tree
 * inserts appending at the right edge instead of scattering random pages.
 */
export interface IdentifierGeneratorPort {
  generate: () => string;
}

export const IDENTIFIER_GENERATOR_PORT = Symbol('IdentifierGeneratorPort');
