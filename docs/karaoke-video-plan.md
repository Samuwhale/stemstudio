# Automatic Karaoke Video Plan

## Decision

Automatic karaoke video generation is feasible, but it must be built as a measured alignment workflow first and a video renderer second.

The first production-quality version should follow this contract:

1. The user provides lyrics.
2. StemStudio creates or reuses a completed run with a usable vocals stem.
3. A local alignment job creates a measurable vocal timing result from either an observed ASR timeline or a lyrics-constrained forced-alignment timeline.
4. A StemStudio-owned matcher aligns the user lyrics to the measured timeline and rejects uncertain spans instead of forcing them.
5. The app shows an editable line-timing result with clear low-confidence warnings.
6. The renderer generates deterministic subtitle artifacts and burns them into an MP4 using the selected mix.

Do not promise perfect unattended timing. The feature should be automatic by default, but the product, data model, and milestones must assume that some lines will need correction.

## Product Scope

The first version is for local karaoke videos from songs already imported into StemStudio. Imports from local files, YouTube, and other `yt-dlp` supported sources should remain part of the normal import flow; karaoke should start from a `Track`, not from a separate downloader. The feature should optimize for reliable line timing, quick correction, and repeatable local rendering.

### In Scope

- user-pasted lyrics
- uploaded `.txt`, `.lrc`, `.srt`, and `.vtt` lyric files
- local ASR and alignment
- vocals-stem-first alignment
- original-mix fallback when vocal-stem alignment coverage is poor
- editable line timings
- deterministic ASS subtitle generation
- MP4 rendering with burned karaoke subtitles
- exported ASS, LRC, alignment JSON, render log, and MP4 artifacts

### Non-Goals

- automatic lyric discovery from the internet
- translation
- pitch-aware alignment models
- training custom singing acoustic models
- cloud storage, accounts, sharing, collaboration, or remote processing
- billing, quota, or multi-tenant hardening
- multi-template video marketplace
- frame-perfect syllable timing
- unattended perfection for every song

## Primary Risks

### Song Alignment Is Not Speech Alignment

The hard problem is not running ASR. The hard problem is aligning user-provided lyrics to sung audio where the lyrics may contain missing ad-libs, repeated choruses, alternate lyric-site wording, section labels, crowd noise, long instrumental gaps, harmonies, and backing vocals.

The alignment backend should create a measured timeline. StemStudio must own the lyric-to-timeline matching, confidence scoring, and rejection logic.

Benchmark two backend classes before choosing a default:

- ASR-observed backends that transcribe the vocal source and then match user lyrics to observed words.
- Lyrics-constrained backends that use the provided lyrics as the transcript and force-align them to the vocal source.

The ASR-observed path is more tolerant of wrong lyrics and ad-libs. The lyrics-constrained path may be more accurate when the provided lyrics are mostly correct. The product must be able to choose between them from measured results, not preference.

### Vocal Stems Help But Can Fail

Vocals stems reduce accompaniment noise, but source separation artifacts can confuse ASR. Dense harmonies, reverb tails, bleed, and distorted vocals can produce missing or hallucinated words.

Use the vocals stem as the default source. If coverage is low, support a second alignment attempt against the original mix and store which source produced the accepted alignment.

Coverage must be defined before implementation. A source attempt is low coverage when any of these are true:

- fewer than 70% of lyric tokens are credibly matched
- fewer than 75% of lyric lines receive `ok` or `review` timing
- three or more consecutive lyric lines are `bad` or `unaligned`
- any repeated section receives a high-confidence match to the wrong occurrence
- lyrics are forced through an instrumental gap longer than 8 seconds

These thresholds are initial safety defaults. Change them only from feasibility data, and keep false-high-confidence avoidance more important than reducing warnings.

### Word Timing Is Secondary

Karaoke users notice bad line timing before they notice imperfect word sweep timing. The first quality bar is line start and end accuracy.

Use word timings when confidence is good. When word-level matches are weak, keep line timing accurate and distribute word sweep timing inside the line as an approximation.

### Rendering Is Deterministic But Environment-Sensitive

ASS subtitles and FFmpeg/libass are the right rendering path, but the local FFmpeg build must support the required filters, fonts, encoders, and escaping rules.

