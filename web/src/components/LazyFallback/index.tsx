import styles from './index.module.css';

interface LazyFallbackProps {
  label: string;
  overlay?: boolean;
}

export function LazyFallback({ label, overlay = false }: LazyFallbackProps) {
  return (
    <div className={overlay ? styles.overlay : styles.inline} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
