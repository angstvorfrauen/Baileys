//===================================//
import { makeMutex } from './make-mutex.js';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import { writeFile } from 'fs/promises';
import { delay } from './generics.js';
import EventEmitter from 'events';
//===================================//
export const captureEventStream = (ev, filename) => {
  const oldEmit = ev.emit;
  const writeMutex = makeMutex();
  ev.emit = function (...args) {
    const content = JSON.stringify({ timestamp: Date.now(), event: args[0], data: args[1] }) + '\n';
    const result = oldEmit.apply(ev, args);
    writeMutex.mutex(async () => {
      await writeFile(filename, content, { flag: 'a' });
    });
    return result;
  };
};
//===================================//
export const readAndEmitEventStream = (filename, delayIntervalMs = 0) => {
  const ev = new EventEmitter();
  const fireEvents = async () => {
    const fileStream = createReadStream(filename);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      if (line) {
        const { event, data } = JSON.parse(line);
        ev.emit(event, data);
        delayIntervalMs && (await delay(delayIntervalMs));
      }
    }
    fileStream.close();
  };
  return {
    ev,
    task: fireEvents()
  };
};
//===================================//