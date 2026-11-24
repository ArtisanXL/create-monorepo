/** Runs first for /api/* (see wrangler.jsonc) and hands the request to the api Worker. */
interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => env.API.fetch(request),
};
