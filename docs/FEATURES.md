# Features and technical guide

[Back to the README](../README.md) · [Troubleshooting](TROUBLESHOOTING.md)

Spotify Float combines a local Spotify integration, native process-specific audio capture, interactive typography and a WebGPU ocean renderer. This guide explains what the app does and where its practical limits are.

## Screen modes

| Mode | Foreground | Output canvas |
| --- | --- | --- |
| Single monitor, landscape | Floating lyrics behind the waveform | 3840 × 2160 |
| Single monitor, portrait | The same combined scene, fitted to portrait | 2160 × 3840 |
| Dual monitor, lyrics screen | Interactive floating lyrics | 2160 × 3840 |
| Dual monitor, waveform screen | Live audio waveform and progress | 3840 × 2160 |

These are rendering-buffer dimensions. The result is fitted to the actual display; a lower-resolution monitor does not become a physical 4K monitor.

Combined mode shares one ocean, one native audio stream and one final HDR composition. Glyph and waveform masks are packed into separate GPU channels rather than creating two complete ocean renderers. Dual mode shares the same palette origin and Spotify state across its two windows.

The tray menu and `Single-mode.cmd` / `Dual-mode.cmd` select the layout. With only one display, the app uses combined mode automatically. In dual mode, a portrait display is preferred for lyrics when available.

## Lyrics: real words, clear timing

### Source order

1. Use lyric data supplied by the Spotify client when available.
2. Fall back to LRCLIB lookup using the current track's metadata.
3. Prefer synchronized LRC timestamps over plain lyric text.
4. Estimate line timing from plain text and track duration only when timed data is unavailable.
5. Show a no-lyrics or instrumental state when appropriate.

Fallback search compares normalized title and artist information and checks duration before selecting a candidate. Lookup can still be wrong for unusual versions, covers or duplicate metadata, so a timing/source distinction is kept in the UI. Estimated timing is an approximation, not speech recognition.

Missing lyrics are never generated. The app preserves source wording and does not translate text. A track without lyric data can still use the audio visualization.

### Timing and song changes

- The initial lyric offset is **+300 ms**, so display decisions read slightly ahead of the uncorrected playback position.
- The left/right arrows and sync buttons adjust the offset by **200 ms**.
- A seek refreshes cue selection instead of continuing an old guessed playback position.
- Old floating characters are allowed to drift and fade during a song change while the new lyric set loads.
- The ocean's ambient clock and music-driven light-position clock are persistent; changing a track does not force an instant scene reset.
- Artwork-based palette variation blends into the shared color cycle instead of snapping the entire stage to a new color.

## Typography and interaction

Lines rise into view from below and gradually separate as they float through the scene. Per-character drift, depth scaling, roll, pitch and yaw create the impression of light objects floating in water.

Character placement and hit testing use loaded font metrics. Font readiness is checked before layout; switching to a required fallback invalidates the relevant layout caches.

The mouse can stir a small fluid-velocity field, grab a glyph and release it with momentum. Interaction includes translational inertia, angular motion, nearby glyph contacts and bubble responses. Soft contacts apply between visible glyphs, including during dragging and throwing.

Mouse-driven flow defaults to **0.35 strength**. This keeps the interaction gentle enough for the text and bubbles to remain readable.

Visible glyph opacity changes with screen height and lifetime. The light source uses a separate projected silhouette whose opacity is independent of that visual fade. In the standard lifecycle, its light remains active until the final lifetime fade; a departing track has a short orphan fade rather than leaving permanent ghost light.

## Audio: Spotify only

The native C++ helper initializes COM in the **multithreaded apartment** and uses `ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`. Its include mode targets the Spotify process tree, including audio-rendering child processes.

This is process-specific loopback, not a microphone input or a system-wide desktop mix. If Spotify is not rendering local audio, the capture is silent. Other applications' audio is outside the selected tree. Microsoft's [application-loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) documents this mechanism and its build-20348 minimum.

The helper emits analysis packets through a local pipe. It does not write WAV recordings. The desktop app restarts the helper when capture or the Spotify process needs reconnecting.

### Shape and energy are separate

