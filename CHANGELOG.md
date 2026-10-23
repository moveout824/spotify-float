# Changelog

## 1.0.1 — 2026-10-24

### Changed

- Drive waveform height and bass accents from short causal audio envelopes, independently of the slower curve geometry.
- Keep the waveform curve smooth with critically damped, phase-aligned geometry and a bounded movement speed.
- Fade the existing shape toward silence instead of clearing it in one frame; stop generating new shape motion while silent.

### Fixed

- Preserve quiet music with float32 Spotify-only capture instead of a fixed 16-bit loudness gate.
- Let current PCM audio lead slower Spotify play/pause metadata when driving the waveform.
- Reject sustained bass carrier cycles as repeated kick onsets.
- Limit each renderer to two GPU frames in flight, avoiding an increasing queue of old pictures under load.
- Register a limited, per-user background startup task so the Float button can find its helper after sign-in.
- Read the release version from package metadata when building the executable.

### Validation

Five renderer regression profiles and native envelope checks pass. A synthetic 120 BPM sequence detects all seven expected kick onsets. These checks do not measure acoustic headphone or speaker latency; a device listening test remains deferred.

The waveform uses smooth curves only. Rectangular and hybrid modes are not included.

## 1.0.0 — 2026-10-10

- Add the Spotify playback-bar button, ocean lyrics, waveform/progress line, single/dual display modes, mouse interaction, optional HDR and multilingual font fallbacks.