Karaoke should be unavailable until critical diagnostics pass.

## Architecture

Use separate karaoke domain objects. Do not overload `Run`, but do reuse the same operational standards: explicit status, progress, cancellation, attempts, timeouts, temp disk limits, local artifact retention, and diagnostics.

StemStudio is a single-user local app. The karaoke design should assume:

- SQLite is the source of truth.
- Artifacts are local files under the configured data directories.
- Provider model caches live under the configured model cache directory.
- Long-running work happens in the existing local worker process.
- Missing optional providers degrade karaoke availability, not core app availability.
- Old karaoke outputs are cleaned up through local retention and explicit user cleanup actions.

Do not introduce accounts, object storage, remote workers, public URLs, or background services that are not needed for local development.

### Routes

Add a dedicated workspace:

- `/songs`: library and batch actions
- `/mix/:trackId`: stem mixing and audio export
- `/karaoke/:trackId`: lyrics alignment and karaoke video rendering

Use direct task language in the UI:

- entry button: `Create karaoke video`
- page title: `Karaoke video`
- primary action before alignment: `Align lyrics`
- primary action after alignment: `Render video`

Do not put karaoke video controls in the audio export popover.

### Workspace Layout

The karaoke workspace should be a full-page task flow with three plain sections:

1. `Lyrics`
   - paste area
   - upload control
   - line count
   - basic validation

2. `Timing`
   - alignment job status
   - lyric lines with start and end times
   - low-confidence indicators only where they tell the user what to inspect
   - selected-line controls

3. `Video`
   - audio source
   - small style set
   - render action
   - latest rendered artifacts

The correction surface should support:

- nudge selected line earlier or later
- edit line start and end times
- drag line boundaries on a simple timeline
- split a line
- merge adjacent lines
- mark a line or span as instrumental
- re-run alignment after lyric edits
- render again without re-running alignment

Do not build a full subtitle editor for the first version.

### Entry Points

Primary entry should be from the library.

Library behavior:

- For tracks with a completed run that includes or can create vocals, expose `Create karaoke video`.
- For tracks without stems, route through a focused `Create vocals first` state in the karaoke workspace.
- Show karaoke status in the library only for active jobs, failed jobs, or an existing karaoke project action.
- Do not add decorative status badges to every row.

Mixer behavior:

- Do not add a primary karaoke button to the mixer header.
- A secondary `Create karaoke video` action may live in the song overflow menu.
- Keep the export popover audio-focused.

Batch behavior:

- Add batch karaoke only after the single-song flow is proven.
- Batch karaoke must require lyrics per song.

## Alignment Backends

Do not hard-code the product around one alignment backend before measurement. Build a small provider interface and benchmark candidate providers during the feasibility gate.

Provider dependencies should be isolated from the core app runtime. Whisper, WhisperX, Stable-ts, torch, torchaudio, faster-whisper, pyannote, and alignment-model dependencies can have conflicting release constraints. Each candidate provider should run through a subprocess adapter with pinned package versions, captured command settings, and captured dependency versions. Do not import heavy provider libraries in FastAPI startup or shared service modules.

### Provider Runtime Strategy

Each provider should have an isolated runtime definition before it is exposed in the product:

- pinned package versions
- install command or setup script
- resolved executable path
- model cache location
- first-run model download behavior
- device selection: `auto`, `cpu`, `mps`, or `cuda`
- compute type selection where supported
- expected disk footprint
- expected memory range
- availability diagnostics
- a small smoke command using a short local audio fixture

Prefer CLI or subprocess integration over importing provider packages into shared backend modules. A provider adapter may use a Python API behind the subprocess boundary when the CLI is unstable or too lossy, but that Python process should still be isolated from FastAPI startup and the stem separation worker imports.

Karaoke should remain usable as a manual timing and rendering tool even when no automatic alignment provider is installed.

### Provider Interface

Each provider should return the same observed timeline schema:

- provider name
- provider version
- provider class: `asr-observed` or `lyrics-constrained`
- model name
- language
- device
- compute type
- command or API settings
- source artifact id
- source checksum
- segments
- words
- word confidence when available
- line or segment confidence when available
- alignment failures and unaligned spans
- warnings
- raw output artifact path
- runtime metrics

