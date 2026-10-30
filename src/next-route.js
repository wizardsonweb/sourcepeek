import handlerMod from './server/handler.cjs';

const { handle, routeFromUrl } = handlerMod;

async function run(request) {
  const url = new URL(request.url);
  const route = routeFromUrl(url.pathname) || '';
  const [status, obj, extra] = await handle({
    method: request.method,
    route,
    headers: request.headers,
    getBody: async (limit) => {
      const text = await request.text().catch(() => '');
      if (limit && text.length > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
    },
    root: process.cwd(),
    https: url.protocol === 'https:',
  });
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(extra || {}) },
  });
}

export const GET = run;
export const POST = run;
