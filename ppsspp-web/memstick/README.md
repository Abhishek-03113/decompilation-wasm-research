# Server memory stick

Games for the PPSSPP web page, in the PSP memory stick layout. Only these two folders are sent to players:

- `ISO/`: disc images (`.iso`, `.cso`, `.chd`). They appear on PPSSPP's **Games** tab.
- `PSP/GAME/<name>/EBOOT.PBP`: homebrew. It appears on the **Homebrew & Demos** tab.

Players' browsers download new or changed files when the page opens, and delete files you remove here.
Saves and settings stay in each player's browser. Set `MEMSTICK_DIR` to use another folder.

Everything in this folder except this README is git-ignored. Only put games here that you have the right to share.