### Initial Providers

Benchmark these candidates:

1. `whisperx`
   - strong candidate for word-level timestamps through forced alignment
   - supports CPU mode
   - can leave words unaligned when dictionary or alignment support is weak
   - can struggle with overlapping vocals
   - benchmark both ASR-observed mode and lyrics-constrained alignment when rough lyric segment windows are available

2. `stable-ts`
   - useful fallback candidate for Whisper timestamp refinement
   - simpler deployment profile than a full forced-alignment suite
   - should be measured for singing and separated vocals before product commitment

3. `openai-whisper` baseline
   - useful as a future provider candidate if the karaoke work needs a smaller baseline
   - useful as a minimum baseline and fallback for transcription-only coverage
   - should not be accepted as the default unless line timing passes without word-level forced alignment

4. `mfa`
   - benchmark as a later but explicit candidate for high-accuracy English lyrics-constrained alignment
   - valuable when the provided lyrics are mostly correct and suitable pronunciation resources exist
   - operationally heavier than the Whisper-family candidates, so it should not block the first bake-off unless the initial providers fail

Reject aeneas for this app because it is narration-oriented, old, and not a strong fit for sung pop vocals with repeated sections, ad-libs, and long instrumental gaps.

### Backend Selection Rule

After Milestone 0, choose the default backend from measured results. The chosen default must satisfy the pass/fail gates in this plan on the feasibility corpus.

Choose a strategy, not just a binary. The default can be conditional, such as vocals-stem WhisperX first, original-mix fallback, then manual review. It can also choose lyrics-constrained alignment when imported LRC/SRT/VTT timing hints or high lyric confidence make that path stronger.

If no backend strategy passes, do not build MP4 rendering yet. Continue improving alignment or reduce scope to a manual line-timing tool.

## Lyrics Parsing

Preserve display text exactly enough to render what the user expects. Normalize only for matching.

### Accepted Inputs

- pasted plain text
- `.txt`
- `.lrc`
- `.srt`
- `.vtt`

### Parsed Line Schema

Each parsed line should include:

- stable line id
- original text
- display text
- normalized tokens
- token-to-character spans
- source line number
- optional imported start and end hints
- line kind: lyric, section, instrumental, blank

### Normalization

Normalize for matching only:

- lowercase
- Unicode normalization
- normalize quotes, apostrophes, and dashes
- strip punctuation that does not change word identity
- classify bracketed section labels such as `[Chorus]`
- collapse repeated whitespace
- expand common contractions where useful
- preserve repeated lyrics as repeated lines

Never display normalized text.

## Alignment Algorithm

Use a staged matcher instead of a single global dynamic-programming pass.

### Inputs

- parsed lyric lines
- observed ASR segments
- observed ASR words with timings
- lyrics-constrained provider segments or words when available
- optional ASR word confidence
- optional imported lyric timing hints
- track duration
- source kind: vocals stem or original mix

### Stage 1: Token Preparation

Create two token streams:

- lyric tokens from parsed user lyrics
- observed tokens from ASR output

Each token should keep:

- normalized text
- original text
- line id when lyric token
- start and end when observed token
- provider confidence when available
- token index

### Stage 2: Anchor Discovery

Find high-confidence anchors before full alignment:

- exact multi-word phrase matches
- uncommon word matches
- timestamped lyric hints from LRC/SRT/VTT
- section continuity after long gaps
- local runs of low edit distance

Reject anchors that are ambiguous across repeated choruses unless nearby context disambiguates them.

When imported timing hints exist, use them as soft anchors, not truth. Bad LRC/SRT/VTT files must not be able to force high-confidence line timings by themselves.

### Stage 3: Windowed Alignment

Align between anchors with banded dynamic programming.

Scoring should account for:

- exact word match
- fuzzy word match
- missing lyric word
- extra ASR word
- contractions
- repeated words
- long unmatched lyric runs
- long unmatched ASR runs
- timing gaps from neighboring anchors
- line continuity

Do not deduplicate repeated lyrics. Align repeated choruses as repeated spans.

### Stage 4: Gap And Instrumental Handling

Explicitly detect:

