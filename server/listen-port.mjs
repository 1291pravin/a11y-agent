// Bind an HTTP server to the first available port starting at `preferredPort`.
// On EADDRINUSE, tries preferredPort + 1, + 2, … (same pattern as Vite preview).

const MAX_ATTEMPTS = 50;

/**
 * @param {import('node:http').Server} server
 * @param {{ host?: string; preferredPort: number; strict?: boolean }} opts
 * @returns {Promise<number>} port the server is listening on
 */
export function listenAvailable(server, { host, preferredPort, strict = false }) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;
    let attempts = 0;

    const tryListen = () => {
      if (attempts >= MAX_ATTEMPTS) {
        reject(new Error(`no available port found near ${preferredPort} (${MAX_ATTEMPTS} attempts)`));
        return;
      }
      attempts += 1;

      const onError = (err) => {
        if (err?.code === 'EADDRINUSE' && !strict) {
          server.off('error', onError);
          port += 1;
          tryListen();
          return;
        }
        reject(err);
      };

      server.once('error', onError);
      const onListening = () => {
        server.off('error', onError);
        resolve(port);
      };

      if (host != null) server.listen(port, host, onListening);
      else server.listen(port, onListening);
    };

    tryListen();
  });
}
