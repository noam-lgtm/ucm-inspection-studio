/*
 * Deployment configuration. Edit this file once after setting up the sync server.
 *
 * syncUrl: the address printed by `node worker/setup.mjs`, e.g.
 *          'https://ucm-inspection-sync.example.workers.dev'
 *          When set, the app shows a lock screen and requires the company access key
 *          (verified against the server) before anything is shown on a new computer.
 *          Leave empty to run the app locally without a lock screen.
 */
export const CONFIG = {
  syncUrl: '',
};