- long instrumental intro
- long instrumental bridge
- outro after final lyric
- spoken/ad-lib ASR words not present in lyrics
- lyric lines with no credible observed match

Unmatched instrumental spans should become timing gaps, not forced lyric matches.

### Stage 5: Line Timing

For each lyric line:

- start at the first credible matched token
- end at the last credible matched token
- lightly pad start and end
- interpolate internal unmatched words only inside credible boundaries
- inherit timing from neighboring lines only when local context is strong
- leave the line unaligned when confidence is too low

Do not infer a line boundary across an instrumental or unmatched span longer than 8 seconds unless the surrounding anchors and imported timing hints agree.

### Stage 6: Confidence

Confidence must be calibrated from measurable signals, not just a vague score.

Line confidence should include:

- matched token ratio
- average edit cost
- longest unmatched token run
- anchor distance
- repeated-section ambiguity
- ASR confidence when available
- timing gap consistency
- source kind
- backend provider

Store both machine-readable confidence details and a simple UI severity:

- `ok`
- `review`
- `bad`
- `unaligned`

False-high-confidence lines are more damaging than low-confidence warnings. Tune thresholds to prefer warning the user when uncertain.

For measurement, a false-high-confidence line is any line marked `ok` whose start error exceeds 750 ms, whose end error exceeds 1000 ms, or whose matched occurrence is the wrong repeated section. A catastrophic alignment is any alignment that shifts a section to the wrong repeat, forces lyrics through a long instrumental span, or marks more than five consecutive visibly wrong lines as `ok` or `review`.

## Data Model

Add karaoke-specific tables, but keep them shaped for a single-user local SQLite app. Do not add user, tenant, object-storage, public URL, or remote-worker fields.

### `karaoke_projects`

Fields:

- `id`
- `track_id`
- `run_id`
- `status`
- `progress`
- `status_message`
- `error_message`
- `lyrics_raw`
- `lyrics_normalized_hash`
- `language`
- `alignment_source_kind`
- `alignment_source_artifact_id`
- `alignment_source_checksum_sha256`
- `active_alignment_revision_id`
- `render_settings_json`
- `created_at`
- `updated_at`

### `karaoke_alignment_revisions`

Fields:

- `id`
- `project_id`
- `revision_number`
- `source_kind`
- `source_artifact_id`
- `source_checksum_sha256`
- `provider`
- `provider_version`
- `model_name`
- `language`
- `device`
- `compute_type`
- `lyrics_hash`
- `parsed_lyrics_json`
- `normalized_tokens_json`
- `asr_timeline_json`
- `alignment_json`
- `confidence_json`
- `manual_edits_json`
- `metrics_json`
- `created_at`

### `karaoke_jobs`

Use a dedicated jobs table unless the codebase first introduces a generic local job table. Reuse shared status, progress, retry, cancellation, timeout, and crash-recovery helper code from the existing run worker path instead of reimplementing subtly different queue semantics.

Fields:

- `id`
- `project_id`
- `kind`: `align` or `render`
- `status`
- `progress`
- `status_message`
- `error_message`
- `heartbeat_at`
- `attempt_count`
- `max_attempts`
- `cancellation_requested`
- `input_json`
- `result_json`
- `created_at`
- `updated_at`

If StemStudio later needs multiple worker processes, add claim and lease fields through a generic local job abstraction instead of baking distributed-worker assumptions into karaoke first.

### `karaoke_artifacts`

Fields:

- `id`
- `project_id`
- `alignment_revision_id`
- `job_id`
- `kind`
- `label`
- `format`
- `path`
- `size_bytes`
- `checksum_sha256`
- `created_at`

Artifact kinds:

- `asr-raw-json`
- `alignment-json`
- `lyrics-ass`
- `lyrics-lrc`
- `video-mp4`
- `render-log`

## Backend Modules

Add these modules:

- `backend/adapters/alignment.py`
- `backend/adapters/whisperx.py`
- `backend/adapters/stable_ts.py`
- `backend/adapters/mfa.py`
- `backend/services/lyrics.py`
- `backend/services/lyric_alignment.py`
- `backend/services/karaoke_projects.py`
- `backend/services/karaoke_jobs.py`
- `backend/services/karaoke_rendering.py`
- `backend/workers/karaoke_processor.py`
- `backend/api/routes/karaoke.py`
- `backend/schemas/karaoke.py`

