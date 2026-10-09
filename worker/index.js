// FEDI Boards on Cloudflare. The page (site/) is served as static files;
// everything under /api goes to the one Durable Object that holds the board.

export { Board } from './board.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return env.BOARD.get(env.BOARD.idFromName('board')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
