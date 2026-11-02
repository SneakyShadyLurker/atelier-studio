import { METRICS_LIMITS } from '@atelier/shared';
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';
import { sendMetricBeacon } from './metricsBeacon';

const DEBUG_FLAG = 'debug=vitals';

const isDebug = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.location.search.includes(DEBUG_FLAG);
};

const isDev = (): boolean => import.meta.env.DEV;

const handler = (metric: Metric): void => {
  const payload = {
    kind: 'vitals',
    name: metric.name,
    value: metric.value,
    delta: metric.delta,
    id: metric.id,
    rating: metric.rating,
    navigationType: metric.navigationType,
    ...(typeof window !== 'undefined' ? { href: window.location.href.slice(0, METRICS_LIMITS.href) } : {}),
  };
  if (isDebug() || isDev()) {
    console.log('[web-vitals]', metric.name, metric.value, metric);
    return;
  }
  sendMetricBeacon(payload);
};

export const startWebVitals = (): void => {
  onINP(handler);
  onLCP(handler);
  onCLS(handler);
  onFCP(handler);
  onTTFB(handler);
};