### `backend/adapters/alignment.py`

Responsibilities:

- define the provider interface
- define observed timeline schema
- define lyrics-constrained timeline schema
- normalize provider warnings
- record runtime metrics
- serialize provider dependency and command metadata

### `backend/adapters/whisperx.py`

Responsibilities:

- resolve WhisperX runtime
- run transcription and alignment
- normalize output to observed timeline JSON
- enforce timeouts
- record model, device, compute type, language, and settings
- preserve raw output as an artifact
- support ASR-observed mode
- support lyrics-constrained alignment mode when rough segment windows are available

Prefer CLI integration first if it is stable in the local environment. If the CLI output is unstable or too lossy, use the Python API behind the same provider interface.

### `backend/adapters/stable_ts.py`

Responsibilities:

- run Stable-ts as a candidate provider
- normalize output to observed timeline JSON
- preserve raw output as an artifact
- expose provider warnings and confidence signals where available

### `backend/adapters/mfa.py`

Responsibilities:

- run Montreal Forced Aligner as a candidate lyrics-constrained provider when installed
- normalize aligned intervals to the common timeline JSON
- record dictionary, acoustic model, language, and command settings
- preserve TextGrid or raw output artifacts
- report setup failures as provider diagnostics, not app startup failures

### `backend/services/lyrics.py`

Responsibilities:

- parse accepted lyric formats
- classify section labels and blank lines
- preserve original display text
- normalize tokens for matching
- map normalized tokens back to display line spans

### `backend/services/lyric_alignment.py`

Responsibilities:

- run anchor discovery
- run windowed alignment
- resolve repeated-section ambiguity
- compute word timings
- compute line timings
- detect gaps and instrumental spans
- compute confidence details
- produce alignment revisions

### `backend/services/karaoke_jobs.py`

Responsibilities:

- create align and render jobs
- pick the next local job to process
- recover jobs that were active when the worker stopped
- handle attempts and terminal states
- handle cancellation
- expose active karaoke queue entries

### `backend/services/karaoke_rendering.py`

Responsibilities:

- generate ASS subtitle files
- generate LRC files
- render background video
- resolve selected mix audio
- burn subtitles with FFmpeg
- collect render logs
- return artifacts

## Worker Behavior

Karaoke jobs should be processed separately from stem `Run` rows unless a generic local job system is introduced first.

Provider execution must happen inside the worker, never in API request handlers or module import time. A missing optional provider should mark that provider unavailable in karaoke diagnostics, not make the app unavailable.

Stages for alignment jobs:

- `queued`
- `preparing`
- `transcribing`
- `matching`
- `scoring`
- `completed`
- `failed`
- `cancelled`

Stages for render jobs:

- `queued`
- `preparing`
- `rendering-subtitles`
- `rendering-background`
- `rendering-video`
- `completed`
- `failed`
- `cancelled`

Worker requirements:

- explicit progress
- cancellable between stages
- command timeouts
- temp disk limit checks
- memory limit checks where supported
- heartbeat updates
- attempt limits
- render log capture
- artifact cleanup through retention policy
- recovery of jobs that were active when the local worker stopped

## Audio Source Rules

Import source:

1. Reuse the existing StemStudio import flow for local files, YouTube URLs, playlists, and other `yt-dlp` supported URLs.
2. Store karaoke projects against confirmed `Track` rows, not import drafts.
3. Preserve source metadata already captured during import, including title, artist, thumbnail URL, source URL, and duration.
4. Treat URL import support as best effort because extractors change over time; failures should stay in the import flow and not complicate karaoke project state.

Alignment source:

1. Prefer a vocals stem from the selected completed run.
2. If no vocals stem exists, queue or guide the user through creating vocals first.
3. If vocals-stem alignment fails the coverage threshold, offer or automatically run original-mix fallback.
4. Store the accepted source kind and artifact id.

Render audio:

1. Default to the user's saved mix when the selected run has a custom mix.
2. Otherwise default to an instrumental-style mix when available.
3. Let the user choose another available mix source before rendering.

