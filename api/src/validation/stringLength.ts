import { z } from 'zod';

// Public text limits match String.length and browser maxlength (UTF-16 units).
// Zod 4.5's built-in string max now counts Unicode code points instead.
export function maxUtf16Length(maximum: number) {
  return z.check<string>((ctx) => {
    if (ctx.value.length > maximum) {
      ctx.issues.push({
        code: 'too_big',
        origin: 'string',
        maximum,
        inclusive: true,
        input: ctx.value,
        continue: true,
      });
    }
  });
}
