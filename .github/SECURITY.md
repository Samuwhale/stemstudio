# Security

StemStudio is a FOSS local desktop app. It is not designed to be exposed on a public network or run as a hosted multi-user service.

## Supported Use

- Run the signed macOS app built from this repository.
- Process audio and URLs only from sources you trust and have permission to use.
- Keep storage paths pointed at folders created for StemStudio.
- Keep macOS, Python, Node.js, npm, and signing/build tooling updated through your normal package manager.

## Known Local Risks

StemStudio executes bundled tools such as `ffmpeg`, `ffprobe`, `yt-dlp`, and `audio-separator` with the same user permissions as the app. A compromised binary, malicious media file, or risky downloader input can affect your machine.

Cleanup actions delete files inside the configured uploads, outputs, exports, and temp folders. The app rejects broad, system, protected, overlapping, and non-empty unclaimed storage paths, and marks managed folders with `.stemstudio-managed`. You should still use dedicated folders instead of pointing StemStudio at unrelated directories.

YouTube import uses bundled `yt-dlp` for local processing of public URLs. You are responsible for following platform terms, copyright law, and any source licenses.

## Reporting Issues

Use a normal GitHub issue for bugs that can be discussed in public. Include:

- the affected version or commit
- your macOS version
- the workflow involved
- expected and actual behavior
- relevant logs with private paths, tokens, cookies, and personal media details removed

Do not include secrets, cookies, private audio, generated stems, or personal library databases in public reports.

If the report requires private details, contact the maintainer through the public contact link in the maintainer's GitHub profile instead of posting the details in an issue.
