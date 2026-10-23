# Troubleshooting

[Back to the README](../README.md) · [Feature and technical guide](FEATURES.md)

Start with the section that matches what you see. You usually do not need to change Spotify account settings or edit an installation key.

## The Float button is missing

1. Make sure you are using the **desktop Spotify client** and the release ZIP has been fully extracted.
2. Run **`Repair-button.cmd`** from the extracted release folder.
3. Follow its Spotify restart instructions, then check beside the **Repeat** button in the playback bar.
4. If it still does not appear, check that Spicetify can find and apply changes to this Spotify installation. The [official Spicetify setup guide](https://spicetify.app/docs/getting-started) covers unusual install locations.

Spotify updates can replace customized client files. Reapplying the button after an update is expected maintenance, not a reason to delete your whole Spotify profile.

## Clicking the button does nothing

Try `Single-mode.cmd` directly. If a stage opens, the desktop app is working and the button/bridge integration needs repair; run `Repair-button.cmd`.

If no stage opens, re-extract the complete release. Keep the application, its resources and native helper together. Copying only the main executable to another folder can leave required resources behind.

Also check the tray area for **Spotify Float**. Close the stage or quit the helper from its tray menu before trying a fresh launch. An installation may keep its helper ready in the background at Windows sign-in; the tray makes that state visible.

## The waveform is flat

Check these in order:

1. Is a song actually playing **on this computer**, rather than a Spotify Connect speaker, phone or another PC?
2. Is Spotify paused, muted, disconnected, or in a genuinely silent part of the track?
3. Press `H` and use **Reconnect Spotify audio**, if the control is available.
4. Reopen Spotify, then reopen Float if the process restarted while the helper was reconnecting.
5. Confirm that you are on **Windows 11 x64**.

The app intentionally captures Spotify's process tree. Playing a test sound in a browser or another media player should not make the Spotify waveform move.

The native API requires Windows build 20348 or later; ordinary consumer Windows 10 installations are not supported by this capture path. [Microsoft's application-loopback documentation](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) explains both the process restriction and the silence behavior when the target is not rendering audio.

If a native capture error is shown, include its **HRESULT code** in a bug report. Do not substitute a system-wide loopback recorder to claim that Spotify-only capture is working.

## Music is quiet, but the waveform is still readable

That is expected. The displayed waveform is peak-normalized so a quiet recording can still have a useful shape. Raw recent RMS is retained separately for real-silence detection and music-driven movement.

Windows speaker volume is not the motion-speed control. Motion uses the captured digital music level, measured before the waveform's display normalization. See [shape versus energy](FEATURES.md#shape-and-energy-are-separate).

## The waveform moves after a pause or silent section

The current native path checks a recent 256-sample raw RMS window. On silence it freezes shape updates and briefly reduces amplitude, then clears settled wave/beat state. A short settling fade is expected; continued oscillation is not. Its core also stays outside moving surface-refraction displacement.

If motion continues, first make sure no local Spotify audio is still playing and that the installed app and native helper came from the **same release**. An older helper with a newer app can provide a different packet layout or silence behavior. Re-extract and reinstall a matched release, then reconnect audio.

Small bubbles or water highlights may continue moving. Their ambient animation is separate from the music waveform and the background ray-position clock.

## There are no lyrics, or timing is approximate

Spotify and LRCLIB do not have synchronized lyrics for every track, version or region. Instrumental tracks may have no lyric lines at all.

- Wait briefly after changing tracks; lookup and font preparation can take a moment.
- Check your network connection if LRCLIB fallback is needed.
- An **estimated** source uses plain text and duration, so instrumental gaps and unusual song structure can drift.
- A remix, live recording or alternate version can have matching title/artist text but different timing.

The app keeps the ocean and waveform available instead of inventing missing lyrics.

### Adjust lyric timing

The starting correction is **+300 ms**. Press `→` to show lines a little earlier, or `←` to show them a little later, in **200 ms** steps. You can also press `H` and use the sync buttons.

A global correction can fix a consistent delay. It cannot repair a plain-text timing estimate that drifts differently throughout a song.

## Characters appear as boxes or use an unexpected font

Use the complete release ZIP so the bundled fonts are present. Restart Float and allow its font-loading step to finish before judging the layout.

The public default is Noto Sans CJK KR Black for Korean/basic Latin. Japanese text uses M PLUS 1p 800 plus Noto JP fallback; Chinese text uses the SC/TC Black families. Rare characters can still require a fallback with additional coverage.

### I want OA Gothic ExtraBold

1. Get your own font copy from [the official OA font site](https://font.oa-world.com).
2. Follow the publisher's terms and install the font in Windows.
3. Restart Float so its `CSS local()` font selection can see the installed family.

OA files are **not included** in the public repository or release ZIP. If the local family is not found, the app uses Noto. Do not download an unverified replacement font or post your font file in an issue; a font name and a screenshot with demo text are sufficient for a report.

## HDR looks like SDR

Check **Settings → System → Display → HDR** for the actual monitor you are using. HDR must be supported by the display/connection and enabled in Windows. Microsoft's [HDR settings guide](https://support.microsoft.com/en-us/windows/hardware/display-graphics/hdr-settings-in-windows) covers that setup.

Also check that hardware acceleration and a current GPU driver are available. A supported floating-point WebGPU canvas is needed for the full extended-range path. Float can fall back to SDR rather than pretending that a normal glow is real HDR.

GitHub's PNG screenshots are **SDR captures**. Their brightness is not a reliable test of the actual HDR highlights on your display.

## Frame rate is lower than the monitor's refresh rate

4K rendering is a GPU workload even when the physical monitor has fewer pixels. High refresh rates also depend on driver behavior, display composition and monitor connections.

Try a current driver, confirm that Windows is using the intended GPU for Float, close another heavy GPU workload, or use one-monitor mode. On hybrid-GPU laptops, choosing a high-performance GPU for Float in [Windows graphics settings](https://support.microsoft.com/en-us/windows/hardware/display-graphics/optimizations-for-windowed-games-in-windows-11) can help, depending on the display wiring.

Do not judge the whole frame from the GPU shader time alone. A fast shader can still wait on canvas copying or presentation. Report the visible frame rate along with GPU information, monitor resolution/refresh rate, HDR status and single/dual mode.

The app aims to follow the display cadence; **120 FPS is not guaranteed on every system**.

## The wrong monitor opens

Use the tray menu or the matching mode script first. A one-display system always uses the combined layout. Dual mode prefers a portrait monitor for lyrics and another monitor for the waveform.

If Windows reports your monitors in an unexpected arrangement, check **Settings → System → Display** and arrange them as they physically sit. After changing the display layout, close and reopen the stage so the current monitor bounds are used.

## The waveform covers a letter, or a drag seeks the song

In combined mode, the waveform is intentionally the **front layer**. Clicking its line seeks playback, even when a floating letter is behind it.

Grab the letter a little away from the waveform line. Releasing a dragged letter gives it momentum and can activate contacts with nearby characters.

## A local bridge reports “Unauthorized”

The bridge uses a **private key generated for each installation**. It does not require you to type a Spotify password or obtain a public API key.

Reinstall or repair from one matching release so the installed extension and helper use the same local configuration. Do not copy someone else's generated bridge settings and do not paste the key into a browser, README or GitHub issue.

If another copy of Float is still running from a different folder, quit it from the tray first. A single matched installation is easier to diagnose than two helpers competing for the local bridge.

## What to include in a bug report

Please include:

- Release/app version and the Windows build number.
- GPU model and driver version.
- Monitor resolution, refresh rate, layout and HDR on/off state.
- Single or dual mode, and whether audio is local Spotify playback.
- Whether the lyric source is synchronized, estimated, loading or unavailable.
- The short error message or native HRESULT, if one is shown.
- A minimal description of what you clicked and what happened.

For screenshots, use your own demo phrases when possible. Remove private installation keys, user-specific paths and unnecessary personal metadata from logs. **Do not attach PCM recordings, Spotify credentials, complete private profiles or actual song-lyric captures.**

[Open an issue](https://github.com/moveout824/spotify-float/issues)

## The button is visible but no visual window opens after sign-in

The Spotify extension and background helper are separate. Use `Single-mode.cmd` or `Dual-mode.cmd` from the extracted release folder to start the helper, then try the button again. Run `Repair-startup.cmd` to register the current folder's background task. In Task Scheduler, `Spotify Float Background` should point to this folder's `app/SpotifyFloat.exe --background` and run for your current interactive user. Do not request administrator privileges unless your own Windows policy requires them.

Before upgrading, quit the old helper through its tray menu. Esc closes only its visible windows. Keep the new app, native helper and extension from the same release together, and rerun `install.cmd` so their local bridge key matches.

## Waveform timing or ghosted movement

Version 1.0.1 separates rapid music/kick envelopes from gentler curve geometry and limits GPU queue depth. Keep Spotify playing locally and the Float window open while judging timing. A closed/minimized window or remote Spotify Connect playback cannot provide a useful live synchronization check.

Compare after extracting a complete matched release. Heavy GPU work in another application can still reduce rendering cadence. Headphones, USB interfaces, Bluetooth and driver processing add different output delays; synthetic tests are not an acoustic calibration of that path. No fixed device compensation is applied automatically.
