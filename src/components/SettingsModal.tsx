import { useEffect, useState, type ReactElement } from 'react';
import { MUSIC_TRACKS, type MusicSelection } from '../audio/soundTypes';
import type { UserSettings } from '../state/storageTypes';
import { CandyIcon, type IconKind } from './CandyIcon';
import { ModalShell } from './LevelModals';

export interface SettingsModalProps {
  settings: UserSettings;
  onChange: (partial: Partial<UserSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}

function isStandalone(): boolean {
  try {
    const nav = navigator as Navigator & { standalone?: boolean };
    return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

function Toggle({
  label,
  detail,
  icon,
  checked,
  onChange,
}: {
  label: string;
  detail?: string;
  icon: IconKind;
  checked: boolean;
  onChange: (next: boolean) => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`setting-row setting-row--toggle${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="setting-row__icon">
        <CandyIcon kind={icon} size={26} />
      </span>
      <span className="setting-row__text">
        <span className="setting-row__label">{label}</span>
        {detail ? <span className="setting-row__detail">{detail}</span> : null}
      </span>
      <span className="switch" aria-hidden="true">
        <span className="switch__knob" />
      </span>
    </button>
  );
}

function VolumeSlider({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}): ReactElement {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <label className={`volume${disabled ? ' is-disabled' : ''}`}>
      <span className="visually-hidden">{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={pct}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.currentTarget.value) / 100)}
        style={{ ['--pct' as string]: `${pct}%` }}
      />
      <span className="volume__value">{pct}%</span>
    </label>
  );
}

export function SettingsModal({ settings, onChange, onReset, onClose }: SettingsModalProps): ReactElement {
  const [confirmReset, setConfirmReset] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => setInstalled(isStandalone()), []);

  useEffect(() => {
    if (!confirmReset) return;
    const t = window.setTimeout(() => setConfirmReset(false), 5000);
    return () => window.clearTimeout(t);
  }, [confirmReset]);

  return (
    <ModalShell label="Settings" className="settings" onEscape={onClose}>
      <header className="settings__header">
        <h2 className="modal__title">Settings</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings" data-autofocus>
          <CandyIcon kind="close" size={24} />
        </button>
      </header>

      <div className="settings__body">
        <section className="settings__group" aria-label="Audio">
          <h3 className="settings__group-title">Sound</h3>
          <Toggle
            label="Sound Effects"
            icon="sound"
            checked={settings.sfxEnabled}
            onChange={(v) => onChange({ sfxEnabled: v })}
          />
          <VolumeSlider
            label="Sound effects volume"
            value={settings.sfxVolume}
            disabled={!settings.sfxEnabled}
            onChange={(v) => onChange({ sfxVolume: v })}
          />
          <Toggle
            label="Background Music"
            detail="4 studio tracks · tap ♪ mid-level to switch"
            icon="music"
            checked={settings.musicEnabled}
            onChange={(v) => onChange({ musicEnabled: v })}
          />
          <VolumeSlider
            label="Music volume"
            value={settings.musicVolume}
            disabled={!settings.musicEnabled}
            onChange={(v) => onChange({ musicVolume: v })}
          />
          <div className={`music-picker${settings.musicEnabled ? '' : ' is-disabled'}`} role="radiogroup" aria-label="Music track">
            {(
              [
                { id: 'auto' as MusicSelection, label: 'Auto Rotate' },
                ...MUSIC_TRACKS.map((t) => ({ id: t.id as MusicSelection, label: t.label })),
              ] as const
            ).map((opt) => {
              const active = settings.musicTrack === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!settings.musicEnabled}
                  className={`music-chip${active ? ' is-active' : ''}`}
                  onClick={() => onChange({ musicTrack: opt.id })}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="music-credit">
            Music by Kevin MacLeod (incompetech.com) · CC BY 4.0
          </p>
        </section>

        <section className="settings__group" aria-label="Accessibility">
          <h3 className="settings__group-title">Comfort</h3>
          <Toggle
            label="Colorblind Emblems"
            detail="Adds a shape badge to every candy"
            icon="purple"
            checked={settings.colorblindMode}
            onChange={(v) => onChange({ colorblindMode: v })}
          />
          <Toggle
            label="Reduced Motion"
            detail="Calmer effects, no screen shake"
            icon="retry"
            checked={settings.reducedMotion}
            onChange={(v) => onChange({ reducedMotion: v })}
          />
        </section>

        <section className="install-card" aria-label="Install on iPad Home Screen">
          <div className="install-card__head">
            <img className="install-card__app" src="./icons/apple-touch-icon.png" alt="" width={52} height={52} />
            <div>
              <h3 className="install-card__title">Install on iPad Home Screen</h3>
              <p className="install-card__sub">
                {installed ? 'Installed — you’re playing full-screen.' : 'Full-screen play that works offline.'}
              </p>
            </div>
          </div>
          {installed ? null : (
            <ol className="install-steps">
              <li>
                <span className="install-steps__icon">
                  <CandyIcon kind="share" size={22} />
                </span>
                <span>
                  Tap <strong>Share</strong> in Safari
                </span>
              </li>
              <li>
                <span className="install-steps__icon">
                  <CandyIcon kind="add-square" size={22} />
                </span>
                <span>
                  Choose <strong>Add to Home Screen</strong>
                </span>
              </li>
              <li>
                <span className="install-steps__icon">
                  <CandyIcon kind="play" size={20} />
                </span>
                <span>
                  Open <strong>Sugar Snap</strong> from your Home Screen
                </span>
              </li>
            </ol>
          )}
        </section>

        <section className="settings__group settings__group--danger" aria-label="Progress">
          {confirmReset ? (
            <div className="reset-confirm" role="alert">
              <p>Erase all stars, levels and boosters? This can’t be undone.</p>
              <div className="modal__actions-row">
                <button type="button" className="btn btn--secondary" onClick={() => setConfirmReset(false)}>
                  Keep progress
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    setConfirmReset(false);
                    onReset();
                  }}
                >
                  Erase
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn--ghost btn--danger-text" onClick={() => setConfirmReset(true)}>
              Reset Progress
            </button>
          )}
        </section>
      </div>
    </ModalShell>
  );
}
