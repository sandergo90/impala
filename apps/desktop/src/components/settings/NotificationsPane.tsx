import { invoke } from "@tauri-apps/api/core";
import { useUIStore } from "../../store";
import { NOTIFICATION_SOUNDS } from "../../hooks/useAgentNotifications";

export function NotificationsPane() {
  const soundMuted = useUIStore((s) => s.notificationSoundMuted);
  const setSoundMuted = useUIStore((s) => s.setNotificationSoundMuted);
  const selectedSoundId = useUIStore((s) => s.selectedSoundId);
  const setSelectedSoundId = useUIStore((s) => s.setSelectedSoundId);

  const handlePreview = (soundId: string) => {
    invoke("play_notification_sound", { soundId }).catch((err) =>
      console.warn("Failed to play sound:", err)
    );
  };

  return (
    <div>
      <h2 className="text-base font-semibold text-foreground">Notifications</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-6">
        Configure how you're notified when an agent finishes its task.
      </p>

      {/* Mute toggle */}
      <div className="flex items-center justify-between max-w-lg">
        <div>
          <div className="text-xs font-medium">Notification sounds</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Play a sound when an agent completes
          </div>
        </div>
        <button
          onClick={() => setSoundMuted(!soundMuted)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            !soundMuted ? "bg-primary" : "bg-muted-foreground/30"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              !soundMuted ? "translate-x-[18px]" : "translate-x-[3px]"
            }`}
          />
        </button>
      </div>

      {/* Sound selection */}
      <div className={`mt-6 max-w-lg ${soundMuted ? "opacity-50 pointer-events-none" : ""}`}>
        <div className="text-xs font-medium mb-3">Notification sound</div>
        <div className="space-y-1">
          {NOTIFICATION_SOUNDS.map((sound) => (
            <div
              key={sound.id}
              className={`flex items-center justify-between px-3 py-2 rounded-md cursor-pointer transition-colors ${
                selectedSoundId === sound.id
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
              onClick={() => setSelectedSoundId(sound.id)}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                    selectedSoundId === sound.id
                      ? "border-primary"
                      : "border-muted-foreground/40"
                  }`}
                >
                  {selectedSoundId === sound.id && (
                    <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                  )}
                </div>
                <span className="text-xs">{sound.name}</span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handlePreview(sound.id);
                }}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-muted/50 transition-colors"
              >
                Preview
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