| Signal | Purpose |
| --- | --- |
| Peak-normalized waveform | Keep actual signal shape visible at a useful display size |
| Raw recent music RMS | Detect real silence and drive music-level-dependent motion |
| Raw low-frequency energy | Drive bass body and kick-onset thickness |
| Spectrum / normalized bands | Support visual response and analysis |

The helper captures stereo **float32 PCM at 44.1 kHz**. A 2048-sample window supplies the actual waveform and FFT. A separate **256-sample raw RMS window**, about **5.8 ms**, detects current sound/silence. Short causal power envelopes use **10 ms** for full-band level and **12 ms** after a **35–180 Hz** bass filter. These time constants describe the analysis filters; they are not guarantees of acoustic latency. Peak normalization is not reused as a fake loudness meter.

Float capture preserves quiet music rather than repeatedly switching it off at a fixed 16-bit loudness threshold. When current audio becomes silent or capture disconnects, the renderer stops sampling new geometry, holds the current shape and reduces its visible height with a short **55 ms exponential release**. Most amplitude is gone after roughly 0.13 seconds; the state is cleared only after it has settled. A Spotify Connect session playing on another device can supply track metadata while producing no local signal to visualize.

## The waveform

Spatial anti-aliasing reduces the 2048 PCM samples to **33 curve knots**. Phase alignment and a critically damped, velocity-bounded geometry filter reduce rapid shape changes. Height and kick accents use a separate fast envelope, so beat response does not wait for the slower shape to catch up. Only smooth curves are rendered; rectangular and hybrid modes are not included.

The current path does not use Hampel/outlier removal to erase real musical peaks. The helper requests a minimum **10 ms** analysis interval; actual packet cadence depends on WASAPI and Windows scheduling. The displayed curve follows the monitor's rendering cadence. Incoming PCM leads slower Spotify playback metadata for waveform activity. Stale packets expire after 100 ms instead of driving an old shape indefinitely.

Raw causal energy in the approximate **35–180 Hz** bass region, together with positive envelope changes and onset detection, drives the core width. Averaging carrier-cycle power prevents a sustained bass note from being treated as repeated new kicks. The white core varies smoothly over roughly **1.5–5 CSS pixels**, depending on bass body and kicks. This affects the line's thickness separately from the overall waveform amplitude.

The progress treatment distinguishes consumed and remaining portions. The curve has tapered ends, and clicking it seeks within the current song. During track changes, progress fades out and back into the new track instead of animating through a long, incorrect seek.

### Readable foreground, positive light

The waveform sits in front of the lyrics in combined mode. Its native white core is kept crisp and receives a positive HDR white lift when HDR is available. It emits a soft, weaker center-radial light field in the same palette as the text.

There is **no negative shadow band, dark cable or ribbon behind the waveform**. Readability comes from its white core and an eased background-ray contribution in waveform/combined mode, rather than dimming a rectangular section of the ocean.

Surface-refraction displacement is removed at the actual waveform silhouette. A silent, flat waveform therefore stays anchored even while the ocean's surface animation continues.

## Ocean, light and color

The shared palette moves through **Blue → Emerald → Sunset**, with an 80-second segment for each phase. Small artwork-derived hue offsets add variation. The same supplied palette colors the water, reflection, absorption, sun highlights and foreground light; the two windows do not run separate color themes.

The surface is evaluated analytically at the final 4K resolution. It includes animated wave height, normals, smaller ripples, Fresnel reflection, refraction and HDR specular highlights. This is a live shader surface, not a rotated background photograph.

Underwater light uses a moving surface-irradiance field, density sampling, Beer–Lambert attenuation and forward-scattering-inspired volume integration. Illumination pools drift, fade and reappear at new positions rather than remaining fixed columns that only change alpha.

### Music-driven position clock

The renderer reads pre-normalization music RMS and converts it to digital **dBFS**. A level range around **−55 to −12 dBFS** maps to the position driver, with approximately **0.4 s attack / 1 s release** for smooth acceleration and deceleration.

This is a digital signal measure, not an acoustic sound-pressure reading and not the Windows volume-slider percentage.

