/**
 * Typed errors for the settings API's HTTP mapping.
 *
 * `statusFor` (settings-endpoint.ts) used to classify errors by matching
 * message text — stable enough until a message drifted and a refused write
 * answered 504, telling the client to retry a request that can never succeed
 * (#240). The classes below carry the classification at the THROW site, where
 * the intent is known, so the router never has to guess from prose.
 *
 * Plain `Error` stays the default and maps to 400 (the client's request was
 * wrong) — that is the correct answer for the bulk of validation throws.
 */

/**
 * The local environment is broken: a config file exists but cannot be read or
 * parsed, or a write was refused to protect it. Not the client's fault —
 * answer 500 so operators see it instead of the client silently retrying.
 */
export class BrokenConfigError extends Error {}

/**
 * A remote upstream failed: the coding-plan reset API, a release manifest, a
 * dist download. Answer 502 — retrying LATER may work, retrying the identical
 * request immediately will not.
 */
export class UpstreamError extends Error {}
