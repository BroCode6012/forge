# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a solo YouTube creator producing faceless videos. They work independently and need to move quickly from narration audio to a polished, publishable video.

## Product Purpose

YTA Empire turns narration into a complete faceless YouTube video. It analyzes the script, plans scenes, sources footage, creates motion graphics, assembles transitions and overlays, and provides a timeline editor and render workflow. Success means reducing production time while preserving enough control to produce professional results.

## Positioning

The product combines an agentic, AI-directed build pipeline with a hands-on multi-track editor and local video rendering in one Electron desktop application.

## Operating Context

Users import narration audio, choose production settings, run an automated build, inspect the generated edit in a video preview, adjust clips and graphics on a multi-track timeline, optionally direct changes through the Editor Agent, and render the final video.

## Capabilities and Constraints

- Electron desktop application with a web-based interface.
- Existing build, preview, editing, agent, project, and rendering behavior must remain functional.
- The editor includes three video tracks, voiceover and sound-effect tracks, clip properties, build settings, notifications, and project controls.
- The WebGL2 and HyperFrames preview/render paths must remain available.
- The interface must support dense professional workflows without hiding essential editing state.

## Evidence on Hand

The repository contains the working application, its build pipeline, timeline editor, renderer, project controls, and existing interface assets. No external testimonials, performance claims, customer logos, or other marketing evidence should be fabricated.

## Product Principles

- Shorten the path from narration to a credible first cut.
- Keep automation understandable and controllable.
- Make editing state and progress easy to scan.
- Preserve professional depth without overwhelming a solo creator.
- Prioritize reliable output over decorative complexity.