The light-position clock advances only when a track is locally playing, capture is connected and meaningful audio is present. It stops immediately when those conditions end. Water, color and ambient opacity still use the ambient clock. Position-based birth seeds prevent an opacity cycle from teleporting rays while the position clock is frozen.

## Foreground god rays

Projected glyph and waveform silhouettes are drawn into local offscreen canvases at **one-third output resolution**. Their alpha channels are copied to the GPU; ocean brightness, bubbles and the visible text's opacity are not used to guess those silhouettes.

The GPU applies horizontal and vertical Gaussian diffusion before a **96-sample normalized radial integral** around the exact screen center, `(0.5, 0.5)`. Diffusion prevents the radial integration from looking like repeated sharp copies of text.

The glyph mask has tighter diffusion for clearer light boundaries. Waveform emission is softer and weaker. Original foreground images appear only once in the native 4K base; a second sharp text or waveform image is not additively painted over them.

| Current optical setting | Value |
| --- | --- |
| Radial pivot | Exact screen center, `(0.5, 0.5)` |
| Radial integration | 96 normalized samples |
| Glyph diffusion spacing | 1.5 intermediate pixels |
| Wave diffusion spacing | 2.5 intermediate pixels |
| Glyph radial exposure | 1.52 |
| Wave radial exposure | 35% of glyph exposure |
| Negative waveform shadow | Disabled |
| HDR waveform white floor | Approximately 1.55 × reference white, on the actual white stroke |
| Background ray contribution in wave/combined mode | 80%; the ocean base remains unchanged |

The white lift is gated by the real waveform alpha and its native white pixels. It does not redraw a thicker duplicate curve. Values above reference white require the actual extended-range display path; SDR output cannot show that extra luminance.

Combined mode packs glyph/wave masks into R/G channels and integrates both in one foreground-light pass. Wave light stays in front of the behind-wave glyph emission.

## Rendering and HDR

| Component | Resolution / behavior |
| --- | --- |
| Original lyrics and waveform | Native 4K Canvas 2D base |
| Water-surface detail | Final 4K shader evaluation |
| Surface-light cookie | 512 × 512 |
| Volumetric light field | One-third output dimensions, 20 integration steps |
| Foreground alpha masks | One-third output dimensions |
| Final composition | A single opaque WebGPU canvas |

The output uses the actual display cadence through the renderer's animation loop. HDR is enabled only when the browser/display path reports high dynamic range and accepts an extended-range floating-point canvas. The HDR configuration uses `rgba16float`, Display-P3 and extended tone mapping. Unsupported systems use the available SDR path; disabling hardware acceleration can also remove advanced optical effects.

The 4K base is copied into a GPU texture and combined with optical light in the final canvas. A single opaque composition avoids an additional transparent HDR layer over the visible base. Intermediate optical fields use lower resolution while the final output buffer, text and waveform retain 4K dimensions. Each renderer allows at most **two GPU frames in flight**. While the GPU is busy, audio and simulation still advance; old canvas pictures are not queued indefinitely. GPU resources are released when the page is torn down.

Optional timestamp queries measure GPU pass time asynchronously. They are diagnostics, not a promise of the entire application's frame time: presentation, canvas copying, drivers and display composition can cost additional time.

High refresh-rate 4K rendering depends on the hardware and setup. A 120 Hz display provides a target cadence; it does not guarantee that every computer will sustain 120 FPS.

## Fonts and international text

| Text | Public fallback / preferred bundled family |
| --- | --- |
| Korean and basic Latin | Noto Sans CJK KR Black |
| Japanese | M PLUS 1p 800, then Noto Sans CJK JP Black |
| Simplified Chinese | Noto Sans CJK SC Black |
| Traditional Chinese | Noto Sans CJK TC Black |

Selection uses script and language hints at the character level. Rare characters still depend on the glyph coverage of the installed/bundled font.

### Optional OA Gothic ExtraBold

