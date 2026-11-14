/** Release gate, deliberately not an environment flag or browser preference.
 * Replace only after Horizon auth, authorized APIs, and reviewed contracts exist.
 */
export const horizonIntegrations = Object.freeze({
  authentication: false,
  authorizedReadApis: false,
})
