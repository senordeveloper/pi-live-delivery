import type { IncomingMessage } from 'node:http';

/** Buffer bytes before decoding so network chunks cannot split UTF-8 characters. */
export function readRequestBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (error: Error) => {
      failed = true;
      chunks.length = 0;
      reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        // Drain the remaining input without retaining it or accepting a partial body.
        fail(new Error('Request too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('Request interrupted.')));
  });
}
