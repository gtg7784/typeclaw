---
name: glm-vision
description: 'Use GLM Coding Plan vision tools for image, video, screenshot, OCR, UI-to-code, diagram, chart, and UI diff analysis. Load when asked to inspect visual media while running a GLM Coding Plan agent.'
---

# GLM vision

This agent's base GLM model is text-only: it cannot see images or videos directly.
For visual inputs, call the `glm-vision__*` MCP tools with `mcp_call`.

Use local file paths or URLs as inputs. If the user pasted or attached media, place
it on disk first, then pass that path.

Common tools:

- `glm-vision__analyze_image` — general image understanding.
- `glm-vision__extract_text_from_screenshot` — OCR from screenshots/images.
- `glm-vision__ui_to_artifact` — convert UI screenshots into code/artifacts.
- `glm-vision__diagnose_error_screenshot` — inspect error screenshots.
- `glm-vision__understand_technical_diagram` — explain diagrams and architecture.
- `glm-vision__analyze_data_visualization` — read charts and plots.
- `glm-vision__ui_diff_check` — compare UI screenshots.
- `glm-vision__analyze_video` — analyze video files or URLs.

These calls draw from the GLM Coding Plan vision quota.
