'use strict';

// Customer-specific hosting profiles are not part of the standalone web edition.
// Reject activation instead of silently disabling a requested security boundary.
function createPublicTenant(name) {
  if (name !== undefined) throw new Error('PANEL_TENANT is not supported in the standalone web edition. Use a separate Hub and gateway per trust boundary.');
  return null;
}
module.exports = { createPublicTenant };
