---
name: project-features
description: Features implemented and architectural decisions in PomodoroSync
metadata:
  type: project
---

## Features added (June 2026 session)

- **Real-time clock**: Element `#real-time-clock` above the timer ring; ticks via `startClock()` / `updateClock()` interval, started on `enterApp`, cleared on `handleLeave`.
- **Shuffle mode**: Server-side (`room.shuffle`), toggled via `queue:set-shuffle` socket event. Affects `queue:skip` and `queue:track-ended` auto-advance on the server. Broadcast with every `queue:update` and `queue:playback`. Button `#btn-shuffle` in queue header uses `.queue-action-btn.active` class.
- **Session stats** (first/last pomodoro time): Tracked client-side only (`firstPomodoroTime`, `lastPomodoroTime`), updated on `timer:complete` when study phase ends. Elements `#stat-first-pomodoro`, `#stat-last-pomodoro`.
- **3-beep notification**: `playNotificationSound()` now plays 3 beeps at t=0, 0.42s, 0.84s using Web Audio API.
- **Auto-pause music on timer complete**: `timer:complete` handler emits `queue:pause` if music is playing.
- **Auto-advance track on study end**: `timer:complete` handler emits `queue:skip` when a study Pomodoro completes (new phase = short_break or long_break).
- **Color themes**: 5 presets (oscuro, aurora, bosque, oceano, amanecer) defined in `THEMES` constant. `applyTheme(key)` sets all CSS vars and `PHASE_HUES`. Persisted to `localStorage('pomodoro_theme')`. Theme picker is in the settings modal.
- **Bug fix – track-end detection**: Added `wrappedAround` check in `player_state_changed` (catches Spotify resetting position to 0 after track ends).

**Why:** User feature request + bug report, June 2026.
**How to apply:** The music/timer interaction is intentional: study ends → skip track + pause music. Keep this behaviour when touching timer/music logic.
