import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

export const FAKE_PUBLIC_HOST = "93.184.216.34";

export function installFakeHttps(pages: Record<string, string>): { hits: string[]; restore: () => void; } {
  const target = https as unknown as { request: unknown; };
  const original = target.request;
  const hits: string[] = [];
  target.request = (options: { headers: { host: string; }; path: string; }, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void; };
    request.destroy = () => { };
    request.end = () => setImmediate(() => {
      const url = `https://${options.headers.host}${options.path}`;
      hits.push(url);
      const body = pages[url];
      const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void; };
      response.statusCode = body === undefined ? 404 : 200;
      response.headers = { "content-type": "text/html; charset=utf-8" };
      response.destroy = () => { };
      callback(response);
      setImmediate(() => {
        response.emit("data", Buffer.from(body ?? ""));
        response.emit("end");
      });
    });
    return request;
  };
  syncBuiltinESMExports();
  return {
    hits,
    restore: () => {
      target.request = original;
      syncBuiltinESMExports();
    },
  };
}
