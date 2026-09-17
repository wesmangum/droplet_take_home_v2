import { createLogger } from '../src/services/logger';

describe('JSON logger', () => {
  it('emits one JSON object per line with level, msg, time, and fields', () => {
    const lines: Array<{ level: string; line: string }> = [];
    const log = createLogger((level, line) => {
      lines.push({ level, line });
    });

    log.info('hello', { eventId: 'e1', n: 2 });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('info');

    const parsed = JSON.parse(lines[0]!.line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 'info',
      msg: 'hello',
      eventId: 'e1',
      n: 2,
    });
    expect(parsed.time).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(parsed.time as string))).toBe(false);
  });

  it('routes warn and error to the sink with the matching level', () => {
    const levels: string[] = [];
    const log = createLogger((level) => {
      levels.push(level);
    });

    log.warn('w');
    log.error('e');
    log.debug('d');

    expect(levels).toEqual(['warn', 'error', 'debug']);
  });

  it('does not let fields overwrite level, msg, or time', () => {
    const lines: string[] = [];
    const log = createLogger((_level, line) => {
      lines.push(line);
    });

    log.info('real message', {
      level: 'debug',
      msg: 'spoofed',
      time: 'not-a-real-time',
      eventId: 'e1',
    });

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('real message');
    expect(parsed.time).not.toBe('not-a-real-time');
    expect(parsed.eventId).toBe('e1');
  });
});