OA Gothic is **not bundled** in the public repository or release archive. Obtain it yourself from [the official OA site](https://font.oa-world.com), follow the publisher's terms, install it in Windows and restart Float. `CSS local()` can select a locally installed OA family, with Noto as the public fallback.

For a personal source build, an unmodified, user-owned OA file may also be kept in a private local assets location supported by that build. Keep it untracked and excluded from public release ZIPs. System installation is the normal end-user route; a local-font file is not needed for the default release.

Noto and M PLUS font files keep their **SIL Open Font License 1.1** notices. The code license does not replace those font licenses.

## Architecture and local data

| Part | Responsibility |
| --- | --- |
| Spicetify extension | Playback-bar button, current track/state and available Spotify lyrics |
| Electron main process | Window modes, local authenticated bridge, settings and helper lifecycle |
| Native WASAPI helper | Spotify process-tree audio and analysis packets |
| Canvas renderer | Typography, wave geometry, fluid particles, mouse interaction and alpha masks |
| WebGPU renderer | Water, volumetric light, diffused foreground rays and final composition |

The local bridge is bound to loopback and authenticated with a per-installation key. The key is generated locally and must never be committed, copied into a public demo or posted in an issue. It is separate from Spotify account credentials.

The packaged release does not require a development toolchain. Changing the native helper requires an x64 C++ compiler and a sufficiently recent Windows SDK. The checked-in npm scripts are `npm run build:native`, `npm test`, `npm run package` and `npm start`; the [README build section](../README.md#build-from-source) gives the complete sequence. Desktop dependencies are pinned in the project's package manifest.

Audio samples and spectrum data stay in the live processing path. Settings and troubleshooting logs are local. LRCLIB lookup uses track metadata over the network; it does not receive the captured audio stream.

## Credits and source references

- [Electron](https://www.electronjs.org/) — desktop shell and Chromium rendering.
- [Spicetify](https://spicetify.app/docs/getting-started) — Spotify client customization and extension integration.
- [LRCLIB](https://lrclib.net/docs) — fallback synchronized/plain lyric lookup.
- [Microsoft process-loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) — process-specific WASAPI capture.
- [WebGPU HDR canvas documentation](https://developer.chrome.com/blog/new-in-webgpu-129) — extended-range tone mapping.
- [WebGPU timestamp documentation](https://developer.chrome.com/blog/new-in-webgpu-121) — optional asynchronous GPU diagnostics.
- [Three.js water example](https://threejs.org/examples/webgpu_water.html) and [volumetric caustics example](https://threejs.org/examples/webgpu_volume_caustics.html) — technique references, not copied scene assets.
- [NVIDIA GPU Gems 3, Chapter 13](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process) — screen-space light scattering and filtering principles.
- [PBRT transmittance](https://pbr-book.org/4ed/Volume_Scattering/Transmittance) and [phase functions](https://pbr-book.org/3ed-2018/Volume_Scattering/Phase_Functions) — volume-light transport references.
- [CSS Color 4 conversion matrices](https://github.com/w3c/csswg-drafts/blob/main/css-color-4/conversions.js) — linear sRGB / Display-P3 conversion.
- [Noto CJK](https://github.com/notofonts/noto-cjk) and [its font license](https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE).
- [M PLUS fonts](https://github.com/coz-m/MPLUS_FONTS) and [M PLUS 1p's OFL notice](https://github.com/google/fonts/blob/main/ofl/mplus1p/OFL.txt).

The playback-bar icon is an image-generated raster asset adapted to the small native control size. Project screenshots use self-written demo phrases and do not redistribute Spotify music or actual song lyrics. PNG previews are SDR captures of an HDR-capable renderer.

## Validation and timing limits

The current build passes five renderer profiles (lyrics, waveform, native waveform, combined landscape and combined portrait), a seven-onset synthetic 120 BPM sequence, and native level/bass envelope checks. Quiet input remains measurable and sustained carrier cycles are suppressed before onset detection.

Synthetic and packet-to-renderer checks do not include the output device's DAC, driver, processing or acoustic delay. A live headphone/speaker synchronization test was deferred. No universal audio-delay compensation is claimed.

## Background startup

The Windows installer registers `Spotify Float Background` for the current interactive user at limited privilege. It launches `SpotifyFloat.exe --background` at sign-in, supports battery operation and retries failures. The visual windows remain closed until requested. `Repair-startup.cmd` updates this task if the installation folder moves. If local policy prevents task registration, manual launch still works and the installer explains how to retry.
