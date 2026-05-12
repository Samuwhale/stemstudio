Solo users and power users use this app to split one song, or a batch of songs, into stems and shape the output mix. Common jobs include making an instrumental, keeping backing vocals, or turning down a specific instrument.

Always write clean code. Do not take shortcuts.

Do not write hacks.

Do not waste time on tests. This project is in active development.

Do not keep backwards-compatible code, dead code, or legacy code around.

Keep the code clean, and focus on the code being easy to use and maintain by LLMs/agents.

This repo only has to run locally. It is a personal tool, so optimize for local development and maintainability rather than production deployment, multi-tenant concerns, or hardened infrastructure.

Reduce ambiguity: users should be able to understand what something is, why it matters, and what will happen next at a glance

Favor simple, legible task flows over flexible but abstract or overloaded interfaces

Never use eyebrow text, overlines, or similar pre-heading label treatments

Be extremely wary of chrome and UI clutter

Remove or avoid any decorative controls, wrappers, labels, or helper surfaces that do not materially improve comprehension or task flow

Prefer fewer visible elements, clearer hierarchy, and more whitespace over dense control-heavy layouts

Do not add informational pills, chips, or badges just to restate nearby content

Only use pills or badges when they carry meaningful status, filtering, or interaction value that would otherwise be unclear

Do not run the app, start the dev server, or open a browser for visual validation unless the user explicitly asks you to. A clean typecheck and build is sufficient by default. Call out untested UX assumptions in writing instead of trying to verify them yourself.

Do NOT:

- Nest cards inside cards
- Add unnecessary wrappers/divs
- Use more than 2 levels of DOM depth per section
- Introduce components without reuse justification
- Add placeholder features or fake data blocks