The selected render audio should be snapshotted by artifact id and mix signature so later mix changes do not silently alter old renders.

## Rendering

Use Advanced SubStation Alpha subtitles and FFmpeg/libass.

### Default Output

- MP4
- H.264 video
- AAC audio
- 1920x1080
- 30 fps
- selected StemStudio mix as audio

### Default Visual Behavior

- dark solid background for v1
- two visible lyric lines
- current line highlighted
- next line secondary
- line-level highlight when word timings are interpolated
- word-sweep approximation when word timings are credible

Keep style options small:

- background color
- text color
- highlight color
- font size preset
- alignment: lower third or center

Add blurred thumbnail or user-selected image only after the default renderer is stable.

### ASS Requirements

The ASS generator must handle:

- centisecond karaoke tag durations
- deterministic event ordering
- explicit script resolution
- `original_size` handling for FFmpeg subtitle scaling
- escaping ASS override-sensitive characters
- line wrapping
- long lines
- Unicode text
- font selection
- optional `fontsdir`
- path escaping for FFmpeg filter arguments

Word sweep should be described internally as an approximation. Do not imply syllable-accurate timing.

### FFmpeg Requirements

Diagnostics must verify:

- `ffmpeg` is available
- `ffprobe` is available
- `subtitles` or `ass` filter support is available
- libass support is available
- H.264 encoder is available
- AAC encoder is available
- a one-frame dry-run subtitle burn succeeds
- output directory and temp directory have enough free space
- native ASS dry-run succeeds with `\kf` karaoke tags, braces, long text, Unicode text, and selected font settings
- the chosen filter path is explicit: prefer `ass` for generated ASS files, use `subtitles` only when needed

## API Shape

Suggested endpoints:

- `POST /api/tracks/{track_id}/karaoke-projects`
- `GET /api/karaoke-projects/{project_id}`
- `PATCH /api/karaoke-projects/{project_id}/lyrics`
- `POST /api/karaoke-projects/{project_id}/align`
- `GET /api/karaoke-projects/{project_id}/alignment-revisions`
- `PUT /api/karaoke-projects/{project_id}/alignment-revisions/{revision_id}`
- `POST /api/karaoke-projects/{project_id}/render`
- `GET /api/karaoke-projects/{project_id}/jobs`
- `POST /api/karaoke-jobs/{job_id}/cancel`
- `GET /api/karaoke-projects/{project_id}/artifacts/{artifact_id}`

Do not run ASR, alignment, or video rendering inside a web request.

## Library Queue

Karaoke jobs should appear in the existing queue area or a visually matching queue row.

Labels:

- `Aligning lyrics`
- `Rendering karaoke video`
- `Karaoke video failed`

Completed karaoke videos should not create persistent clutter in normal song rows. Use a row action such as `Open karaoke video` when a project exists.

## Feasibility Gate

Complete this before building the full correction UI or MP4 renderer.

### Corpus

Use at least 12 local songs for the first gate, with expansion before tuning confidence thresholds:

- clean vocal pop
- dense rock mix
- rap or fast vocal
- duet
- backing-vocal-heavy song
- long instrumental intro
- long instrumental bridge
- repeated chorus-heavy song
- non-English song
- live recording
- short simple song
- separation-artifact-heavy song

Each song needs manually reviewed reference line timings. Timestamped lyric files can seed the reference, but a human pass must confirm them.

Add negative-control lyric sets before accepting a default strategy:

- lyrics with one omitted repeated chorus
- lyrics with a chorus represented as `[Repeat chorus]`
- lyric-site wording differences from the actual vocal
- wrong lyrics for the song
- extra ad-lib lines not present in the vocal
- missing ad-libs that are present in the vocal
- non-English lyrics when the provider lacks a matching alignment model

Negative controls should not be required to produce a good alignment. They should prove that confidence and fallback logic avoid false certainty.

### Measurements

Record per backend and per source kind:

- alignment runtime
- runtime per audio minute
- peak temp disk
- peak memory
- ASR token count
- lyric token count
- matched token percentage
- matched line percentage
- low-confidence line percentage
- unaligned line percentage
- false-high-confidence line count
- median absolute line start error
- median absolute line end error
- P90 line start error
- P90 line end error
- manual correction count
- fallback source usage
- provider dependency versions
- provider failure reason when unavailable or crashed
- wrong-repeat count
- forced-instrumental count
- category-level pass/fail result

