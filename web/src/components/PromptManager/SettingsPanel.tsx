import ModelResolutionSection from './ModelResolutionSection';
import ModelStepsSection from './ModelStepsSection';
import styles from './SettingsPanel.module.css';

// Each section owns its own loading and error state. Text-model picks live in
// the Text models view.
export default function SettingsPanel() {
  return (
    <div className={styles.stack}>
      <ModelStepsSection />
      <ModelResolutionSection />
    </div>
  );
}
