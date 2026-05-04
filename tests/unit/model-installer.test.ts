import { describe, it, expect } from 'vitest';
import { JsonlParser } from '../../src/main/model-installer.js';

describe('JsonlParser', () => {
  it('emits one event per complete line', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed('{"event":"file_start","name":"a","size":10}\n');
    expect(events).toEqual([{ event: 'file_start', name: 'a', size: 10 }]);
  });

  it('buffers partial lines until newline arrives', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed('{"event":"prog');
    p.feed('ress","name":"a","bytes":1,"total":10}\n');
    expect(events).toHaveLength(1);
    expect((events[0] as { event: string }).event).toBe('progress');
  });

  it('handles multiple events in one chunk', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed(
      '{"event":"file_start","name":"a","size":10}\n' +
        '{"event":"file_done","name":"a"}\n',
    );
    expect(events).toHaveLength(2);
  });

  it('drops malformed lines without throwing', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed('not json\n{"event":"complete","repo":"r"}\n');
    expect(events).toEqual([{ event: 'complete', repo: 'r' }]);
  });

  it('flushes the trailing buffer on end()', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed('{"event":"complete","repo":"r"}'); // no trailing \n
    p.end();
    expect(events).toHaveLength(1);
  });
});