### Pass/Fail Gates

A backend/source strategy passes only if it meets these gates across the corpus:

- at least 85% of lyric lines aligned within 750 ms start error
- at least 85% of lyric lines aligned within 1000 ms end error
- P90 start error under 1500 ms
- P90 end error under 1800 ms
- false-high-confidence rate under 5% of lines
- no catastrophic repeated-chorus displacement on the repeated chorus song
- no forced lyrics through long instrumental spans
- median runtime under 2.5x song duration on the intended local machine
- peak temp disk documented and acceptable for the configured local temp limit
- manual correction count acceptable for personal use
- every negative-control case either receives low-confidence warnings or fails cleanly without high-confidence bad timing

Category gates must pass independently for clean vocal pop, dense mixes, repeated-section songs, long instrumental songs, and non-English songs. Do not let strong clean-vocal results hide a repeated-chorus or instrumental failure.

If these gates are too strict after real measurement, adjust them explicitly before implementing video rendering. Do not silently lower the product bar.

## Milestones

### Milestone 0: Alignment Bake-Off

Deliver:

- provider interface
- WhisperX provider
- Stable-ts provider
- Whisper baseline provider
- optional MFA provider or a documented decision to defer it after measuring the first three providers
- isolated provider runtime setup with pinned versions
- local benchmark command
- reference timing format
- feasibility corpus report
- negative-control report
- default backend decision from measured results
- explicit fallback and confidence thresholds

Exit only when one strategy passes the feasibility gate.

### Milestone 1: Karaoke Project And Job Model

Deliver:

- karaoke project table
- alignment revision table
- karaoke job table
- karaoke artifact table
- job heartbeat, retry, cancellation, and stopped-worker recovery behavior
- active karaoke queue API
- diagnostics shape for karaoke availability

### Milestone 2: Alignment JSON And Review Harness

Deliver:

- lyrics parser
- source resolver for vocals stem and original mix fallback
- selected backend adapter
- lyric-to-ASR matcher
- stored alignment revision
- confidence scoring
- API to fetch alignment results
- minimal timing review surface or local inspection harness

No MP4 rendering yet.

### Milestone 3: Correction UI

Deliver:

- lyrics paste/upload flow
- line timing list
- confidence display
- selected-line nudge controls
- editable start/end times
- split line
- merge adjacent lines
- mark instrumental
- save manual edits as a new alignment revision

### Milestone 4: Subtitle Artifacts

Deliver:

- deterministic ASS generator
- LRC generator
- ASS escaping
- font and resolution settings
- subtitle diagnostics
- exported ASS and LRC

### Milestone 5: MP4 Rendering

Deliver:

- background video renderer
- mix audio resolver
- FFmpeg/libass burn-in renderer
- render log artifact
- exported MP4
- render-again flow without re-alignment

### Milestone 6: Product Polish

Deliver:

- saved render settings
- better repeated-section handling from real failures
- user image background
- batch karaoke queue

## References

- [WhisperX GitHub](https://github.com/m-bain/whisperX)
- [WhisperX paper](https://arxiv.org/abs/2303.00747)
- [OpenAI Whisper GitHub](https://github.com/openai/whisper)
- [Stable-ts GitHub](https://github.com/jianfch/stable-ts)
- [Montreal Forced Aligner docs](https://montreal-forced-aligner.readthedocs.io/en/latest/user_guide/workflows/alignment.html)
- [Exploiting Music Source Separation for Automatic Lyrics Transcription with Whisper](https://arxiv.org/abs/2506.15514)
- [Nightingale karaoke pipeline notes](https://nightingale.cafe/docs/how-it-works)
- [yt-dlp supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
- [aeneas](https://www.readbeyond.it/aeneas/)
- [Aegisub ASS karaoke tags](https://aeg-dev.github.io/AegiSite/docs/3.2/ass_tags/)
- [FFmpeg subtitles filter](https://ffmpeg.org/ffmpeg-filters.html#subtitles-1)
