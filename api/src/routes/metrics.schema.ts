import { METRICS_LIMITS } from '@atelier/shared';
import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';

const VitalsMetric = z.object({
  kind: z.literal('vitals'),
  name: z.enum(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']),
  value: z.number(),
  delta: z.number().optional(),
  id: z.string().min(1).check(maxUtf16Length(METRICS_LIMITS.vitalsId)).optional(),
  rating: z.enum(['good', 'needs-improvement', 'poor']).optional(),
  navigationType: z.string().check(maxUtf16Length(METRICS_LIMITS.navigationType)).optional(),
  href: z.url().check(maxUtf16Length(METRICS_LIMITS.href)).optional(),
});

const ErrorMetric = z.object({
  kind: z.literal('error'),
  name: z.string().check(maxUtf16Length(METRICS_LIMITS.name)),
  message: z.string().check(maxUtf16Length(METRICS_LIMITS.message)),
  stack: z.string().check(maxUtf16Length(METRICS_LIMITS.stack)).optional(),
  componentStack: z.string().check(maxUtf16Length(METRICS_LIMITS.stack)).optional(),
  userAgent: z.string().check(maxUtf16Length(METRICS_LIMITS.userAgent)).optional(),
  href: z.string().check(maxUtf16Length(METRICS_LIMITS.href)).optional(),
});

export const MetricsBody = z.discriminatedUnion('kind', [VitalsMetric, ErrorMetric]);
export type MetricsBody = z.infer<typeof MetricsBody>;
