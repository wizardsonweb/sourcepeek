import handlerMod from './server/handler.cjs';

const { handle, routeFromUrl, readBody, send } = handlerMod;

export default async function sourcepeekApi(req, res) {
  const [status, obj, extra] = await handle({
    method: req.method,
    route: routeFromUrl(req.url) || '',
    headers: req.headers,
    getBody: (limit) => readBody(req, limit),
    root: process.cwd(),
    remote: req.socket ? req.socket.remoteAddress : null,
    https: Boolean(req.socket && req.socket.encrypted),
  });
  send(res, status, obj, extra);
}
