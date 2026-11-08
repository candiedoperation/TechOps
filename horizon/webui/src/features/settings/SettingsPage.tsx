import { Monitor, Moon, Sun } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { useAppearance } from '../../theme/context'
import { isAppearance } from '../../theme/appearance'

export function SettingsPage() {
  const { appearance, resolved, setAppearance, storageAvailable } = useAppearance()
  return (
    <>
      <div className="page-intro">
        <div>
          <p className="eyebrow">WORKSPACE PREFERENCES</p>
          <h1>Settings</h1>
          <p>Make Horizon comfortable to work in. These preferences are saved on this browser.</p>
        </div>
      </div>
      <Card title="Appearance" description="Choose a theme or follow your operating system.">
        <div className="settings-body">
          <div className="appearance-options" role="group" aria-label="Appearance presets">
            {[
              { value: 'system', label: 'System', Icon: Monitor, note: 'Follow your device' },
              { value: 'light', label: 'Light', Icon: Sun, note: 'A brighter workspace' },
              { value: 'dark', label: 'Dark', Icon: Moon, note: 'A lower-light workspace' },
            ].map(({ value, label, Icon, note }) => (
              <button
                key={value}
                className="appearance-option"
                aria-label={`${label} appearance`}
                aria-pressed={appearance === value}
                onClick={() => {
                  if (isAppearance(value)) setAppearance(value)
                }}
              >
                <Icon size={20} aria-hidden="true" />
                <strong>{label}</strong>
                <span>{note}</span>
              </button>
            ))}
          </div>
          <label className="form-field">
            Appearance
            <select
              value={appearance}
              onChange={(event) => {
                if (isAppearance(event.target.value)) setAppearance(event.target.value)
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <p className="settings-note" role="status">
            {appearance === 'system'
              ? `Following your device: ${resolved}. Changes to your system appearance apply automatically.`
              : `${resolved === 'dark' ? 'Dark' : 'Light'} appearance is selected. System changes will not override it.`}
          </p>
          {!storageAvailable && (
            <p className="settings-note" role="alert">
              Your browser could not save this preference. It still applies for this visit.
            </p>
          )}
        </div>
      </Card>
      <Card
        title="Access & data"
        description="Appearance works independently of sign-in and data connections."
      >
        <p className="principle-copy">
          Horizon sign-in and protected read APIs are awaiting backend integration. Changing
          appearance does not enable data access or change permissions.
        </p>
      </Card>
    </>
  )
}
